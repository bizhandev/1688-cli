const tubing = /тюбинг|ватрушк|snow\s*tub(?:e|ing)|滑雪圈/iu;
const car = /машинк|в виде машины|авто(?!мат)|тачк|гоночн|赛车|汽车|小车|车形|car[-\s]?shaped/iu;
const colours = {
  blue: /(?<![\p{L}])(?:син(?:ий|яя|ее|ие|юю|ег|ей|им)|голуб|blue\b)|蓝/iu,
  red: /(?<![\p{L}])(?:красн|red\b)|红/iu,
  black: /(?<![\p{L}])(?:ч[её]рн|black\b)|黑/iu,
  white: /(?<![\p{L}])(?:бел(?:ый|ая|ые|ое|ую|ой|ы[мх]|ог)|white\b)|白/iu,
  green: /(?<![\p{L}])(?:зел[её]н|green\b)|绿/iu,
  yellow: /(?<![\p{L}])(?:ж[её]лт|yellow\b)|黄/iu,
  orange: /(?<![\p{L}])(?:оранж|orange\b)|橙|橘色/iu,
  pink: /(?<![\p{L}])(?:розов|pink\b)|粉/iu,
  purple: /(?<![\p{L}])(?:фиолет|сиренев|purple\b)|紫/iu,
  grey: /(?<![\p{L}])(?:сер(?:ый|ая|ое|ые|ую|ог|ой|ы[мх])|gr[ae]y\b)|灰/iu,
  brown: /(?<![\p{L}])(?:коричнев|brown\b)|棕|咖啡色/iu,
};
const prints = {
  smileys: /смайл|笑脸|smileys?/iu,
  snowmen: /снеговик|雪人|snowm[ae]n/iu,
  unicorns: /единорог|独角兽|unicorn/iu,
  dinosaurs: /динозавр|恐龙|dinosaur/iu,
  camouflage: /камуфляж|迷彩|camouflage/iu,
  rainbow: /радуг|радужн|彩虹|rainbow/iu,
};
const shapes = {
  round: /кругл|圆形|(?<![a-z])round\b/u,
  square: /квадратн|正方形|(?<![a-z])square\b/u,
  rectangular: /прямоугольн|长方形|rectangular/u,
  heart: /в форме сердца|心形|heart[-\s]?shaped/u,
};

function normalize(text) {
  return (text || '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е');
}

