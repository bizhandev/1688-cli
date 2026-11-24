import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { preparePhoto } from './photo.mjs';

export const runtime = join(
  process.env.BB1688_HOME ||
    join(process.env.LOCALAPPDATA || homedir(), 'BizhanRuntime', 'marketplaces', '1688-cli'),
  'sourcing',
);
export const key = (text) => createHash('sha256').update(text).digest('hex');

export async function readCache(file, hours = 24) {
  try {
    if (Date.now() - (await stat(file)).mtimeMs > hours * 3600_000) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function saveJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function cachedPhoto(source) {
  const record = await readCache(join(runtime, 'photos', key(source) + '.json'));
  return record && (await stat(record.path).catch(() => null)) ? record : null;
}

export async function getPhoto(source) {
  const dir = join(runtime, 'photos');
  await mkdir(dir, { recursive: true });
  const remote = /^https?:\/\//i.test(source);
  const ref = join(dir, key(source) + '.json');
  const cached = remote && (await cachedPhoto(source));
  if (cached) return cached;
  const temp = await mkdtemp(join(dir, '.download-'));
  try {
    const local = await preparePhoto(source, temp);
    const hash = key(await readFile(local));
    const path = join(dir, hash + extname(local));
    if (!(await stat(path).catch(() => null))) await rename(local, path);
    const photo = { path, hash };
    if (remote) await saveJson(ref, photo);
    return photo;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
