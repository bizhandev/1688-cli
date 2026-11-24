import { join } from 'node:path';
import { readCache, saveJson, runtime } from './cache.mjs';
import { cachedDetail, getDetail, findCards, sellerData, stopCodes } from './catalogue.mjs';
import { compareLabel, competingOptions, photoRequirements, rankOffers } from './matching.mjs';
import { identityConfidence, visualConfidence } from './confidence.mjs';
import { scoreImages } from './visual.mjs';
import { readPhotoText } from './ocr.mjs';
import { restoreQuote, supplierEvidence } from './detail.mjs';

function unrelated(req, title) {
  if (!req.tube) return false;
  return (
    /收纳袋|储物袋|游泳圈|足球|篮球|排球|珠宝|展示柜灯|射灯|纸伞|伊丽莎白|花环袋|圣诞树袋/.test(title) &&
    !/滑雪圈|雪圈|雪胎|тюбинг|snow\s*tube/i.test(title)
  );
}

const snowProduct =
  /滑雪|滑草|雪圈|雪胎|雪管|雪橇|雪撬|雪盆|雪地(?:圈|滑|轮胎|飞碟|拖)|充气雪|旱滑|snow[\s-]*(?:tub|sled)|тюбинг|ватрушк|санки/iu;

function shortlist(cards, scores, limit) {
  const byId = new Map(scores.map((x) => [x.id, x]));
  const sorted = cards
    .map((c) => ({ ...c, listing: byId.get(c.id) }))
    .sort(
      (a, b) => (visualConfidence(b.listing) ?? -1) - (visualConfidence(a.listing) ?? -1) || a.rank - b.rank,
    );
  const chosen = new Map();
  const add = (c) => {
    if (chosen.size < limit) chosen.set(c.id, c);
  };
  [...sorted]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.min(3, Math.floor(limit / 2)))
    .forEach(add);
  const sellers = new Set([...chosen.values()].map((x) => x.seller));
  for (const c of sorted)
    if (!sellers.has(c.seller)) {
      add(c);
      sellers.add(c.seller);
    }
  sorted.forEach(add);
  return [...chosen.values()];
}

function quoteFields(variant) {
  const quoted = variant.quote_status === 'verified' && Number.isFinite(variant.lot_price_cny);
  const unitIsPiece = /^(?:件|个|条|只|台|把|辆|张|枚|块|支|本|瓶|根)$/.test(variant.min_order_unit || '');
  return {
    quote_confirmed: quoted,
    unit_is_piece: unitIsPiece,
    unit_price_cny: quoted ? variant.price_cny : null,
    min_order: quoted ? variant.min_order : null,
    min_order_unit: quoted ? variant.min_order_unit : null,
    lot_price_cny: quoted ? variant.lot_price_cny : null,
    price_evidence: variant.evidence,
    price_issue: variant.quote_reason || null,
  };
}

export function refreshResultQuotes(result) {
  function refresh(offer) {
    if (offer.quote_confirmed) return offer;
    const evidence = restoreQuote({
      label: offer.variant,
      quote_reason: offer.price_issue,
      evidence: offer.price_evidence,
    });
    if (evidence.quote_status !== 'verified') return offer;
    const quote = quoteFields(evidence);
    return {
      ...offer,
      ...quote,
      verified: offer.identity_confirmed && quote.unit_is_piece && offer.factory_status === 'verified',
    };
  }
  return {
    ...result,
    offers: result.offers.map(refresh),
    ...(result.unverified_suppliers
      ? { unverified_suppliers: result.unverified_suppliers.map(refresh) }
      : {}),
  };
}

function buildOffer(req, card, detail, variant, image, siblings) {
  const facts = compareLabel(req, variant);
  if (facts.rejected) return null;
  const reasons = [...facts.reasons];
  if (competingOptions(req, detail, variant, image?.score, siblings)) reasons.push('sku_images_ambiguous');
  const listingOnly = !Number.isFinite(image?.score);
  const confidence = identityConfidence(listingOnly ? card.listing : image, reasons, { listingOnly });
  if (!confidence) return null;
  const quote = quoteFields(variant);
  return {
    url: card.url,
    seller: detail.seller || card.seller,
    shop_url: detail.shop_url,
    factory_status: detail.factory_status,
    factory_evidence: detail.factory_evidence,
    factory_sales: detail.factory_sales,
    search_rank: card.rank,
    title: card.title,
    variant: variant.label,
    variant_id: variant.id,
    image_url: variant.image_url,
    match_confidence_pct: confidence.percent,
    visual_score: image?.score ?? null,
    match_evidence: {
      scope: listingOnly ? 'listing' : 'sku',
      cosine: image?.score ?? card.listing?.score,
      inliers: image?.inliers ?? 0,
      source_coverage: image?.source_coverage,
      target_coverage: image?.target_coverage,
      same_visual_design: image?.same_visual_design ?? false,
      graphic_match: confidence.design_confirmed,
      unresolved: confidence.unresolved,
    },
    identity_confirmed: confidence.identity_confirmed,
    ...quote,
    verified:
      confidence.identity_confirmed &&
      quote.quote_confirmed &&
      quote.unit_is_piece &&
      detail.factory_status === 'verified',
  };
}

