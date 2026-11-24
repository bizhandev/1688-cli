import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { BrowserContext, Page } from 'playwright';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import {
  clickImageSearchButton,
  selectImageFile,
} from '../session/image-search-locators.js';
import { startSearchOfferCapture } from '../session/search-capture.js';
import { detectPageState } from '../session/page-state.js';
import { waitForTruthy, waitUntil, withTimeout } from '../session/wait.js';
import { type Offer } from './search.js';

export interface ImageSearchOpts {
  imagePath: string;
  max?: string;
  profile?: string;
  firefoxExecutable?: string;
  firefoxProfileDir?: string;
  headed?: boolean;
}

export interface ImageSearchArgs {
  imagePath: string;
  max: number;
  headed?: boolean;
}

export interface ImageSearchResult {
  imageId: string;
  total: number;
  offers: Offer[];
}

// Upload entry point. 1688 currently redirects this to the pc-image-search app
// on air.1688.com, and after "搜索图片" the page lands on a URL carrying
// `imageId=<digits>` — that is where uploadAndGetImageId reads the id from.
export const IMAGE_SEARCH_UPLOAD_URL = 'https://s.1688.com/youyuan/index.htm';

// Results page for an already-uploaded imageId.
//
// Do NOT use the legacy `s.1688.com/selloffer/offer_search.htm?imageId=...`
// URL here: 1688 now ignores `imageId` on that page and renders the ordinary
// keyword-search shell with an empty query. Its getOfferList mtop call then
// returns a personalised "猜你喜欢" feed, so every image produced the same 60
// unrelated offers. The pc-image-search app instead fires appId=32517
// recommend calls with the imageId in their params (see
// IMAGE_SEARCH_RESULT_METHODS); the response has the same
// `data.data.OFFER.items` shape our parser expects.
export function imageSearchResultUrl(imageId: string): string {
  const id = encodeURIComponent(imageId);
  return `https://air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&imageId=${id}&imageIdList=${id}`;
}

// mtop `params.method` values that carry the image-search offer list on the
// results page. Observed sequence on a fresh imageId:
//   1. getImageSearchPreResult  → placeholder (`"mock":["mock"]`, no items)
//      while the server is still computing
//   2. imageOfferSearchService  → the real 60-offer list ~0.5s later
// On a later load of the same imageId the pre-result is cached server-side
// and getImageSearchPreResult itself returns the 60 offers, with no second
// call. Accept both; empty placeholder bodies are ignored by the capture.
// The page also fires other appId=32517 calls (behaviour reports, AI-assist
// streams, empty getOfferList probes), so the capture must stay scoped.
export const IMAGE_SEARCH_RESULT_METHODS = [
  'getImageSearchPreResult',
  'imageOfferSearchService',
] as const;

function captureImageOffers(page: Page) {
  return startSearchOfferCapture({ page, keep: 'largest', requireMethod: IMAGE_SEARCH_RESULT_METHODS });
}

export async function execute(
  ctx: BrowserContext,
  args: ImageSearchArgs,
): Promise<ImageSearchResult> {
  try {
    await fs.access(args.imagePath, fs.constants.R_OK);
  } catch {
    throw new CliError(2, 'BAD_INPUT', `Cannot read image: ${args.imagePath}`);
  }

  const page = await ctx.newPage();
  const captures = new Map([[page, captureImageOffers(page)]]);
  let resultTab = page;
  let imageId: string | undefined;
  const onPopup = (popup: Page) => {
    resultTab = popup;
    captures.set(popup, captureImageOffers(popup));
  };
  page.on('popup', onPopup);
  const headed = args.headed === true;
  try {
    return await withRecovery(ctx, { cmd: 'image-search', args }, async () => {
      if (!imageId) {
        info('Uploading image to 1688...');
        imageId = await uploadAndGetImageId(page, args.imagePath, headed, () => resultTab, () => {
          resultTab = page;
          captures.get(page)!.dispose();
          captures.set(page, captureImageOffers(page));
        });
        info(`Image uploaded (imageId=${imageId}). Fetching results...`);
      }
      const offers = await searchByImageId(resultTab, imageId, headed, captures.get(resultTab)!);
      return { imageId, total: offers.length, offers: offers.slice(0, args.max) };
    }, { headed, maxRetries: 1 });
  } finally {
    page.off('popup', onPopup);
    for (const capture of captures.values()) capture.dispose();
    await Promise.all([...captures.keys()].map(tab => tab.close().catch(() => {})));
  }
}

async function imagePageState(page: Page) {
  if (page.isClosed()) throw new CliError(130, 'CANCELED', 'Image search canceled.');
  const state = await detectPageState(page);
  if (state.kind === 'not_logged_in') throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
  if (state.kind === 'rate_limited') throw new CliError(9, 'RATE_LIMITED', '1688 is rate-limiting this session.');
  return state;
}

