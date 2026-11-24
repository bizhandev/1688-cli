import { firefox } from 'playwright';
import { join } from 'node:path';
import { execute as imageSearch, waitForManualVerification } from '../dist/commands/image-search.js';
import {
  inspectOffer,
  enrichSupplier,
  supplierEvidence,
  restoreQuote,
  readAfterVerification,
} from './detail.mjs';
import { key, readCache, saveJson, runtime } from './cache.mjs';

const manualVerificationMs = 15 * 60_000;

export function openBrowser(headed = true) {
  const local = process.env.LOCALAPPDATA;
  const executablePath =
    process.env.BB1688_FIREFOX_EXECUTABLE ||
    (local && join(local, 'camoufox', 'camoufox', 'Cache', 'camoufox.exe'));
  const profile =
    process.env.BB1688_FIREFOX_PROFILE_DIR ||
    (local && join(local, 'BizhanRuntime', 'marketplaces', '1688-camoufox'));
  if (!profile || !executablePath)
    throw Error('Укажите BB1688_FIREFOX_EXECUTABLE и BB1688_FIREFOX_PROFILE_DIR.');
  return firefox.launchPersistentContext(profile, { executablePath, headless: !headed });
}

export async function findCards(context, photo, headed) {
  const path = join(runtime, 'search', photo.hash + '.json');
  const cached = await readCache(path);
  if (cached) return cached;
  const result = await imageSearch(await context(), {
    imagePath: photo.path,
    max: 60,
    headed,
    manualVerificationMs,
  });
  const cards = result.offers
    .filter((o) => /^https:\/\/detail\.1688\.com\/offer\/\d+\.html$/.test(o.url))
    .map((o, i) => ({
      id: String(o.offerId),
      rank: i + 1,
      url: o.url,
      title: o.title,
      image_url: o.image,
      seller: o.supplier?.name,
      shop_url: o.supplier?.shopUrl?.replace(/^http:/, 'https:'),
      biz_type: o.bizType,
      inspection: o.verified?.factory || o.verified?.superFactory || false,
    }));
  await saveJson(path, cards);
  return cards;
}

function gateError(status) {
  return Object.assign(
    new Error(status === 'login_required' ? '1688 требует вход в аккаунт.' : '1688 требует ручной проверки.'),
    { code: status === 'login_required' ? 'NOT_LOGGED_IN' : 'RISK_CONTROL' },
  );
}
export const stopCodes = new Set(['RISK_CONTROL', 'NOT_LOGGED_IN', 'CANCELED', 'RATE_LIMITED']);

export async function sellerData(context, detail, headed, fetchIfMissing) {
  if (!detail.shop_url || !detail.seller) return null;
  const file = join(runtime, 'suppliers', key(JSON.stringify([detail.shop_url, detail.seller])) + '.json');
  const cached = await readCache(file);
  if (cached || !fetchIfMissing) return cached;
  let barrier;
  const onCheck = async (tab, status) => {
    if (status === 'login_required') {
      barrier = gateError(status);
      return false;
    }
    try {
      await waitForManualVerification(tab, headed, manualVerificationMs);
      return true;
    } catch (e) {
      barrier = e;
      return false;
    }
  };
  const profile = await enrichSupplier(await context(), detail, onCheck);
  if (barrier) throw barrier;
  if (['verification_required', 'login_required'].includes(profile.supplier_check_status))
    throw gateError(profile.supplier_check_status);
  const store = {
    status: profile.supplier_check_status,
    evidence: profile.factory_evidence,
    sales: profile.factory_sales,
  };
  if (store.status === 'checked') await saveJson(file, store);
  return store;
}

export async function cachedDetail(card) {
  const cached = await readCache(join(runtime, 'details', card.id + '.json'));
  if (!cached) return null;
  const restored = { ...cached, variants: cached.variants.map(restoreQuote) };
  if (cached.seller && card.seller && cached.seller.trim() === card.seller.trim()) {
    const facts = [
      cached.factory_evidence,
      cached.factory_sales?.evidence,
      ...(cached.supplier_observations || []),
    ].filter(Boolean);
    if (card.biz_type) facts.push('经营模式：' + card.biz_type);
    if (card.inspection) facts.push('实地验厂');
    Object.assign(restored, supplierEvidence(facts));
  }
  return restored;
}

export async function getDetail(context, card, headed) {
  const path = join(runtime, 'details', card.id + '.json');
  const cached = await cachedDetail(card);
  if (cached) return cached;
  const ctx = await context();
  const page = await ctx.newPage();
  try {
    const open = () => page.goto(card.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await open();
    if (
      (await waitForManualVerification(page, headed, manualVerificationMs)) &&
      new URL(page.url()).pathname !== new URL(card.url).pathname
    )
      await open();
    const detail = await readAfterVerification(
      () => inspectOffer(page, card),
      async () => {
        const cleared = await waitForManualVerification(page, headed, manualVerificationMs);
        if (cleared && new URL(page.url()).pathname !== new URL(card.url).pathname) await open();
      },
    );
    if (['verification_required', 'login_required'].includes(detail.status)) throw gateError(detail.status);
    if (detail.status !== 'ok') return detail;
    const sameSeller =
      detail.seller && card.seller && detail.seller.replace(/\s/g, '') === card.seller.replace(/\s/g, '');
    const evidence = [...detail.supplier_observations];
    if (sameSeller) {
      if (card.biz_type) evidence.push('经营模式：' + card.biz_type);
      if (card.inspection) evidence.push('实地验厂');
      detail.shop_url ||= card.shop_url;
    }
    const fromCard = supplierEvidence(evidence);
    const partial = { ...detail, ...fromCard };
    const store = await sellerData(context, partial, headed, false);
    if (store?.evidence) evidence.push(store.evidence);
    if (store?.sales?.evidence) evidence.push(store.sales.evidence);
    const result = {
      ...detail,
      ...supplierEvidence(evidence),
      store_status: store?.status,
      checked_at: new Date().toISOString(),
    };
    await saveJson(path, result);
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}
