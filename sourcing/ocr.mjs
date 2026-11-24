import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const converter = fileURLToPath(new URL('./visual_rank.py', import.meta.url));

function confidentLines(tsv) {
  const rows = new Map();
  for (const word of tsv
    .trim()
    .split('\n')
    .map((line) => line.split('\t'))) {
    if (word[0] !== '5' || !word[11]?.trim()) continue;
    const key = word.slice(1, 5).join('/');
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ text: word[11].trim(), confidence: Number(word[10]) });
  }
  // Keep or discard the whole line, including possible words of negation.
  const lines = new Set();
  for (const words of rows.values()) {
    if (words.every((word) => word.confidence >= 65)) {
      lines.add(words.map((word) => word.text).join(' '));
    }
  }
  return [...lines].join('\n');
}

// Each call uses only local language files, WASM and Pillow. Running once per
// source is sufficient: all offers for the row share these requirements.
export async function readPhotoText(localPath, { python = process.env.PYTHON || 'python' } = {}) {
  let languages;
  let worker;
  try {
    const { stdout: png } = await execute(python, [converter, '--ocr-png', localPath], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    });
    const { createWorker, OEM, PSM } = require('tesseract.js');
    languages = await mkdtemp(join(tmpdir(), '1688-ocr-'));
    for (const language of ['rus', 'eng']) {
      const file = language + '.traineddata.gz';
      const languageModule = require.resolve('@tesseract.js-data/' + language);
      await copyFile(join(dirname(languageModule), '4.0.0_best_int', file), join(languages, file));
    }
    // Tesseract also rejects its promise for job errors. Suppress its extra
    // uncaught exception so a bad image can return an unavailable status.
    worker = await createWorker('rus+eng', OEM.LSTM_ONLY, {
      langPath: languages,
      cacheMethod: 'none',
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, user_defined_dpi: '300' });
    const { data } = await worker.recognize(png, {}, { text: true, tsv: true });
    return { status: 'ok', text: confidentLines(data.tsv), confidence: data.confidence };
  } catch (error) {
    return { status: 'unavailable', text: '', message: String(error.message || error) };
  } finally {
    if (worker) await worker.terminate();
    if (languages) await rm(languages, { recursive: true, force: true });
  }
}
