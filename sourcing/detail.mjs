// Читаем видимую карточку или профиль через ту же страницу, что видит закупщик.
export function readOfferUi(mode = 'detail') {
  const visible = (el) => {
    const rect = el?.getBoundingClientRect();
    return rect?.width > 0 && rect.height > 0 && getComputedStyle(el).visibility === 'visible';
  };
  const all = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const first = (root, selector) => all(root, selector)[0];
  const text = (el) => el?.innerText?.trim() || '';
  const body = text(document.body);
  if (
    /\/(punish|captcha)(?:\/|$)/i.test(location.pathname) ||
    /^CAPTCHA Verification$/i.test(document.title) ||
    /请完成安全验证|请拖动滑块|请按住滑块|please drag the slider to verify/i.test(body) ||
    first(document, '#nocaptcha,iframe[src*="/punish" i],iframe[src*="captcha" i]')
  )
    return { status: 'verification_required' };
  if (
    /^(login|passport)\./.test(location.hostname) ||
    first(document, 'input[type=password],iframe[src*="login.1688.com"]')
  )
    return { status: 'login_required' };
  if (!location.hostname.endsWith('.1688.com')) return { status: 'unexpected_page' };
  const sellerEl = first(
    document,
    '.shop-company-name,[class*="companyName"],[class*="company-name"],[class*="shopName"]',
  );
  const seller = text(sellerEl);
  const shopUrl = sellerEl?.closest('a[href]')?.href || sellerEl?.querySelector('a[href]')?.href || null;
  const storeData = all(
    document,
    '.shop-data-item,[class*="business-mode"],[class*="businessMode"],[class*="factory-cert"],[class*="factoryCert"]',
  ).map(text);
  const profileLabels = [
    '工厂档案',
    '公司档案',
    '企业档案',
    '验厂报告',
    '深度验厂',
    '工厂介绍',
    '公司介绍',
    '企业介绍',
    '工厂资质',
    '企业资质',
  ];
  const profileLinks = all(document, 'a[href]')
    .filter((a) => profileLabels.includes(text(a)))
    .sort((a, b) => profileLabels.indexOf(text(a)) - profileLabels.indexOf(text(b)));
  if (mode === 'profile') {
    // Выделяем только области компании и короткие блоки атрибутов с явной подписью.
    const blocks = all(
      document,
      'tr,li,dl,p,[class*="certification"],[class*="businessInfo"],[class*="companyInfo"],[class*="inspection"]',
    );
    const attributes = blocks
      .map(text)
      .filter(
        (t) =>
          t.length <= 180 &&
          /经营模式|经营类型|实地验厂|深度验厂|验厂报告|销售额|成交[金]?额|交易[金]?额|销售量|销量/.test(t),
      );
    for (const el of all(document, 'span,dt,td,th,label,div')) {
      if (el.childElementCount > 1 || !/^(?:经营模式|经营类型)\s*[:：]?$/.test(text(el))) continue;
      for (let parent = el.parentElement, i = 0; parent && i < 3; parent = parent.parentElement, i++) {
        const line = text(parent);
        if (line.length > 100) break;
        if (line !== text(el) && /生产|贸易|经销|商业服务|招商代理/.test(line)) {
          attributes.push(line);
          break;
        }
      }
    }
    const companyLine = body.match(/(?:公司名称|企业名称)\s*[：:]?\s*([^\s：:]{4,50}(?:公司|工厂|厂))/)?.[1];
    return {
      status: 'ok',
      seller,
      company_line: companyLine || null,
      header: body.slice(0, 500),
      store_data: storeData.concat(attributes),
      profile_urls: profileLinks.map((a) => a.href),
    };
  }
  const offerId = /^\/offer\/(\d+)\.html$/.exec(location.pathname)?.[1];
  if (location.hostname !== 'detail.1688.com' || !offerId) return { status: 'unexpected_page' };
  if (/商品已下架|商品已售罄|货品已下架|该商品已删除|商品不存在/.test(body.slice(0, 400)))
    return { status: 'offer_unavailable' };
  const sku = first(document, '#skuSelection');
  const main = first(document, '#mainPrice');
  const title = text(first(document, '#productTitle'));
  if (!sku || !main) return { status: 'detail_unreadable', title, seller };
  const dimensions = all(sku, '.feature-item');
  const rows = all(dimensions.length > 1 ? dimensions.at(-1) : sku, '.expand-view-item');
  const primary = dimensions[0];
  let choices = [];
  if (dimensions.length > 1) {
    const optionSelector =
      '[role="radio"],[role="option"],button,[class*="prop-item"],[class*="propItem"],[class*="sku-item"],[class*="skuItem"],[class*="prop-value"],[class*="propValue"],.expand-view-item,.next-tag';
    const elements = all(primary, optionSelector).filter(
      (el) =>
        !el.parentElement?.closest(optionSelector) ||
        !primary.contains(el.parentElement.closest(optionSelector)),
    );
    choices = elements
      .map((el) => {
        const img = first(el, 'img');
        const label =
          text(first(el, '.item-label')) || el.getAttribute('aria-label') || text(el) || img?.alt || '';
        const cssSelected = Array.from(el.classList).some(
          (c) =>
            /^(?:(?:[\w-]+-)?(?:active|checked|selected)(?:--[\w-]+)?|(?:prop|option|skuItem)(?:Active|Checked|Selected))$/i.test(
              c,
            ) && !/(?:not-|unselected|unchecked|inactive)/i.test(c),
        );
        const selected =
          cssSelected ||
          ['aria-checked', 'aria-selected', 'aria-pressed'].some((a) => el.getAttribute(a) === 'true') ||
          !!el.querySelector('input[type=radio]:checked');
        const disabled =
          el.matches(':disabled,[aria-disabled=true]') || /(?:^|[ -])disabled(?:[ -]|$)/i.test(el.className);
        return { label: label.trim(), image_url: img?.currentSrc || img?.src || null, selected, disabled };
      })
      .filter(
        (c) =>
          c.label && c.label.length < 100 && !/立即下单|购物车|订购|加采购车|领取|联系客服/.test(c.label),
      );
  }
  const variants = rows.map((row, index) => {
    const image = first(row, 'img');
    const priceOrStock = all(row, '.item-price-stock').map(text);
    return {
      id: 'sku-' + (index + 1),
      label: text(first(row, '.item-label')),
      image_url: image?.currentSrc || image?.src || null,
      price_text: priceOrStock.filter((t) => /[¥￥元]/.test(t)).join(' '),
      stock_text: priceOrStock.filter((t) => /库存/.test(t)).join(' '),
      row_text: text(row),
    };
  });
  // Некоторые карточки показывают цвет отдельной осью и раскрывают размеры после выбора.
  // Сохраняем фото осей для ручной проверки, не связывая их с ценой другого размера.
  if (!choices.length && !variants.length) {
    for (const img of all(sku, 'img')) {
      const parent =
        img.closest(
          '[role="radio"],[role="option"],[class*="prop-item"],[class*="propItem"],[class*="sku-item"],[class*="skuItem"]',
        ) || img.parentElement;
      const url = img.currentSrc || img.src;
      if (!url || variants.some((v) => v.image_url === url)) continue;
      const label = (img.alt || text(parent)).trim();
      if (label && label.length < 100)
        variants.push({
          id: 'option-' + (variants.length + 1),
          label,
          image_url: url,
          price_text: '',
          stock_text: '',
          row_text: label,
        });
    }
  }
  return {
    status: 'ok',
    offer_id: offerId,
    title,
    seller,
    shop_url: shopUrl,
    profile_urls: profileLinks.map((a) => a.href),
    store_data: storeData,
    header_price_text: text(main),
    dimensions: dimensions.length,
    choices,
    variants,
  };
}

