import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const maxBytes = 16 * 1024 * 1024;

export async function preparePhoto(source, dir) {
  let bytes;
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
    if (!response.ok || !response.body) throw new Error('Источник фото: HTTP ' + response.status);
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Изображение больше 16 МиБ');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else {
    const info = await stat(source);
    if (!info.isFile() || info.size > maxBytes) throw new Error('Ожидался файл изображения до 16 МиБ');
    bytes = await readFile(source);
  }
  let ext;
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ext = 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = 'png';
  if (bytes.toString('ascii', 0, 2) === 'BM') ext = 'bmp';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
  if (!ext) throw new Error('Ожидалось изображение JPEG, PNG, BMP или WebP');
  const path = join(dir, 'source.' + ext);
  await writeFile(path, bytes);
  return path;
}