async function waitForManualVerification(page: Page, headed: boolean): Promise<boolean> {
  if ((await imagePageState(page)).kind !== 'risk_challenge') return false;
  if (!headed) throw new CliError(4, 'RISK_CONTROL', '1688 requires slider verification. Run once with --headed.');
  process.stderr.write('1688 is asking you to verify. Complete the slider in this tab; image search will resume here.\n');
  await withTimeout(page.bringToFront().catch(() => {}), { timeoutMs: 1500, fallback: undefined });
  let reportedWidgetError = false;
  const cleared = await waitUntil(async () => {
    const state = await imagePageState(page);
    if (!reportedWidgetError && state.indicators.includes('verification-widget-error')) {
      process.stderr.write('1688 reports a verification error and asks you to refresh this tab.\n');
      reportedWidgetError = true;
    }
    return state.kind === 'normal_1688_page';
  }, { timeoutMs: 180_000, intervalMs: 500 });
  if (!cleared) throw new CliError(4, 'RISK_CONTROL', '1688 still requires manual verification after 3 minutes.');
  return true;
}

function uploadedImageId(page: Page): string | null {
  const url = new URL(page.url());
  const id = url.searchParams.get('imageId');
  return id && /^\d+$/.test(id) && url.hostname === 'air.1688.com' && /\/pc-image-search\/?$/.test(url.pathname) ? id : null;
}

