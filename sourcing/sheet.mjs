import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { key, readCache, saveJson, runtime } from './cache.mjs';

const label = new Map(
  Object.entries({
    sku_size_unconfirmed: 'размер варианта требует сверки',
    sku_kit_unconfirmed: 'комплектация не подтверждена',
    reinforced_inner_tube_unconfirmed: 'усиленная камера не подтверждена',
    sku_images_ambiguous: 'одно фото у нескольких вариантов',
    sku_design_nondeterministic: 'продавец выбирает рисунок случайно',
    colour_unconfirmed: 'цвет требует сверки',
    print_unconfirmed: 'рисунок требует сверки',
    shape_unconfirmed: 'форма требует сверки',
    sku_model_unconfirmed: 'модель требует сверки',
    source_dimensions_ambiguous: 'на исходном фото несколько размеров',
  }),
);
const statusText = {
  no_matches: '1688 сообщил, что совпадений нет.',
  image_error: 'Исходное фото недоступно.',
  no_verified_factory_match:
    'Среди проверенных вариантов не найдено подходящего предложения подтверждённой фабрики.',
  details_unavailable: 'Не удалось прочитать варианты в карточках 1688.',
};
const num = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
const marker = 'Подбор 1688 по фото';
const present = (cell) => !!cell.userEnteredValue || !!cell.effectiveValue;
const valueOf = (c) =>
  String(c?.effectiveValue?.stringValue ?? c?.effectiveValue?.numberValue ?? c?.formattedValue ?? '').trim();
const cellSignature = (c) =>
  JSON.stringify([
    c.userEnteredValue ?? null,
    (c.textFormatRuns ?? []).map((r) => [r.startIndex ?? 0, r.format?.link?.uri ?? '']),
    c.note ?? '',
  ]);
const sameSource = (a, b) => ['sku', 'photo_url', 'title'].every((k) => String(a[k]) === String(b[k]));