const quantity = '(\\d[\\d,]*)';
const units = '(件|个|套|条|双|只|台|把|辆|张|枚|块|包|箱|米|千克|公斤|斤|盒|支|本|瓶|卷|根|对)';
const cents = '(\\d+(?:\\.\\d{1,2})?)';
const promo = /券后|首单|首件|新人|到手价|预估价|预估到手|活动到手|定金|订金|预付款|会员价|补贴后/;
const numberText = (str) =>
  str
    .replace(/，/g, ',')
    .replace(/\s*\.\s*/g, '.')
    .replace(/[\t\n\r ]+/g, ' ')
    .trim();
const count = (raw) => (/^\d{1,3}(?:,\d{3})+$|^\d+$/.test(raw) ? Number(raw.replace(/,/g, '')) : NaN);

function uniqueMoney(raw) {
  const normalized = numberText(raw);
  const money = normalized.match(new RegExp('^(?:[¥￥]\\s*' + cents + '|' + cents + '\\s*元)$'));
  if (!money) return null;
  const value = Number(money[1] || money[2]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function minimumOrder(text) {
  const q = new RegExp(
    '(?<![\\d.,-])' +
      quantity +
      '\\s*' +
      units +
      '\\s*起(?:批|订|定)|(?:起订量|起批量)\\s*[：:]?\\s*' +
      quantity +
      '\\s*' +
      units,
    'g',
  );
  const amounts = Array.from(text.matchAll(q), (m) => ({ amount: count(m[1] || m[3]), unit: m[2] || m[4] }));
  if (!amounts.length || !Number.isSafeInteger(amounts[0].amount) || amounts[0].amount < 1) return null;
  return amounts.every((a) => a.amount === amounts[0].amount && a.unit === amounts[0].unit)
    ? amounts[0]
    : null;
}

function headerTiers(header) {
  // 1688 показывает каждую ступень «¥68.00 1000-1999个» либо «¥61 ≥2000个».
  const rows = [];
  const amounts = [...header.matchAll(/[¥￥]\s*\d+(?:\.\d+)?/g)];
  for (let i = 0; i < amounts.length; ++i) {
    const amount = amounts[i];
    const remaining = header.slice(amount.index + amount[0].length, amounts[i + 1]?.index);
    const range = remaining.match(
      new RegExp('^\\s*' + quantity + '\\s*[-~至–]\\s*' + quantity + '\\s*' + units),
    );
    const lower = remaining.match(new RegExp('^\\s*(?:≥|>=)\\s*' + quantity + '\\s*' + units));
    if (!range && !lower) continue;
    const min = count((range || lower)[1]);
    const max = range ? count(range[2]) : Infinity;
    const unit = range ? range[3] : lower[2];
    const price = uniqueMoney(amount[0]);
    if (price && Number.isSafeInteger(min) && min > 0 && max >= min) rows.push({ min, max, unit, price });
  }
  return { rows, amountCount: amounts.length };
}

export function quoteVariant(row, rawHeader, dimensions = 1) {
  const header = numberText(rawHeader || '');
  const evidence = [row.row_text, rawHeader].filter(Boolean).join(' | ');
  const review = (reason) => ({
    price_cny: null,
    min_order: null,
    min_order_unit: null,
    lot_price_cny: null,
    quote_status: 'needs_review',
    quote_reason: reason,
    evidence,
  });
  if (!row.label || dimensions !== 1) return review('variant_combination_unconfirmed');
  // The site also displays a range across SKUs, followed directly by their shared MOQ.
  // A separate first-purchase banner may precede that block. Use only the price on the selected SKU row.
  const range = header.match(
    new RegExp(
      '[¥￥]\\s*' +
        cents +
        '\\s*[~～至–-]\\s*[¥￥]\\s*' +
        cents +
        '\\s+\\d[\\d,]*\\s*' +
        units +
        '\\s*起(?:批|订|定)',
    ),
  );
  const rangePrefix = range ? header.slice(0, range.index).trim() : '';
  const rangeSuffix = range ? header.slice(range.index + range[0].length) : '';
  const separatePromotion = /预估到手(?:单价|价)\s*$/.test(rangePrefix) && !/[~～至–≥]/.test(rangePrefix);
  const skuRange =
    range &&
    (!rangePrefix || separatePromotion) &&
    !promo.test(rangeSuffix) &&
    !/[¥￥]|阶梯|折扣|限时|定金|预付|活动前/.test(rangeSuffix);
  if (
    promo.test(row.row_text) ||
    (promo.test(header) && !skuRange) ||
    /混批|整箱|按箱|多件多折|起批金额|起订金额/.test(header + ' ' + row.row_text)
  )
    return review('conditional_price_or_moq');
  const tiers = headerTiers(header);
  const perUnit = numberText(row.price_text).match(new RegExp('\\s*(?:[/／]|每)\\s*' + units + '\\s*$'));
  const rowTierText = numberText(row.price_text).replace(
    new RegExp('\\s*(?:[/／]|每)\\s*' + units + '\\s*$'),
    '',
  );
  const skuTiers = headerTiers(rowTierText);
  let unitPrice = uniqueMoney(rowTierText);
  let minimum = minimumOrder(header);
  if (!minimum && /(?:起批量|起订量|(?:件|个|套|米|斤|公斤|盒|箱)\s*起(?:批|订|定))/.test(header))
    return review('minimum_order_unconfirmed');
  if (!minimum && tiers.rows.length && tiers.rows.length === tiers.amountCount) {
    const firstTier = [...tiers.rows].sort((a, b) => a.min - b.min)[0];
    minimum = { amount: firstTier.min, unit: firstTier.unit };
  }
  // Вариант может иметь собственную разбивку. Берём его цену, только если подписи
  // явно связывают единственную ступень с тем же минимумом и единицей заказа.
  const rowMin = minimumOrder(numberText(row.row_text));
  minimum ??= rowMin;
  if (!minimum && skuTiers.rows.length && skuTiers.rows.length === skuTiers.amountCount) {
    const starting = [...skuTiers.rows].sort((a, b) => a.min - b.min)[0];
    minimum = { amount: starting.min, unit: starting.unit };
  }
  if (!minimum) return review('minimum_order_unconfirmed');
  if (perUnit && perUnit[1] !== minimum.unit) return review('price_and_order_units_differ');
  if (!unitPrice && skuTiers.rows.length === skuTiers.amountCount) {
    const appliedSku = skuTiers.rows.filter(
      (t) => t.min <= minimum.amount && t.max >= minimum.amount && t.unit === minimum.unit,
    );
    if (appliedSku.length === 1) unitPrice = appliedSku[0].price;
  }
  if (!unitPrice) return review('variant_price_unconfirmed');
  if (skuRange) {
    if (unitPrice < Number(range[1]) || unitPrice > Number(range[2]))
      return review('variant_price_outside_range');
  } else if (tiers.rows.length || tiers.amountCount > 1) {
    const applicable = tiers.rows.filter(
      (t) => t.min <= minimum.amount && t.max >= minimum.amount && t.unit === minimum.unit,
    );
    if (
      tiers.rows.length !== tiers.amountCount ||
      applicable.length !== 1 ||
      applicable[0].price !== unitPrice
    )
      return review('minimum_tier_price_unconfirmed');
  }
  if (rowMin && (rowMin.amount !== minimum.amount || rowMin.unit !== minimum.unit))
    return review('variant_minimum_conflict');
  if (/缺货|售罄|已售完|无货/.test(row.row_text)) return review('insufficient_stock');
  if (row.stock_text) {
    const stock = numberText(row.stock_text).match(
      new RegExp('^库存\\s*[：:]?\\s*' + quantity + '\\s*' + units + '\\s*$'),
    );
    if (!stock || stock[2] !== minimum.unit || !Number.isSafeInteger(count(stock[1])))
      return review('stock_unit_or_amount_unconfirmed');
    if (count(stock[1]) < minimum.amount) return review('insufficient_stock');
  }
  const lotCents = Math.round(unitPrice * 100) * minimum.amount;
  if (!Number.isSafeInteger(lotCents)) return review('unsupported_amount');
  return {
    price_cny: unitPrice,
    min_order: minimum.amount,
    min_order_unit: minimum.unit,
    lot_price_cny: lotCents / 100,
    quote_status: 'verified',
    quote_reason: null,
    evidence,
  };
}

export function restoreQuote(variant) {
  if (
    !['conditional_price_or_moq', 'minimum_tier_price_unconfirmed', 'minimum_order_unconfirmed'].includes(
      variant.quote_reason,
    )
  )
    return variant;
  // Earlier snapshots kept the visible SKU row and page header together. Re-evaluate
  // only complete, uniquely delimited rows. Incomplete observations still need review.
  const parts = variant.evidence?.split(' | ');
  if (parts?.length !== 2) return variant;
  const lines = parts[0]
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines[0] !== variant.label || lines.length < 2 || lines.length > 3 || !uniqueMoney(lines[1]))
    return variant;
  if (lines[2] && !lines[2].startsWith('库存')) return variant;
  const updated = quoteVariant(
    { label: variant.label, row_text: parts[0], price_text: lines[1], stock_text: lines[2] },
    parts[1],
  );
  return updated.quote_status === 'verified' ? { ...variant, ...updated } : variant;
}

export function supplierEvidence(blocks) {
  const texts = blocks.map(numberText);
  const model = texts.find((t) =>
    /(?:经营模式|经营类型)\s*[:：]?\s*(生产厂家|生产加工|生产制造|生产型)/.test(t),
  );
  const inspection = texts.find((t) =>
    /^(?:已通过\s*)?(?:实地验厂|深度验厂|工厂深度验厂|经第三方实地验厂)(?:认证|报告|通过)?$/.test(t),
  );
  const trader = texts.find((t) =>
    /(?:经营模式|经营类型)\s*[:：]?\s*(经销批发|招商代理|经销商|贸易型|商业服务)/.test(t),
  );
  const conflict = Boolean(trader && (model || inspection));
  const factory_status = conflict
    ? 'unknown'
    : trader
      ? 'trader'
      : inspection || model
        ? 'verified'
        : 'unknown';
  let sales = null;
  for (const t of texts) {
    // Валюта, категория (весь магазин/фабрика), период и значение в одном показателе.
    if (
      t.length > 90 ||
      !/店铺|全店|工厂/.test(t) ||
      /单品|本商品|代发|分销|预计|预测|目标|采购额|同比/.test(t)
    )
      continue;
    const period = t.match(/(?:近|最近|过去)\s*(\d+)\s*[天日]/);
    const money = t.match(
      /(?:销售额|成交金?额|交易金?额)(?:[（(][^()（）]{1,18}[)）])?\s*[:：]?\s*([¥￥])?\s*(\d+(?:\.\d+)?)\s*(万|亿)?\s*(元|人民币)?\s*(以上|\+)?\s*$/,
    );
    const pieces = t.match(
      /(?:销售量|销量)(?:[（(][^()（）]{1,18}[)）])?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(万|亿)?\s*件\s*(以上|\+)?\s*$/,
    );
    if (!period || Number(period[1]) < 1 || !((money && (money[1] || money[4])) || pieces)) continue;
    const [, raw, scale, lower] = pieces || [null, money[2], money[3], money[5]];
    const value = Number(raw) * (scale === '万' ? 10000 : scale === '亿' ? 100000000 : 1);
    if (!Number.isFinite(value) || (!money && !Number.isSafeInteger(value))) continue;
    const metric = money ? 'turnover_cny' : 'units_sold';
    const entry = {
      scope: 'factory',
      basis: /全店|店铺/.test(t) ? '1688_store' : 'factory_reported',
      metric,
      period_days: Number(period[1]),
      value,
      bound: lower ? 'at_least' : 'exact',
      evidence: t,
    };
    if (!sales || (sales.metric === 'units_sold' && metric === 'turnover_cny')) sales = entry;
  }
  return {
    factory_status,
    factory_evidence: conflict
      ? [trader, model || inspection].join(' / ')
      : inspection || model || trader || null,
    factory_basis: conflict ? null : inspection ? 'inspection' : model || trader ? 'business_model' : null,
    factory_sales: factory_status === 'verified' ? sales : null,
  };
}

function secondarySignature(ui) {
  return JSON.stringify([
    ui.header_price_text,
    ui.variants.map((v) => [v.label, v.price_text, v.stock_text]),
  ]);
}

function joinedVariants(ui, choice, confirmed) {
  return ui.variants.map((raw, i) => {
    const label = [choice?.label, raw.label].filter(Boolean).join(' / ');
    const image = choice?.image_url || raw.image_url;
    const row = { ...raw, label, row_text: [choice?.label, raw.row_text].filter(Boolean).join(' / ') };
    return {
      id: choice ? 'sku-' + encodeURIComponent(choice.label) + '-' + (i + 1) : raw.id,
      label,
      image_url: image,
      image_scope: choice?.image_url ? 'selected_option' : 'sku_row',
      ...quoteVariant(row, ui.header_price_text, confirmed ? 1 : ui.dimensions),
    };
  });
}

// Один обычный выбор первого свойства (например, цвета). Цена присваивается сочетанию
// с размером только после подтверждения выбора и обновления таблицы второго свойства.
async function choosePrimary(page, label, before) {
  const group = page.locator('#skuSelection .feature-item:visible').first();
  const text = group.getByText(label, { exact: true });
  let target = text;
  if ((await text.count()) !== 1) {
    const radio = group.getByRole('radio', { name: label, exact: true });
    const option = group.getByRole('option', { name: label, exact: true });
    target = (await radio.count()) === 1 ? radio : option;
  }
  if ((await target.count()) !== 1 || !(await target.isVisible())) return null;
  const safe = await target.evaluate(
    (el) =>
      !el.closest('a[href],input[type=submit],button[type=submit],form[action]') &&
      !el.closest('[aria-disabled=true],:disabled'),
  );
  if (!safe) return null;
  const previousRow = await page
    .locator('#skuSelection .feature-item:visible')
    .last()
    .locator('.expand-view-item:visible')
    .first()
    .elementHandle({ timeout: 1000 })
    .catch(() => null);
  try {
    await target.click({ timeout: 2000 });
    let lastSignature = null;
    const deadline = Date.now() + 2200;
    while (Date.now() < deadline) {
      const state = await page.evaluate(readOfferUi);
      if (state.status !== 'ok') return state;
      const checked = state.choices.filter((c) => c.selected);
      const snapshot = secondarySignature(state);
      const changed =
        snapshot !== secondarySignature(before) ||
        (previousRow && !(await previousRow.evaluate((el) => el.isConnected)));
      if (state.variants.length && checked.length === 1 && checked[0].label === label && changed) {
        if (lastSignature === snapshot) return state;
        lastSignature = snapshot;
      } else lastSignature = null;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return null;
  } finally {
    await previousRow?.dispose();
  }
}

async function combinations(page, initial, maxColorChoices) {
  let current = initial;
  const variants = [];
  const pending = [];
  const options = initial.choices.filter((c) => !c.disabled);
  const active = options.filter((c) => c.selected);
  // Сначала используем выбор, с которым открылась карточка. Так он не теряется при переключениях.
  const ordered = active.length === 1 ? [active[0], ...options.filter((c) => c !== active[0])] : options;
  for (const [i, choice] of ordered.entries()) {
    let observed;
    if (i === 0 && active.length === 1) observed = initial;
    else if (i < maxColorChoices && options.filter((c) => c.label === choice.label).length === 1) {
      try {
        observed = await choosePrimary(page, choice.label, current);
      } catch (err) {
        if (!/timeout|detached|not visible/i.test(err.message)) throw err;
      }
    }
    if (observed && observed.status !== 'ok')
      return { status: observed.status, variants, variant_coverage: 'partial' };
    if (observed?.dimensions === 2 && observed.variants.length) {
      variants.push(...joinedVariants(observed, choice, true));
      current = observed;
    } else {
      pending.push(choice.label);
      const row = { label: choice.label, row_text: choice.label, price_text: '' };
      variants.push({
        id: 'option-' + i,
        label: choice.label,
        image_url: choice.image_url,
        image_scope: 'selected_option',
        ...quoteVariant(row, initial.header_price_text, 2),
      });
      if (i < maxColorChoices) {
        current = await page.evaluate(readOfferUi);
        if (current.status !== 'ok') return { status: current.status, variants, variant_coverage: 'partial' };
      }
    }
  }
  return {
    status: 'ok',
    variants,
    variant_coverage: pending.length ? 'partial' : 'complete',
    unresolved_options: pending,
  };
}

export async function readAfterVerification(read, waitForUser, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await read();
  let missed = 0;
  while (snapshot.status === 'verification_required' && waitForUser && Date.now() < deadline) {
    const cleared = await waitForUser(Math.max(1, deadline - Date.now()));
    // A page refresh can clear one widget and load another while reading the SKU.
    // Only the user can clear a visible challenge. Always re-read its result.
    snapshot = await read();
    missed = cleared ? 0 : missed + 1;
    if (missed >= 2) break;
  }
  return snapshot;
}

export async function inspectOffer(page, offer, { maxColorChoices = 12 } = {}) {
  try {
    await page
      .locator(
        '#skuSelection .expand-view-item, #skuSelection img, input[type=password], #nocaptcha, iframe[src*="/punish"], iframe[src*="login.1688.com"]',
      )
      .first()
      .waitFor({ state: 'visible', timeout: 6000 });
  } catch {
    /* Страница может показать заглушку или форму проверки вместо SKU. */
  }
  const ui = await page.evaluate(readOfferUi);
  const result = {
    status: ui.status,
    title: ui.title || offer.title || null,
    seller: ui.seller || offer.seller || null,
    shop_url: ui.shop_url || null,
    profile_urls: ui.profile_urls || [],
    supplier_observations: ui.store_data || [],
    ...supplierEvidence(ui.store_data || []),
    variants: [],
  };
  if (ui.status !== 'ok') return result;
  if (new URL(offer.url).pathname !== '/offer/' + ui.offer_id + '.html')
    return { ...result, status: 'unexpected_offer' };
  if (ui.dimensions === 2 && ui.choices.length)
    Object.assign(result, await combinations(page, ui, maxColorChoices));
  else {
    result.variants = joinedVariants(ui, null, false);
    result.variant_coverage = ui.dimensions > 1 ? 'partial' : 'visible';
  }
  if (!result.variants.length) result.status = 'variants_unreadable';
  return result;
}

function safeStoreUrl(raw, expectedHost) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (
      u.protocol === 'https:' &&
      !u.port &&
      !u.username &&
      !u.password &&
      /^[\w-]+\.1688\.com$/.test(u.hostname) &&
      !/^(www|detail|login|passport|air|s)\./.test(u.hostname) &&
      (!expectedHost || expectedHost === u.hostname)
    )
      return u;
  } catch {
    /* Некорректная ссылка магазина не подтверждает профиль. */
  }
  return null;
}