function terms(text, dictionary) {
  // 粉红 and 橘黄 are single colours, not a list of two colours.
  text = text.replace(/粉红/g, '粉').replace(/橘黄/g, '橙');
  return Object.entries(dictionary)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

// A model code can distinguish otherwise identical photos of electronics,
// tools or spare parts. Certification and material grades apply to many goods.
function modelCodes(text) {
  const tokens =
    text.match(
      /(?<![\p{L}\p{N}])(?:[a-z]{2,8}-\d[a-z\d-]{1,16}|[a-z]{2,8}\d{2,7}(?:-[a-z\d]{1,8})?)(?![\p{L}\p{N}])/gu,
    ) || [];
  return [
    ...new Set(
      tokens.filter(
        (token) => !/^(iso|din|pvc|pp|ip|ce|en|ral|gb|led|rgb|hd|uhd|usb|pc|pa|pe|pet)[-]?\d/u.test(token),
      ),
    ),
  ];
}

function sizes(text, isTube, sku = false) {
  const numbers = new Set();
  const push = (raw) => numbers.add(Number(raw.replace(',', '.')));
  for (const m of text.matchAll(/(?<![\d.,])(\d{1,3}(?:[.,]\d+)?)\s*(?:[сc][мm]|厘米|公分)/giu)) push(m[1]);
  // A rectangular 95×105 cm seat or a list of sizes is not a 100 cm diameter.
  for (const m of text.matchAll(/(?<![\d.,])(\d{2,3})\s*[xх×*]\s*(\d{2,3})(?!\d)/gu)) {
    push(m[1]);
    push(m[2]);
  }
  for (const m of text.matchAll(/(?<!\d)(\d{2,3}(?:\s*[/–—~-]\s*\d{2,3})+)\s*(?:[сc][мm]|厘米|公分)/gu)) {
    for (const n of m[1].match(/\d+/g)) push(n);
  }
  if (isTube && sku) {
    for (const m of text.matchAll(
      /(?:花色|直径|диаметр|оксфорд)\s*(\d{2,3})(?![\d.,])|(?<!\d)(\d{2,3})\s*(?:#|号)/gu,
    ))
      push(m[1] || m[2]);
    for (const axis of text.split('/')) {
      if (/^\s*\d{2,3}\s*$/.test(axis)) push(axis.trim());
    }
  }
  return [...numbers];
}

export function tubeVariants(variants) {
  const readings = variants.map((v) => sizes(normalize(v.label), true, true));
  const range = readings.filter((a) => a.length === 1 && a[0] >= 50 && a[0] <= 200).flat();
  if (new Set(range).size < 2) return variants;
  const low = Math.min(...range),
    high = Math.max(...range);
  return variants.map((variant, i) => {
    if (readings[i].length) return variant;
    const end = normalize(variant.label).match(/(?:^|[-\s])([а-я]{3,})(\d{2,3})$/u);
    if (!end || /^(?:модель|серия|арт|код|тип)$/.test(end[1])) return variant;
    const size = Number(end[2]);
    return size >= low && size <= high && size % 5 === 0
      ? { ...variant, catalogue_diameter_cm: size }
      : variant;
  });
}

function kit(text) {
  const excluded =
    /без\s+(?:резиновой\s+|усиленной\s+)?камер|камер[ауы]?\s+(?:в\s+комплект\s+)?не\s+входит|камера\s+отдельно|(?:不含|不带|无)\s*(?:加厚|加强|橡胶)*内胎|单外套|仅外套|内胎另购/u.test(
      text,
    );
  const reinforced =
    /усиленн[а-я]*\s+(?:резинов[а-я]*\s+)?камер|камер[а-я]*\s+усиленн|(?:加厚|加强|增强)(?:型|橡胶|耐寒)*内胎|内胎(?:加厚|加强|增强)/u.test(
      text,
    );
  const included =
    reinforced ||
    /с\s+(?:резиновой\s+)?камерой|камер[ауы]?\s+(?:идет\s+)?в\s+комплект|(?:含|带|配|[+＋])\s*(?:橡胶|加厚|加强|普通)*内胎|内外胎套装/u.test(
      text,
    );
  return {
    state: excluded ? 'excluded' : included ? 'included' : null,
    reinforced,
    standard: /обычн[а-я]*\s+камер|стандартн[а-я]*\s+камер|普通内胎|标准内胎/u.test(text),
  };
}

export function photoRequirements(description = '', ocr = {}) {
  const text = normalize([description, ocr.text || ''].join('\n'));
  const sourceKit = kit(text);
  // OCR can split the inner-tube description across lines on the packaging.
  const fragment = /^\s*с\s+усиленной\s*$/mu.test(text) && /камер[а-я]*/u.test(text);
  const expectedColours = terms(text, colours);
  const tube = tubing.test(text);
  return {
    tube,
    sizes_cm: sizes(text, tube),
    inner_tube: sourceKit.state || (fragment ? 'included' : null),
    reinforced_inner_tube: sourceKit.state !== 'excluded' && (sourceKit.reinforced || fragment),
    car_shape: tube && car.test(text),
    colours: expectedColours,
    blue: expectedColours.includes('blue'),
    prints: terms(text, prints),
    shapes: terms(text, shapes),
    model_codes: modelCodes(text),
    ocr_status: ocr.status || 'unavailable',
    ocr_has_text: Boolean(ocr.text?.trim()),
  };
}

export function compareLabel(req, variant) {
  const label = normalize(variant.label);
  const reasons = [];
  const reject = (rejected) => ({ rejected, reasons });
  if (req.tube && /打气筒|脚踏泵|气泵|修补包|насос|^(?:橡胶)?内胎$|^камера$/u.test(label))
    return reject('accessory');
  if (
    /随机|颜色混发|款式混发|случайн[а-я]*\s+(?:цвет|рисунок)|цвет\s+(?:в ассортименте|случайн)/u.test(label)
  ) {
    reasons.push('sku_design_nondeterministic');
  }
  const dimensions = sizes(label, req.tube, true);
  if (req.tube && !dimensions.length && variant.catalogue_diameter_cm)
    dimensions.push(variant.catalogue_diameter_cm);
  if (req.sizes_cm.length === 1) {
    if (dimensions.length && !dimensions.includes(req.sizes_cm[0])) return reject('wrong_size');
    if (dimensions.length !== 1) reasons.push('sku_size_unconfirmed');
  } else if (req.sizes_cm.length > 1) reasons.push('source_dimensions_ambiguous');

  const optionKit = kit(label);
  if (req.inner_tube && optionKit.state && req.inner_tube !== optionKit.state) return reject('wrong_kit');
  if (req.reinforced_inner_tube && optionKit.standard && !optionKit.reinforced)
    return reject('wrong_inner_tube');
  if (req.inner_tube && !optionKit.state) reasons.push('sku_kit_unconfirmed');
  if (req.reinforced_inner_tube && !optionKit.reinforced) reasons.push('reinforced_inner_tube_unconfirmed');

  const expectedColours = req.colours ?? (req.blue ? ['blue'] : []);
  const observedColours = terms(label, colours);
  if (
    expectedColours.length &&
    observedColours.length &&
    !expectedColours.some((c) => observedColours.includes(c))
  )
    return reject('wrong_colour');
  if (expectedColours.some((c) => !observedColours.includes(c))) reasons.push('colour_unconfirmed');
  const expectedPrints = req.prints || [];
  const observedPrints = terms(label, prints);
  if (
    expectedPrints.length &&
    observedPrints.length &&
    !expectedPrints.some((p) => observedPrints.includes(p))
  )
    return reject('wrong_print');
  if (expectedPrints.some((p) => !observedPrints.includes(p))) reasons.push('print_unconfirmed');
  if (req.car_shape && !car.test(label)) reasons.push('shape_unconfirmed');
  const expectedShapes = req.shapes || [];
  const observedShapes = terms(label, shapes);
  if (
    expectedShapes.length &&
    observedShapes.length &&
    !expectedShapes.some((s) => observedShapes.includes(s))
  )
    return reject('wrong_shape');
  if (expectedShapes.some((s) => !observedShapes.includes(s))) reasons.push('shape_unconfirmed');
  const expectedModels = req.model_codes || [];
  if (expectedModels.length) {
    const models = modelCodes(label);
    for (const expected of expectedModels) {
      if (models.includes(expected)) continue;
      const series = expected.match(/^[a-z]+/)[0];
      if (models.some((model) => model.match(/^[a-z]+/)[0] === series)) return reject('wrong_model');
      reasons.push('sku_model_unconfirmed');
      break;
    }
  }
  return { reasons };
}

function imageKey(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = '';
    url.searchParams.delete('x-oss-process');
    if (url.hostname.endsWith('.alicdn.com'))
      url.pathname = url.pathname.replace(/(\.(?:jpe?g|png|webp))_\d+x\d+[^/]*$/i, '$1');
    return url.href;
  } catch {
    return raw;
  }
}

export function competingOptions(req, offer, variant, score, siblingScores) {
  const photo = imageKey(variant.image_url);
  return (offer.variants || []).some((other) => {
    if (other === variant || (other.id != null && other.id === variant.id)) return false;
    const sibling = siblingScores?.get(other.id);
    const similarScore =
      Number.isFinite(score) && Number.isFinite(sibling) && Math.abs(sibling - score) <= 0.01;
    if (!(photo && photo === imageKey(other.image_url)) && !similarScore) return false;
    // A shared picture can legitimately cover multiple sizes when the selected
    // label explicitly proves the size and the other label explicitly excludes it.
    return !compareLabel(req, other).rejected;
  });
}

function identities(offer) {
  const values = [];
  if (offer.seller?.trim()) values.push('name:' + normalize(offer.seller).replace(/\s+/g, ''));
  if (offer.url) values.push('offer:' + offer.url.split(/[?#]/)[0]);
  if (offer.shop_url) {
    try {
      const shop = new URL(offer.shop_url).hostname.toLowerCase();
      if (/^[\w-]+\.1688\.com$/.test(shop) && !/^(www|detail|air|s|login|passport)\./.test(shop))
        values.push('shop:' + shop);
    } catch {
      /* A malformed shop link cannot identify a factory. */
    }
  }
  return values;
}

function comparableKey(offer) {
  const m = offer.factory_sales;
  if (
    offer.factory_status !== 'verified' ||
    !m ||
    m.scope !== 'factory' ||
    m.bound !== 'exact' ||
    !['turnover_cny', 'units_sold'].includes(m.metric) ||
    !Number.isSafeInteger(m.period_days) ||
    m.period_days < 1 ||
    !Number.isFinite(m.value) ||
    m.value < 0
  )
    return null;
  const basis = m.basis || (/全店|店铺/.test(m.evidence || '') ? '1688_store' : 'factory_reported');
  return basis + '/' + m.metric + '/' + m.period_days;
}

function compareSales(band) {
  const groups = new Map();
  for (const [index, offer] of band.entries()) {
    const key = comparableKey(offer);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  for (const slots of groups.values()) {
    if (slots.length < 2) continue;
    const sorted = slots.map((i) => band[i]).sort((a, b) => b.factory_sales.value - a.factory_sales.value);
    slots.forEach((slot, i) => {
      band[slot] = { ...sorted[i], sales_compared: true };
    });
  }
  return band;
}

export function rankOffers(items, limit = 3) {
  const sorted = [...items].sort(
    (a, b) =>
      b.match_confidence_pct - a.match_confidence_pct ||
      (b.visual_score ?? -1) - (a.visual_score ?? -1) ||
      a.search_rank - b.search_rank,
  );
  const seen = new Set();
  const distinct = sorted.filter((offer) => {
    const keys = identities(offer);
    const duplicate = keys.some((key) => seen.has(key));
    if (!duplicate) for (const key of keys) seen.add(key);
    return !duplicate;
  });
  const ranked = [];
  for (let start = 0; start < distinct.length && ranked.length < limit;) {
    const first = distinct[start];
    let end = start + 1;
    while (end < distinct.length && first.match_confidence_pct - distinct[end].match_confidence_pct <= 3)
      end++;
    const band = distinct.slice(start, end).map((o) => ({ ...o, sales_compared: false }));
    ranked.push(...compareSales(band));
    start = end;
  }
  return ranked.slice(0, limit);
}