async function uploadAndGetImageId(
  page: Page, imagePath: string, headed: boolean, resultTab: () => Page, beforeSubmit: () => void,
): Promise<string> {
  await page.goto(IMAGE_SEARCH_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const reopenForm = async () => {
    if (new URL(page.url()).hostname === 'www.1688.com') {
      await page.goto(IMAGE_SEARCH_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
  };
  if (await waitForManualVerification(page, headed)) await reopenForm();

  for (let attempt = 0; ; attempt++) {
    try {
      await selectImageFile(page, imagePath);
      beforeSubmit();
      await clickImageSearchButton(page);
      const imageId = await waitForTruthy(async () => {
        const tab = resultTab();
        const id = uploadedImageId(tab);
        if (id) return id;
        if ((await imagePageState(tab)).kind === 'risk_challenge') {
          throw new CliError(4, 'RISK_CONTROL', '1688 requested verification during the upload.');
        }
        return null;
      }, { timeoutMs: 20_000 });
      if (imageId) return imageId;
      throw new CliError(13, 'UPLOAD_FAILED', '1688 did not return an image ID after upload.');
    } catch (error) {
      const tab = resultTab();
      if (!await waitForManualVerification(tab, headed)) throw error;
      const imageId = uploadedImageId(tab);
      if (imageId) return imageId;
      // A verification redirect can reset the upload form. Resubmit only after the user clears it.
      if (attempt > 0) throw new CliError(13, 'UPLOAD_FAILED', 'The upload form reset again after verification.');
      await reopenForm();
    }
  }
}

async function searchByImageId(
  page: Page, imageId: string, headed: boolean, capture: ReturnType<typeof captureImageOffers>,
): Promise<Offer[]> {
  const waitForOffers = () => capture.wait({
    timeoutMs: 15_000,
    isClosed: () => page.isClosed(),
    isBlocked: async () => (await imagePageState(page)).kind === 'risk_challenge',
  });
  const originalUrl = uploadedImageId(page) === imageId ? page.url() : imageSearchResultUrl(imageId);
  const openResults = () => page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (uploadedImageId(page) !== imageId) await openResults();
  for (let attempt = 0; ; attempt++) {
    const result = await waitForOffers();
    if (process.env.BB1688_DEBUG === '1') {
      const { seenCount, matchedCount, parsedCount } = result.diagnostics;
      process.stderr.write(`[image-search] ${result.status} seen=${seenCount} matched=${matchedCount} parsed=${parsedCount}\n`);
    }
    if (result.status === 'browser_closed') throw new CliError(130, 'CANCELED', 'Image search canceled.');
    if (attempt > 0 && result.status === 'blocked') {
      throw new CliError(4, 'RISK_CONTROL', '1688 requested verification again.');
    }
    const verified = await waitForManualVerification(page, headed);
    if (verified || result.status === 'blocked') {
      if (uploadedImageId(page) !== imageId) await openResults();
      continue;
    }
    if (result.status === 'captured') return result.offers;
    const empty = page.getByText(/^(?:暂无搜索结果|未找到相关(?:商品|货源)|没有找到相关(?:商品|货源)|抱歉[，,]?\s*没有找到相关(?:商品|货源))[。！!]?$/);
    if (uploadedImageId(page) === imageId && await empty.first().isVisible()) return [];
    throw new CliError(13, 'IMAGE_SEARCH_UNAVAILABLE', '1688 returned neither offers nor an explicit empty result.');
  }
}

export async function run(opts: ImageSearchOpts): Promise<void> {
  if (!opts.imagePath) {
    throw new CliError(2, 'BAD_INPUT', 'Image path or URL required.');
  }
  if (Boolean(opts.firefoxExecutable) !== Boolean(opts.firefoxProfileDir)) {
    throw new CliError(2, 'BAD_INPUT', 'Use --firefox-executable and --firefox-profile-dir together.');
  }
  if (opts.firefoxProfileDir && opts.profile) {
    throw new CliError(2, 'BAD_INPUT', 'The Firefox profile is already selected with --firefox-profile-dir.');
  }
  const max = Math.max(1, parseInt(opts.max ?? '20', 10));

  let abs: string;
  let cleanup: (() => Promise<void>) | null = null;
  if (/^https?:\/\//i.test(opts.imagePath)) {
    info(`Downloading image from URL...`);
    const t = await downloadToTemp(opts.imagePath);
    abs = t.path;
    cleanup = t.cleanup;
  } else {
    abs = path.resolve(opts.imagePath);
  }

  try {
    const args = { imagePath: abs, max, headed: opts.headed };
    let data: ImageSearchResult;
    if (opts.firefoxExecutable && opts.firefoxProfileDir) {
      const { firefox } = await import('playwright');
      const ctx = await firefox.launchPersistentContext(path.resolve(opts.firefoxProfileDir), {
        executablePath: path.resolve(opts.firefoxExecutable), headless: !opts.headed,
      });
      try {
        data = await execute(ctx, args);
      } finally {
        await ctx.close();
      }
    } else {
      data = await dispatch<ImageSearchArgs, ImageSearchResult>('image-search', args, {
        headed: opts.headed, profile: opts.profile,
      });
    }
    emit({
      human: () => printResults(data),
      data,
    });
  } finally {
    if (cleanup) await cleanup().catch(() => {});
  }
}

interface TempFile {
  path: string;
  cleanup: () => Promise<void>;
}

async function downloadToTemp(url: string): Promise<TempFile> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new CliError(
      9,
      'NETWORK_ERROR',
      `Failed to download image: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new CliError(
      9,
      'NETWORK_ERROR',
      `Download failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new CliError(9, 'NETWORK_ERROR', 'Downloaded image is empty.');
  }
  if (buf.length > 20 * 1024 * 1024) {
    throw new CliError(
      2,
      'BAD_INPUT',
      `Image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB).`,
    );
  }
  const ext = guessExt(url, res.headers.get('content-type'));
  const tmpPath = path.join(
    os.tmpdir(),
    `bb1688-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
  await fs.writeFile(tmpPath, buf);
  return {
    path: tmpPath,
    cleanup: () => fs.rm(tmpPath, { force: true }),
  };
}

function guessExt(url: string, contentType: string | null): string {
  const m = url.match(/\.(jpe?g|png|webp|bmp)(\?|$|#)/i);
  if (m) return '.' + m[1]!.toLowerCase().replace('jpeg', 'jpg');
  if (contentType) {
    if (/jpeg/i.test(contentType)) return '.jpg';
    if (/png/i.test(contentType)) return '.png';
    if (/webp/i.test(contentType)) return '.webp';
    if (/bmp/i.test(contentType)) return '.bmp';
  }
  return '.jpg';
}

function printResults(r: ImageSearchResult): void {
  if (r.offers.length === 0) {
    process.stdout.write(`No offers found (imageId=${r.imageId}).\n`);
    return;
  }
  process.stdout.write(`Image search (imageId=${r.imageId}):\n\n`);
  const w = String(r.offers.length).length;
  r.offers.forEach((o, i) => {
    const idx = String(i + 1).padStart(w, ' ');
    const price = o.price.text || '(n/a)';
    process.stdout.write(`${idx}. ${o.title}\n`);
    const pad = ' '.repeat(w + 2);
    process.stdout.write(`${pad}${price}`);
    if (o.turnover) process.stdout.write(`  ·  ${o.turnover}`);
    process.stdout.write('\n');
    const supplierBits = [
      o.supplier.name,
      o.supplier.years ? `${o.supplier.years}年` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (supplierBits) process.stdout.write(`${pad}${supplierBits}\n`);
    process.stdout.write(`${pad}${o.url}\n`);
    if (i < r.offers.length - 1) process.stdout.write('\n');
  });
}
