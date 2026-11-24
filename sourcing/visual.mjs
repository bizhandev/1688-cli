import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPhoto, runtime } from './cache.mjs';

const ranker = fileURLToPath(new URL('./visual_rank.py', import.meta.url));

async function imagePath(candidate) {
  if (candidate.image_path) return resolve(candidate.image_path);
  const original = new URL(candidate.image_url);
  if (original.protocol === 'http:' && original.hostname.endsWith('.alicdn.com'))
    original.protocol = 'https:';
  if (
    original.hostname.endsWith('.alicdn.com') &&
    /\.(jpg|jpeg|png|webp)_(?:sum|\d+x\d+[^/]*)\.(jpg|webp)$/i.test(original.pathname)
  ) {
    const full = new URL(original);
    full.pathname = full.pathname.replace(
      /(\.(?:jpg|jpeg|png|webp))_(?:sum|\d+x\d+[^/]*)\.(?:jpg|webp)$/i,
      '$1',
    );
    const large = await getPhoto(full.href).catch(() => null);
    if (large) return large.path;
  }
  return (await getPhoto(original.href)).path;
}

export async function scoreImages(query, candidates) {
  const files = new Map(),
    inputs = [],
    result = [];
  for (let i = 0; i < candidates.length; i += 5) {
    await Promise.all(
      candidates.slice(i, i + 5).map(async (c) => {
        const id = c.image_path || c.image_url;
        if (!id) return;
        if (!files.has(id)) files.set(id, imagePath(c));
        try {
          inputs.push({ id: c.id, path: await files.get(id) });
        } catch {
          result.push({ id: c.id, score: null, error: 'image_unavailable' });
        }
      }),
    );
  }
  if (!inputs.length) return { model: null, scores: result };
  const uniquePaths = [...new Set(inputs.map((item) => item.path))].map((path) => ({ id: path, path }));
  const output = await new Promise((accept, reject) => {
    const child = spawn(process.env.PYTHON || 'python', [ranker], {
      windowsHide: true,
      timeout: 300000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let data = '',
      error = '';
    child.stdout.setEncoding('utf8').on('data', (s) => {
      data += s;
    });
    child.stderr.setEncoding('utf8').on('data', (s) => {
      error += s;
    });
    child.once('error', reject);
    child.stdin.on('error', (e) => {
      if (e.code !== 'EPIPE') reject(e);
    });
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(error.trim() || 'Модель прервала вычисление.'));
      try {
        accept(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify({ query, candidates: uniquePaths, cache: runtime }));
  });
  const byPath = new Map(output.scores.map((s) => [s.id, s]));
  return {
    model: output.model,
    scores: [...inputs.map((item) => ({ ...byPath.get(item.path), id: item.id })), ...result],
  };
}
