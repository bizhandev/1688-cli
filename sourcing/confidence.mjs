// An interpretable 0–100 identity score. Commercial evidence is kept separate.
export function visualConfidence(image) {
  if (!Number.isFinite(image?.score)) return null;
  if (image.same_visual_design) return 99;
  const semantic = Math.round(80 * Math.max(0, Math.min(1, (image.score - 0.2) / 0.7)));
  const broad = image.inliers >= 12 && image.source_coverage >= 0.02 && image.target_coverage >= 0.01;
  const local = image.inliers >= 9 && image.source_coverage >= 0.012 && image.target_coverage >= 0.0015;
  if (broad) return Math.max(semantic, Math.min(97, 87 + Math.floor(image.inliers / 5)));
  if (local) return Math.max(semantic, Math.min(89, 78 + Math.floor(image.inliers / 4)));
  return semantic;
}

export function identityConfidence(image, reasons, { listingOnly = false } = {}) {
  let score = visualConfidence(image);
  if (score === null) return null;
  const visualConfirmed =
    image.same_visual_design ||
    (image.inliers >= 9 && image.source_coverage >= 0.012 && image.target_coverage >= 0.0015);
  const unresolved = [...new Set(reasons)].filter(
    (reason) =>
      !(visualConfirmed && ['colour_unconfirmed', 'print_unconfirmed', 'shape_unconfirmed'].includes(reason)),
  );
  if (listingOnly) score = Math.min(score, 59);
  if (
    unresolved.some((r) =>
      [
        'sku_images_ambiguous',
        'sku_design_nondeterministic',
        'sku_model_unconfirmed',
        'sku_size_unconfirmed',
        'source_dimensions_ambiguous',
      ].includes(r),
    )
  )
    score = Math.min(score, 69);
  if (unresolved.length) score = Math.min(score, 79);
  return {
    percent: score,
    unresolved,
    design_confirmed: visualConfirmed,
    identity_confirmed: score >= 85 && !unresolved.length && !listingOnly,
  };
}
