import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sourcePhoto } from '../sourcing/source.mjs';
import { cachedDetail, findCards, getDetail, sellerData } from '../sourcing/catalogue.mjs';
import { scoreImages } from '../sourcing/visual.mjs';

vi.mock('../sourcing/cache.mjs', () => ({
  runtime: '.',
  readCache: async () => ({ status: 'ok', text: '' }),
  saveJson: vi.fn(),
}));
vi.mock('../sourcing/ocr.mjs', () => ({ readPhotoText: vi.fn() }));
vi.mock('../sourcing/visual.mjs', () => ({ scoreImages: vi.fn() }));
vi.mock('../sourcing/catalogue.mjs', () => ({
  cachedDetail: vi.fn(),
  findCards: vi.fn(),
  getDetail: vi.fn(),
  sellerData: vi.fn(),
  stopCodes: new Set(['RISK_CONTROL']),
}));

const browser = vi.fn();
const photo = { path: 'local.webp', hash: 'source' };
const cards = Array.from({ length: 4 }, (_, i) => ({
  id: String(i + 1),
  rank: i + 1,
  url: `https://detail.1688.com/offer/${i + 1}.html`,
  image_url: `https://example.test/photo/${i + 1}`,
  title: 'Product',
  seller: `Manufacturer ${i + 1}`,
}));

function setScores(scores: number[]) {
  vi.mocked(scoreImages).mockImplementation(async (_query, rows) => ({
    scores: rows.map((r) => ({ id: r.id, score: scores[Number(r.id.split('/')[0]) - 1] })),
  }));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cachedDetail).mockResolvedValue(null);
  vi.mocked(findCards).mockResolvedValue(cards);
  vi.mocked(getDetail).mockImplementation(async (_context, card) => ({
    status: 'ok',
    factory_status: card.rank === 4 ? 'unknown' : 'verified',
    seller: card.seller,
    factory_evidence: card.rank === 4 ? null : '经营模式：生产加工',
    variants: [{ id: 'option', label: 'Standard', image_url: card.image_url }],
  }));
});

describe('which factory profiles need opening', () => {
  it('keeps already verified SKU offers when a new listing photo ranks below all three', async () => {
    vi.mocked(cachedDetail).mockImplementation(async (card) =>
      card.rank === 4
        ? null
        : {
            status: 'ok',
            seller: card.seller,
            factory_status: 'verified',
            factory_evidence: '经营模式：生产加工',
            variants: [{ id: 'sku', label: 'Standard', image_url: card.image_url }],
          },
    );
    setScores([0.85, 0.72, 0.62, 0.4]);
    const result = await sourcePhoto(browser, photo, 'Product');
    expect(result.offers.map((o) => o.search_rank)).toEqual([1, 2, 3]);
    expect(result.cached_details).toBe(3);
    expect(getDetail).not.toHaveBeenCalled();
  });
  it('skips a football and a display lamp in an image search for a snow tube', async () => {
    vi.mocked(findCards).mockResolvedValue([
      { ...cards[0], title: '珠宝展示柜灯 便携射灯' },
      { ...cards[1], title: '5号PVC足球成人训练比赛' },
      { ...cards[2], title: '充气滑雪圈' },
    ]);
    setScores([0.95, 0.95, 0.68, 0.2]);
    const result = await sourcePhoto(browser, photo, 'Тюбинг для катания');
    expect(result.offers.map((o) => o.search_rank)).toEqual([3]);
    expect(getDetail).toHaveBeenCalledTimes(1);
  });
  it('skips a lower-scoring unverified company and optional turnover lookups on weak photos', async () => {
    setScores([0.52, 0.48, 0.44, 0.22]);
    const result = await sourcePhoto(browser, photo, 'Product');
    expect(result.status).toBe('ok');
    expect(result.offers.map((o) => o.search_rank)).toEqual([1, 2, 3]);
    expect(sellerData).not.toHaveBeenCalled();
  });
  it('checks an unverified visual finalist before selecting manufacturers', async () => {
    setScores([0.62, 0.51, 0.45, 0.87]);
    vi.mocked(sellerData).mockResolvedValue({
      status: 'checked',
      evidence: '经营模式：生产加工',
      sales: null,
    });
    const result = await sourcePhoto(browser, photo, 'Product');
    expect(result.offers[0]).toMatchObject({ search_rank: 4, factory_status: 'verified' });
    expect(result.unverified_suppliers).toHaveLength(0);
    expect(sellerData).toHaveBeenCalledTimes(1);
  });
  it('keeps the available candidates when a necessary profile requests user verification', async () => {
    setScores([0.62, 0.51, 0.45, 0.87]);
    vi.mocked(sellerData).mockRejectedValue(
      Object.assign(new Error('manual verification'), { code: 'RISK_CONTROL' }),
    );
    const result = await sourcePhoto(browser, photo, 'Product');
    expect(result).toMatchObject({ status: 'interrupted', gate: 'RISK_CONTROL' });
    expect(result.offers.map((o) => o.search_rank)).toEqual([1, 2, 3]);
    expect(sellerData).toHaveBeenCalledTimes(1);
  });
});