async function compareVariants(photo, req, inspected, localOnly = false) {
  const variants = [];
  for (const { card, detail } of inspected) {
    if (detail.factory_status === 'trader' || unrelated(req, detail.title)) continue;
    for (const v of detail.variants) {
      if (!compareLabel(req, v).rejected) variants.push({ id: card.id + '/' + v.id, image_url: v.image_url });
    }
  }
  const visual = await scoreImages(photo.path, variants, { localOnly });
  const scores = new Map(visual.scores.map((s) => [s.id, s]));
  const candidates = [];
  for (const { card, detail } of inspected) {
    if (detail.factory_status === 'trader' || unrelated(req, detail.title)) continue;
    const siblings = new Map(detail.variants.map((v) => [v.id, scores.get(card.id + '/' + v.id)?.score]));
    for (const v of detail.variants) {
      const offer = buildOffer(req, card, detail, v, scores.get(card.id + '/' + v.id), siblings);
      if (offer) candidates.push(offer);
    }
  }
  return { candidates, compared: variants.length, model: visual.model };
}

// A later row may have opened another real listing from this photo's own results.
// Compare only newly observed SKU photos, keeping the original search and its ranks.
export async function recheckSavedOffers(photo, title, previous) {
  const since = Date.parse(previous.catalogue_reviewed_at || previous.checked_at);
  if (!Number.isFinite(since) || !['ok', 'no_verified_factory_match'].includes(previous.status))
    return previous;
  const cards = await readCache(join(runtime, 'search', photo.hash + '.json'));
  if (!Array.isArray(cards) || !cards.length) return previous;
  const ocr = await readCache(join(runtime, 'ocr', photo.hash + '.json'), 720);
  const req = photoRequirements(title, ocr || {});
  const until = Date.now();
  const known = await Promise.all(
    cards.map(async (card) => {
      if (unrelated(req, card.title) || /经销批发|招商代理|贸易型/.test(card.biz_type || '')) return null;
      const detail = await cachedDetail(card);
      const observed = Date.parse(detail?.checked_at);
      if (!(observed > since && observed <= until) || detail.factory_status !== 'verified' || !detail.seller)
        return null;
      if (req.tube && !snowProduct.test(card.title) && !snowProduct.test(detail.title || '')) return null;
      return { card, detail };
    }),
  );
  const fresh = known.filter(Boolean);
  if (!fresh.length) return previous;
  const { candidates, compared } = await compareVariants(photo, req, fresh, true);
  const offers = rankOffers([...previous.offers, ...candidates]);
  return {
    ...previous,
    status: offers.length ? 'ok' : previous.status,
    offers,
    catalogue_reviewed_at: new Date(until).toISOString(),
    rechecked_details: (previous.rechecked_details || 0) + fresh.length,
    rechecked_variants: (previous.rechecked_variants || 0) + compared,
  };
}