export async function enrichSupplier(context, detail, manualCheck) {
  const store = safeStoreUrl(detail.shop_url);
  if (!store || !detail.seller) return { ...detail, supplier_check_status: 'profile_unavailable' };
  const page = await context.newPage();
  const evidence = [
    ...(detail.supplier_observations || []),
    detail.factory_evidence,
    detail.factory_sales?.evidence,
  ].filter(Boolean);
  const result = (status) => ({ ...detail, ...supplierEvidence(evidence), supplier_check_status: status });
  try {
    let address = detail.profile_urls?.map((u) => safeStoreUrl(u, store.hostname)).find(Boolean) || store;
    for (let step = 0; step < 2; step++) {
      await page.goto(address.href, { waitUntil: 'commit', timeout: 30000 });
      await page
        .waitForFunction(
          (name) => {
            const text = document.body?.innerText?.replace(/\s+/g, '') || '';
            return (
              text.includes(name) ||
              /请完成安全验证|滑块|验证码/.test(text) ||
              /^(?:login|passport)\./.test(location.hostname)
            );
          },
          detail.seller.replace(/\s+/g, ''),
          { timeout: 4000 },
        )
        .catch(() => {});
      const ui = await readAfterVerification(
        () => page.evaluate(readOfferUi, 'profile'),
        manualCheck && ((remainingMs) => manualCheck(page, remainingMs)),
      );
      if (ui.status !== 'ok') return result(ui.status);
      if (!safeStoreUrl(page.url(), store.hostname)) return result('different_profile');
      const name = detail.seller.replace(/\s+/g, '');
      const sameCompany =
        [ui.seller, ui.company_line].some((s) => s && s.replace(/\s+/g, '') === name) ||
        (name.length >= 5 && ui.header.replace(/\s+/g, '').includes(name));
      if (!sameCompany) return result('company_unconfirmed');
      evidence.push(...ui.store_data);
      const next = ui.profile_urls
        .map((u) => safeStoreUrl(u, store.hostname))
        .find((u) => u && u.pathname !== address.pathname);
      if (!next || address.pathname !== '/') break;
      address = next;
    }
    return result('checked');
  } catch (error) {
    if (error.exitCode != null) throw error;
    return result(error.name === 'TimeoutError' ? 'profile_timeout' : 'profile_read_error');
  } finally {
    await page.close();
  }
}