export function sheetValues(result) {
  const offers = result.offers || [],
    runs = [],
    items = [],
    notes = [],
    quotes = [];
  if (
    offers.length > 3 ||
    new Set(offers.map((o) => o.url)).size !== offers.length ||
    new Set(offers.map((o) => o.seller?.replace(/\s+/g, ''))).size !== offers.length
  )
    throw Error('Требуются разные фабрики, максимум три.');
  for (const [index, o] of offers.entries()) {
    if (
      !/^https:\/\/detail\.1688\.com\/offer\/\d+\.html$/.test(o.url) ||
      !Number.isInteger(o.match_confidence_pct) ||
      o.match_confidence_pct < 0 ||
      o.match_confidence_pct > 100 ||
      o.factory_status !== 'verified'
    )
      throw Error('Некорректный результат фабрики.');
    const tag = o.identity_confirmed ? 'совпадение' : 'проверить';
    const line = index + 1 + '. ' + o.match_confidence_pct + '% · ' + tag + ' · ' + o.seller;
    const start = items.reduce((n, s) => n + s.length + 1, 0);
    runs.push({ startIndex: start, format: { link: { uri: o.url } } });
    items.push(line);
    const why = (o.match_evidence?.unresolved || []).map((r) => label.get(r) || r).join(', ');
    const sales = o.factory_sales?.evidence || 'оборот за сопоставимый период не опубликован';
    const variant = o.variant || 'вариант в карточке не указан';
    notes.push(
      [
        line,
        o.variant ? 'Вариант: ' + o.variant : 'Вариант в карточке не указан.',
        o.url,
        o.match_evidence?.scope === 'listing' && 'Сходство оценено по основной фотографии объявления.',
        why,
        'Фабрика: ' + o.factory_evidence,
        'Продажи: ' + sales,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    const valid =
      o.quote_confirmed &&
      Number.isFinite(o.unit_price_cny) &&
      o.unit_price_cny > 0 &&
      Number.isSafeInteger(o.min_order) &&
      o.min_order > 0 &&
      Number.isFinite(o.lot_price_cny) &&
      Math.abs(o.unit_price_cny * o.min_order - o.lot_price_cny) < 0.011;
    if (o.quote_confirmed && !valid) throw Error('Цена партии не совпадает с ценой варианта и MOQ.');
    quotes.push(
      index +
        1 +
        '. ' +
        variant +
        ' — ' +
        (valid
          ? num(o.unit_price_cny) +
            ' ¥ × ' +
            num(o.min_order) +
            ' ' +
            o.min_order_unit +
            ' = ' +
            num(o.lot_price_cny) +
            ' ¥ за партию без доставки.'
          : 'проверенной цены при минимальном заказе нет.'),
    );
  }
  const t = {
    note: [
      marker,
      ...(result.status === 'interrupted'
        ? ['Частичный подбор. 1688 приостановил проверку остальных предложений.']
        : []),
      ...(notes.length ? notes : [statusText[result.status] || 'Требуется проверка.']),
      ...(result.status === 'image_error' && /\bHTTP \d{3}\b/.test(result.message || '')
        ? [result.message.match(/\bHTTP \d{3}\b/)[0]]
        : []),
      'Проценты оценивают сходство выбранного варианта. Шкала модели не калибрована как вероятность.',
    ].join('\n\n'),
  };
  if (items.length)
    Object.assign(t, { userEnteredValue: { stringValue: items.join('\n') }, textFormatRuns: runs });
  const u = {
    note: [
      marker,
      ...quotes,
      offers[0]?.verified
        ? 'В ячейке цена одной единицы первого варианта при минимальном заказе.'
        : 'Числовая цена для расчёта появится при подтверждении соответствия первого варианта и цены при MOQ.',
    ].join('\n'),
  };
  if (offers[0]?.verified && offers[0].quote_confirmed && offers[0].unit_is_piece)
    u.userEnteredValue = { numberValue: offers[0].unit_price_cny };
  return { t, u };
}

async function googleClient(config) {
  const { GoogleAuth, JWT } = await import('google-auth-library');
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  if (!config.auth?.dotenv) {
    return new GoogleAuth({ scopes, ...(config.auth?.file ? { keyFilename: config.auth.file } : {}) });
  }
  const text = await readFile(config.auth.dotenv, 'utf8');
  const name = config.auth.variable;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw Error('Недопустимое имя переменной конфигурации.');
  const line = text.split(/\r?\n/).find((l) => l.slice(0, l.indexOf('=')).trim() === name);
  if (!line) throw Error('В указанном env-файле нет переменной сервисного аккаунта.');
  const stored = line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
  const data = JSON.parse(stored.startsWith('{') ? stored : Buffer.from(stored, 'base64').toString('utf8'));
  if (data.type !== 'service_account') throw Error('Ожидался JSON сервисного аккаунта Google.');
  return new JWT({ email: data.client_email, key: data.private_key, scopes });
}

export async function connectSheet(
  configPath = process.env.BB1688_SHEET_CONFIG || join(runtime, 'sheet-config.json'),
) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!/^[\w-]+$/.test(config.spreadsheetId) || !Number.isSafeInteger(config.sheetId))
    throw Error('Не задан идентификатор таблицы или вкладки.');
  const auth = await googleClient(config);
  const endpoint = 'https://sheets.googleapis.com/v4/spreadsheets/' + config.spreadsheetId;
  const request = async (suffix, body) => {
    try {
      return (
        await auth.request({
          url: endpoint + suffix,
          method: 'POST',
          data: body,
          timeout: 30000,
          retry: false,
        })
      ).data;
    } catch (e) {
      const status = e.response?.status;
      throw Object.assign(
        Error(
          `Google Sheets, HTTP ${status || 'network'} (${e.response?.data?.error?.status || 'connection'})`,
        ),
        {
          transient: !status || status === 408 || status === 429 || status >= 500,
        },
      );
    }
  };
  const range = (first, last, c1, c2) => ({
    sheetId: config.sheetId,
    startRowIndex: first - 1,
    endRowIndex: last,
    startColumnIndex: c1,
    endColumnIndex: c2,
  });
  async function readRows(first, last = first) {
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 10 || last < first)
      throw Error('Некорректные строки.');
    const ranges = [
      range(7, 7, 1, 5),
      range(7, 7, 19, 21),
      range(first, last, 1, 5),
      range(first, last, 19, 21),
    ];
    const fields =
      'sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,note,dataValidation,textFormatRuns))))';
    const response = await request(':getByDataFilter?fields=' + encodeURIComponent(fields), {
      dataFilters: ranges.map((gridRange) => ({ gridRange })),
      includeGridData: true,
    });
    const sheet = response.sheets?.find((s) => s.properties.sheetId === config.sheetId);
    if (!sheet) throw Error('Целевая вкладка не найдена.');
    const cells = new Map();
    for (const g of sheet.data || [])
      for (const [r, row] of (g.rowData || []).entries())
        for (const [c, cell] of (row.values || []).entries())
          cells.set(g.startRow + r + 1 + ',' + (g.startColumn + c), cell);
    const get = (r, c) => cells.get(r + ',' + c) ?? {};
    const headers = [
      'Фото URL',
      'Название Товара',
      'SKU (Артикул WB)',
      'Фабрика 1 (1688 ссылка)',
      'Цена Закупки 1 ед, юань (0% скидка)',
    ];
    if (![1, 3, 4, 19, 20].every((c, i) => valueOf(get(7, c)).replace(/\s+/g, ' ') === headers[i]))
      throw Error('Заголовки исходных и целевых столбцов изменились.');
    return Array.from({ length: last - first + 1 }, (_, i) => {
      const row = i + first;
      return {
        row,
        sku: valueOf(get(row, 4)),
        title: valueOf(get(row, 3)),
        photo_url: valueOf(get(row, 1)),
        t: get(row, 19),
        u: get(row, 20),
      };
    });
  }
  async function save(snapshot, result) {
    const row = snapshot.row;
    const [live] = await readRows(row);
    if (!sameSource(snapshot, live)) return 'source_changed';
    if (live.t.dataValidation || live.u.dataValidation) return 'validation_changed';
    const receiptFile = join(
      runtime,
      'receipts',
      key(config.spreadsheetId + '/' + config.sheetId + '/' + row) + '.json',
    );
    let receipt = await readCache(receiptFile, Infinity);
    if (
      receipt?.pending &&
      sameSource(receipt, snapshot) &&
      receipt.pending.t === cellSignature(live.t) &&
      receipt.pending.u === cellSignature(live.u)
    ) {
      receipt = { ...receipt, ...receipt.pending, pending: null };
      await saveJson(receiptFile, receipt);
    }
    const owned =
      receipt &&
      sameSource(receipt, snapshot) &&
      receipt.t === cellSignature(live.t) &&
      receipt.u === cellSignature(live.u);
    if (!owned && (present(live.t) || present(live.u))) return 'occupied';
    if (
      owned &&
      present(live.t) &&
      (result.status === 'image_error' ||
        (result.status === 'interrupted' && (present(live.u) || receipt.status === 'ok')))
    )
      return 'kept_previous';
    const cells = sheetValues(result);
    for (const c of ['t', 'u']) {
      const old = live[c].note || '';
      const initial = owned ? receipt.original[c] : old;
      if (initial) cells[c].note = initial + '\n\n' + cells[c].note;
    }
    const matches =
      cellSignature(cells.t) === cellSignature(live.t) && cellSignature(cells.u) === cellSignature(live.u);
    if (matches) return 'already_saved';
    const original = owned ? receipt.original : { t: live.t.note || '', u: live.u.note || '' };
    const snapshotReceipt = {
      sku: snapshot.sku,
      title: snapshot.title,
      photo_url: snapshot.photo_url,
      original,
      status: result.status,
      t: cellSignature(live.t),
      u: cellSignature(live.u),
    };
    await saveJson(receiptFile, {
      ...snapshotReceipt,
      pending: { t: cellSignature(cells.t), u: cellSignature(cells.u) },
    });
    const requests = ['t', 'u'].map((c, i) => ({
      updateCells: {
        range: range(row, row, 19 + i, 20 + i),
        rows: [{ values: [cells[c]] }],
        fields: c === 't' ? 'userEnteredValue,textFormatRuns,note' : 'userEnteredValue,note',
      },
    }));
    await request(':batchUpdate', { requests });
    const [check] = await readRows(row);
    if (
      !sameSource(snapshot, check) ||
      cellSignature(check.t) !== cellSignature(cells.t) ||
      cellSignature(check.u) !== cellSignature(cells.u)
    )
      throw Error('Строка ' + row + ' изменилась во время записи или контрольное чтение не совпало.');
    await saveJson(receiptFile, { ...snapshotReceipt, t: cellSignature(check.t), u: cellSignature(check.u) });
    return 'saved';
  }
  async function retryTransient(operation) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!error.transient || attempt >= 2) throw error;
        await delay(1500 * 2 ** attempt);
      }
    }
  }
  return {
    config,
    readRows: (first, last) => retryTransient(() => readRows(first, last)),
    save: (snapshot, result) => retryTransient(() => save(snapshot, result)),
  };
}