export async function sourcePhoto(context, photo, title, { headed = true, detailLimit = 12 } = {}) {
  const cards = await findCards(context, photo, headed);
  if (!cards.length) return { status: 'no_matches', offers: [], candidates_found: 0 };
  const ocrFile = join(runtime, 'ocr', photo.hash + '.json');
  let ocr = await readCache(ocrFile, 720);
  if (!ocr) {
    ocr = await readPhotoText(photo.path);
    if (ocr.status === 'ok') await saveJson(ocrFile, ocr);
  }
  const req = photoRequirements(title, ocr);
  const relevant = cards.filter(
    (c) => !unrelated(req, c.title) && !/经销批发|招商代理|贸易型/.test(c.biz_type || ''),
  );
  const images = await scoreImages(
    photo.path,
    relevant.map((c) => ({ id: c.id, image_url: c.image_url })),
  );
  const byImage = new Map(images.scores.map((s) => [s.id, s]));
  const eligible = relevant.filter(
    (c) => !req.tube || snowProduct.test(c.title) || (visualConfidence(byImage.get(c.id)) ?? 0) >= 85,
  );
  if (!eligible.length)
    return {
      status: 'no_verified_factory_match',
      offers: [],
      candidates_found: cards.length,
      details_read: 0,
      variants_compared: 0,
      reason: 'category_mismatch',
      checked_at: new Date().toISOString(),
    };
  const selected = shortlist(eligible, images.scores, detailLimit);
  const selectedIds = new Set(selected.map((c) => c.id));
  const snapshots = await Promise.all(
    eligible.map(async (card) => ({
      card: { ...card, listing: byImage.get(card.id) },
      detail: await cachedDetail(card),
    })),
  );
  const inspected = snapshots.filter((entry) => entry.detail?.status === 'ok');
  const cachedIds = new Set(inspected.map((entry) => entry.card.id));
  const unseen = new Map(selected.filter((card) => !cachedIds.has(card.id)).map((card) => [card.url, card]));
  const initial = await compareVariants(photo, req, inspected);
  const candidates = initial.candidates;
  let compared = initial.compared,
    model = initial.model || images.model,
    gate,
    interruptedAt;
  const failures = [];
  // Compare actual SKU photos first. Open a new listing only while its visible
  // photo can put that seller in the top three, or the shortlist is exhaustive.
  while (unseen.size && !gate) {
    const pending = [...unseen.values()].map((card) => ({
      url: card.url,
      seller: card.seller,
      shop_url: card.shop_url,
      search_rank: card.rank,
      match_confidence_pct: visualConfidence(card.listing) ?? 0,
      visual_score: card.listing?.score,
      factory_status: 'unknown',
      pending: true,
    }));
    const verified = candidates.filter((offer) => offer.factory_status === 'verified' && offer.seller);
    const finalists =
      detailLimit === 60 ? pending : rankOffers([...verified, ...pending]).filter((o) => o.pending);
    if (!finalists.length) break;
    const next = finalists.map((o) => unseen.get(o.url));
    if (!inspected.length && detailLimit < 60 && !next.includes(selected[0])) next.push(selected[0]);
    const fresh = [];
    for (const card of next) {
      if (!unseen.delete(card.url)) continue;
      try {
        const detail = await getDetail(context, card, headed);
        if (detail.status === 'ok') fresh.push({ card, detail });
        else failures.push({ url: card.url, status: detail.status });
      } catch (e) {
        if (stopCodes.has(e.code)) {
          gate = e.code;
          interruptedAt = { stage: 'offer', url: card.url };
          break;
        }
        failures.push({ url: card.url, status: e.code || 'detail_error' });
      }
    }
    inspected.push(...fresh);
    const scored = await compareVariants(photo, req, fresh);
    candidates.push(...scored.candidates);
    compared += scored.compared;
    model ||= scored.model;
  }
  const manufacturers = candidates.filter((o) => o.factory_status === 'verified' && o.seller);
  const unknown = rankOffers(
    candidates.filter((o) => o.factory_status === 'unknown' && o.seller),
    candidates.length,
  );
  const detailsByUrl = new Map(inspected.map(({ card, detail }) => [card.url, detail]));
  async function checkCompany(offer) {
    try {
      const detail = detailsByUrl.get(offer.url);
      const store = await sellerData(context, detail, headed, true);
      if (store?.status === 'checked') {
        const observations = [offer.factory_evidence, store.evidence, store.sales?.evidence].filter(Boolean);
        const facts = supplierEvidence(observations);
        Object.assign(offer, facts);
        offer.verified =
          offer.identity_confirmed &&
          offer.quote_confirmed &&
          offer.unit_is_piece &&
          facts.factory_status === 'verified';
      }
    } catch (e) {
      if (stopCodes.has(e.code)) {
        gate = e.code;
        interruptedAt = { stage: 'supplier', url: offer.shop_url || offer.url };
      } else failures.push({ url: offer.url, status: 'supplier_profile_unavailable' });
    }
  }
  // Check a company profile only after its offer can enter the first three.
  for (const offer of unknown) {
    const third = rankOffers(manufacturers)[2];
    if (gate || (third && offer.match_confidence_pct < third.match_confidence_pct - 3)) break;
    await checkCompany(offer);
    if (offer.factory_status === 'verified') manufacturers.push(offer);
  }
  const pool = rankOffers(manufacturers, manufacturers.length).sort(
    (a, b) => b.match_confidence_pct - a.match_confidence_pct,
  );
  for (let start = 0; start < Math.min(3, pool.length) && !gate;) {
    let end = start + 1;
    while (end < pool.length && pool[start].match_confidence_pct - pool[end].match_confidence_pct <= 3) end++;
    const band = pool.slice(start, end);
    // A shop-wide sales comparison is meaningful when the products actually look alike.
    // Known sales remain usable at any score. Extra store visits require visual evidence.
    if (band.length > 1 && band[0].match_confidence_pct >= 50) {
      for (const offer of band) {
        if (!offer.factory_sales) await checkCompany(offer);
        if (gate) break;
      }
    }
    start = end;
  }
  const offers = rankOffers(pool.filter((o) => o.factory_status === 'verified'));
  return {
    status: gate
      ? 'interrupted'
      : offers.length
        ? 'ok'
        : inspected.length
          ? 'no_verified_factory_match'
          : 'details_unavailable',
    ...(gate ? { gate, interrupted_at: interruptedAt } : {}),
    offers,
    unverified_suppliers: rankOffers(unknown.filter((o) => o.factory_status === 'unknown')),
    candidates_found: cards.length,
    details_read: inspected.length,
    cached_details: cachedIds.size,
    live_details: inspected.length - cachedIds.size,
    additional_cached_details: [...cachedIds].filter((id) => !selectedIds.has(id)).length,
    variants_compared: compared,
    failures,
    model,
    confidence_method: 'dinov2-sift-attributes-v1',
    checked_at: new Date().toISOString(),
  };
}
