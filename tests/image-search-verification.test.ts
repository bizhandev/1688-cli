import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, IMAGE_SEARCH_UPLOAD_URL, imageSearchResultUrl } from '../src/commands/image-search.js';
import { clickImageSearchButton, selectImageFile } from '../src/session/image-search-locators.js';
import { SEARCH_APP_ID, SEARCH_MTOP_API } from '../src/session/search-mtop.js';

vi.mock('../src/session/image-search-locators.js', () => ({
  selectImageFile: vi.fn(), clickImageSearchButton: vi.fn(),
}));
vi.mock('../src/session/recovery.js', () => ({
  withRecovery: (_ctx: unknown, _meta: unknown, run: () => Promise<unknown>) => run(),
}));

const fixture = new URL('./fixtures/search/mtop-offers.jsonp', import.meta.url);
const offersBody = readFileSync(fixture, 'utf8');
const resultsUrl = imageSearchResultUrl('1234');
const searchQuery = new URLSearchParams({
  data: JSON.stringify({ appId: SEARCH_APP_ID, params: JSON.stringify({ method: 'imageOfferSearchService' }) }),
});

class SearchTab extends EventEmitter {
  href = 'about:blank';
  challenge = false;
  closed = false;
  empty = false;
  onNavigate: (url: string) => void = () => {};
  goto = vi.fn(async (url: string) => { this.href = url; this.onNavigate(url); });
  url = () => this.href;
  isClosed = () => this.closed;
  close = async () => { this.closed = true; this.emit('close'); };
  bringToFront = vi.fn(async () => {});
  evaluate = async () => ({
    url: this.href, title: this.challenge ? 'CAPTCHA Verification' : '1688',
    text: this.challenge ? 'Please drag the slider to verify' : '', visibleChallenge: false,
  });
  getByText = () => ({ first: () => ({ isVisible: async () => this.empty }) });
  publishOffers() {
    this.emit('response', {
      url: () => `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/2.0/?${searchQuery}`,
      text: async () => offersBody,
    });
  }
}

function run(tab: SearchTab, headed: boolean) {
  const context = { newPage: async () => tab } as unknown as BrowserContext;
  return execute(context, { imagePath: fileURLToPath(fixture), max: 3, headed });
}

beforeEach(() => {
  vi.mocked(selectImageFile).mockReset();
  vi.mocked(clickImageSearchButton).mockReset().mockImplementation(async (page: Page) => {
    await (page as unknown as SearchTab).goto(resultsUrl);
  });
});
afterEach(() => vi.useRealTimers());

describe('manual slider during image search', () => {
  it.each([IMAGE_SEARCH_UPLOAD_URL, resultsUrl])('returns exit 4 without opening another tab at %s', async url => {
    const tab = new SearchTab();
    tab.onNavigate = destination => { tab.challenge = destination === url; };
    await expect(run(tab, false)).rejects.toMatchObject({ exitCode: 4, code: 'RISK_CONTROL' });
    expect(tab.bringToFront).not.toHaveBeenCalled();
  });

  it('keeps the listener active while the user verifies in the results tab', async () => {
    const tab = new SearchTab();
    tab.onNavigate = url => { tab.challenge = url === resultsUrl; };
    tab.bringToFront.mockImplementation(async () => { tab.challenge = false; tab.publishOffers(); });
    const result = await run(tab, true);
    expect(result).toMatchObject({ imageId: '1234', total: 1, offers: [{ offerId: '1001' }] });
    expect(tab.bringToFront).toHaveBeenCalledTimes(1);
    expect(selectImageFile).toHaveBeenCalledTimes(1);
    expect(tab.listenerCount('response')).toBe(0);
  });

  it('uses the results opened by the upload button without reloading them', async () => {
    const form = new SearchTab();
    const popup = new SearchTab();
    vi.mocked(clickImageSearchButton).mockImplementation(async () => {
      form.emit('popup', popup);
      await popup.goto(resultsUrl);
      popup.publishOffers();
    });
    expect((await run(form, true)).offers[0]?.offerId).toBe('1001');
    expect(popup.goto).toHaveBeenCalledTimes(1);
    expect(form.closed && popup.closed).toBe(true);
    expect(popup.listenerCount('response')).toBe(0);
  });

  it('restores the original result after a post-verification redirect to the homepage', async () => {
    const tab = new SearchTab();
    let firstVisit = true;
    tab.onNavigate = url => {
      if (url !== resultsUrl) return;
      tab.challenge = firstVisit;
      if (!firstVisit) tab.publishOffers();
      firstVisit = false;
    };
    tab.bringToFront.mockImplementation(async () => { tab.href = 'https://www.1688.com/'; tab.challenge = false; });
    expect((await run(tab, true)).total).toBe(1);
    expect(selectImageFile).toHaveBeenCalledTimes(1);
  });

  it('continues an interrupted upload after the user verifies', async () => {
    const tab = new SearchTab();
    vi.mocked(clickImageSearchButton).mockImplementationOnce(async () => { tab.challenge = true; });
    tab.bringToFront.mockImplementation(async () => { tab.challenge = false; });
    tab.onNavigate = url => { if (url === resultsUrl) tab.publishOffers(); };
    expect((await run(tab, true)).total).toBe(1);
    expect(selectImageFile).toHaveBeenCalledTimes(2);
  });

  it('reports cancellation when the verification window is closed', async () => {
    const tab = new SearchTab();
    tab.challenge = true;
    tab.bringToFront.mockImplementation(() => tab.close());
    await expect(run(tab, true)).rejects.toMatchObject({ exitCode: 130, code: 'CANCELED' });
  });

  it('reports an unresolved slider after three minutes', async () => {
    vi.useFakeTimers();
    const tab = new SearchTab();
    tab.challenge = true;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    tab.bringToFront.mockImplementation(async () => { started(); });
    const result = expect(run(tab, true)).rejects.toMatchObject({ exitCode: 4, code: 'RISK_CONTROL' });
    await waiting;
    await vi.advanceTimersByTimeAsync(181_000);
    await result;
    expect(selectImageFile).not.toHaveBeenCalled();
  });

  it.each([false, true])('only accepts a timeout as empty when the site says so (empty=%s)', async empty => {
    vi.useFakeTimers();
    const tab = new SearchTab();
    tab.empty = empty;
    const started = new Promise<void>(resolve => {
      tab.onNavigate = url => { if (url === resultsUrl) resolve(); };
    });
    const result = run(tab, false);
    const check = empty ? expect(result).resolves.toMatchObject({ total: 0, offers: [] })
      : expect(result).rejects.toMatchObject({ code: 'IMAGE_SEARCH_UNAVAILABLE' });
    await started;
    await vi.advanceTimersByTimeAsync(16_000);
    await check;
  });
});
