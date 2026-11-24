import { describe, expect, it } from 'vitest';
import { identityConfidence, visualConfidence } from '../sourcing/confidence.mjs';
import { photoRequirements, compareLabel, rankOffers } from '../sourcing/matching.mjs';
import { quoteVariant, supplierEvidence, readAfterVerification } from '../sourcing/detail.mjs';
import { sheetValues } from '../sourcing/sheet.mjs';

const exact = { score: 0.99, inliers: 0, source_coverage: 0, target_coverage: 0, same_visual_design: true };
const offer = {
  url: 'https://detail.1688.com/offer/101.html',
  seller: 'Factory A',
  variant: 'blue 85',
  factory_status: 'verified',
  factory_evidence: 'inspection',
  quote_confirmed: true,
  unit_is_piece: true,
  min_order: 1000,
  min_order_unit: '个',
  unit_price_cny: 68,
  lot_price_cny: 68000,
  match_confidence_pct: 99,
  identity_confirmed: true,
  verified: true,
  search_rank: 1,
};

describe('поиск фабрики по фото', () => {
  it('reads the current page after manual verification and preserves a remaining challenge', async () => {
    for (const after of ['ok', 'verification_required']) {
      const snapshots = [{ status: 'verification_required' }, { status: after }];
      expect(
        await readAfterVerification(
          async () => snapshots.shift() ?? { status: after },
          async () => false,
        ),
      ).toEqual({ status: after });
      expect(snapshots).toHaveLength(0);
    }
  });
  it('keeps the same tab open when a second slider appears after an accepted check', async () => {
    const states = ['verification_required', 'verification_required', 'ok'];
    let checks = 0;
    const result = await readAfterVerification(
      async () => ({ status: states.shift() }),
      async () => { checks++; return true; },
    );
    expect(result.status).toBe('ok');
    expect(checks).toBe(2);
  });
  it('distinguishes missing, weak and full-frame evidence', () => {
    expect(visualConfidence({ score: null })).toBeNull();
    expect(visualConfidence({ score: -0.4 })).toBe(0);
    expect(identityConfidence(exact, [])?.percent).toBe(99);
    expect(identityConfidence(exact, ['sku_kit_unconfirmed'])?.identity_confirmed).toBe(false);
    expect(identityConfidence(exact, [], { listingOnly: true })?.percent).toBeLessThan(60);
  });
  it('uses a localized print only with evidence in both photos', () => {
    const pair = { score: 0.45, inliers: 24, source_coverage: 0.04, target_coverage: 0.03 };
    expect(identityConfidence(pair, ['print_unconfirmed'])?.identity_confirmed).toBe(true);
    expect(
      identityConfidence({ ...pair, target_coverage: 0 }, ['print_unconfirmed'])?.identity_confirmed,
    ).toBe(false);
    expect(identityConfidence(pair, ['sku_size_unconfirmed'])?.percent).toBeLessThan(70);
  });
  it('rejects conflicting SKU sizes and quotes the correct MOQ tier', () => {
    const req = photoRequirements('Тюбинг Смайлы 85 см с камерой');
    expect(compareLabel(req, { label: '花色100' }).rejected).toBe('wrong_size');
    expect(compareLabel(req, { label: '花色85' }).reasons).toContain('sku_kit_unconfirmed');
    expect(
      quoteVariant({ label: '花色85', row_text: '花色85 ¥68', price_text: '¥68' }, '¥68 1000个起批'),
    ).toMatchObject({ price_cny: 68, min_order: 1000, lot_price_cny: 68000 });
  });
  it('quotes the selected SKU within the normal price range at MOQ', () => {
    const row = {
      label: '120cm',
      row_text: '120cm\n¥82\n库存500个',
      price_text: '¥82',
      stock_text: '库存500个',
    };
    const base = '¥65.00 ~ ¥140.00 5个起批';
    expect(quoteVariant(row, base)).toMatchObject({ price_cny: 82, min_order: 5, lot_price_cny: 410 });
    expect(quoteVariant(row, '新人价 ¥64起 5件预估到手单价 ' + base).price_cny).toBe(82);
    expect(quoteVariant(row, '¥65 ~ ¥140 5个起定').min_order).toBe(5);
    expect(quoteVariant(row, '新人价 ¥64 5个起批').price_cny).toBeNull();
    expect(quoteVariant(row, '¥10 ~ ¥40 5个起批').price_cny).toBeNull();
    expect(quoteVariant(row, base + ' 活动前￥81-155元').price_cny).toBeNull();
  });
  it('orders distinct manufacturers by comparable shop sales only inside a confidence tie', () => {
    const sales = (value: number, days = 30) => ({
      scope: 'factory',
      metric: 'turnover_cny',
      period_days: days,
      bound: 'exact',
      value,
    });
    const b = {
      ...offer,
      seller: 'Factory B',
      url: 'https://detail.1688.com/offer/102.html',
      match_confidence_pct: 97,
      factory_sales: sales(120),
    };
    const a = { ...offer, factory_sales: sales(50) };
    expect(rankOffers([a, a, b]).map((o) => o.seller)).toEqual(['Factory B', 'Factory A']);
    expect(rankOffers([a, { ...b, factory_sales: sales(120, 90) }])[0].seller).toBe('Factory A');
    expect(rankOffers([a, { ...b, factory_sales: { ...sales(120), basis: '1688_store' } }])[0].seller).toBe(
      'Factory A',
    );
    expect(rankOffers([a, { ...b, match_confidence_pct: 80 }])[0].seller).toBe('Factory A');
    expect(supplierEvidence(['经营模式：生产加工']).factory_status).toBe('verified');
  });
  it('puts independent links and confidence in T, a numeric unit price and per-factory totals in U', () => {
    const b = {
      ...offer,
      seller: 'Factory B',
      url: 'https://detail.1688.com/offer/102.html',
      match_confidence_pct: 79,
      verified: false,
      identity_confirmed: false,
    };
    const { t, u } = sheetValues({ offers: [offer, b] });
    expect(t.textFormatRuns.map((r) => r.format.link.uri)).toEqual([offer.url, b.url]);
    expect(t.userEnteredValue.stringValue).toContain('79%');
    expect(u.userEnteredValue.numberValue).toBe(68);
    expect(u.note.replaceAll(/\s/g, '')).toContain('68000¥');
    const pending = sheetValues({ offers: [b] });
    expect(pending.u.userEnteredValue).toBeUndefined();
    expect(pending.u.note).toMatch(/1\s000/);
    expect(() => sheetValues({ offers: [offer, offer] })).toThrow();
  });
});
