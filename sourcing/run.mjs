import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { channel } from 'node:diagnostics_channel';
import { mkdir } from 'node:fs/promises';
import { runtime, key, readCache, getPhoto, saveJson } from './cache.mjs';
import { openBrowser, stopCodes } from './catalogue.mjs';
import { refreshResultQuotes, sourcePhoto } from './source.mjs';
import { connectSheet } from './sheet.mjs';
import { emit } from '../dist/io/output.js';

export async function runPhotoSourcing(values) {
  process.env.BB1688_HOME ||= dirname(runtime);
  const limit = Number(values.details ?? 12);
  if (!Number.isInteger(limit) || limit < 1 || limit > 60)
    throw Error('--details принимает число от 1 до 60.');
  if (values.rows ? Boolean(values.imagePath) : !values.imagePath || values.write)
    throw Error('Укажите одно изображение либо диапазон --rows.');
  let sheet, rows;
  if (values.rows) {
    const range = /^(\d+)(?::(\d+))?$/.exec(values.rows);
    if (!range) throw Error('Формат диапазона строк: 10:196.');
    sheet = await connectSheet();
    rows = (await sheet.readRows(Number(range[1]), Number(range[2] || range[1]))).filter(
      (r) => r.sku && r.photo_url,
    );
    if (values.priority)
      rows.sort(
        (a, b) => Number(b.row === Number(values.priority)) - Number(a.row === Number(values.priority)),
      );
  } else rows = [{ photo_url: values.imagePath, title: values.title || '' }];
  await mkdir(runtime, { recursive: true });
  const lock = createServer((socket) => socket.destroy());
  const lockKey = key(runtime).slice(0, 18);
  const pipe =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\1688-photo-' + lockKey
      : join(runtime, '.source-' + lockKey + '.sock');
  try {
    await new Promise((ok, bad) => lock.once('error', bad).listen(pipe, ok));
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw Error('Этот профиль уже обрабатывает другую подборку.');
    throw e;
  }
  let context;
  const browser = async () => (context ??= await openBrowser(!values.headless));
  const results = [];
  const started = Date.now();
  const verification = channel('1688.manual-verification');
  let requests = 0;
  const onVerification = () => {
    requests++;
  };
  verification.subscribe(onVerification);
  const report = () => ({
    rows_requested: rows.length,
    rows_processed: results.length,
    elapsed_ms: Date.now() - started,
    verification_requests: requests,
    rows_without_verification: results.filter((r) => r.verification_requests === 0).length,
    results,
  });
  try {
    for (const row of rows) {
      const rowStarted = Date.now(),
        beforeRequests = requests;
      if (row.row) console.error(`Обработка строки ${row.row}`);
      const input = { row: row.row, sku: row.sku, title: row.title, photo_url: row.photo_url };
      let result,
        stage = 'image';
      try {
        const p = await getPhoto(row.photo_url);
        const resultFile = join(
          runtime,
          'results',
          key(JSON.stringify(['sourcing-v4', p.hash, row.title, limit])) + '.json',
        );
        result = await readCache(resultFile);
        if (!result) {
          const previous = await readCache(
            join(
              runtime,
              'results',
              key(JSON.stringify(['sourcing-v1', p.hash, row.title, limit])) + '.json',
            ),
          );
          if (previous?.offers?.[0]?.match_evidence?.graphic_match) result = refreshResultQuotes(previous);
        }
        if (!result) {
          stage = 'source';
          result = await sourcePhoto(browser, p, row.title, { headed: !values.headless, detailLimit: limit });
          if (['ok', 'no_matches', 'no_verified_factory_match'].includes(result.status))
            await saveJson(resultFile, result);
        }
      } catch (e) {
        const message = String(e.message)
          .split('\n')[0]
          .replace(/https?:\/\/\S+/g, '[URL]');
        result = {
          status: stopCodes.has(e.code) ? 'interrupted' : stage === 'image' ? 'image_error' : 'search_error',
          ...(stopCodes.has(e.code) ? { gate: e.code } : {}),
          message,
          offers: [],
        };
      }
      const publishable =
        ['ok', 'no_matches', 'no_verified_factory_match', 'image_error'].includes(result.status) ||
        (result.status === 'interrupted' && result.offers.length > 0);
      if (sheet && values.write && publishable) {
        try {
          result = { ...result, sheet: await sheet.save(input, result) };
        } catch (e) {
          result = { ...result, sheet: 'write_error', sheet_error: e.message };
        }
      }
      results.push({
        ...input,
        ...result,
        duration_ms: Date.now() - rowStarted,
        verification_requests: requests - beforeRequests,
      });
      if (values.output) await saveJson(values.output, sheet ? report() : results[0]);
      if (row.row)
        console.error(
          'Строка ' +
            row.row +
            ' · ' +
            result.status +
            ' · предложений ' +
            result.offers.length +
            ' · ' +
            (result.sheet || 'просмотр'),
        );
      if (result.gate || result.sheet === 'write_error') {
        process.exitCode = 2;
        break;
      }
    }
    if (!values.output || !sheet || values.get || values.pick || values.jsonV2) {
      const data = sheet ? report() : results[0];
      emit({ data, human: () => console.log(JSON.stringify(data, null, 2)) });
    }
    if (
      results.some((r) =>
        ['image_error', 'interrupted', 'search_error', 'details_unavailable'].includes(r.status),
      )
    )
      process.exitCode = 2;
  } finally {
    verification.unsubscribe(onVerification);
    if (context) await context.close().catch(() => {});
    await new Promise((resolve) => lock.close(resolve));
  }
}
