import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconDir = path.resolve(here, '../../extension/icons');
await mkdir(iconDir, {recursive: true});
const master = await readFile(path.join(here, 'mark.svg'));
const bounds = [];
for (const size of [16, 32, 48, 128]) {
  // At toolbar sizes the mark uses the canvas to preserve legibility.
  // Store/package 128 uses the official 16px transparent margin.
  const source = size < 128
    ? Buffer.from(master.toString().replace('viewBox="0 0 128 128"', 'viewBox="8 8 112 112"'))
    : master;
  const out = path.join(iconDir, `icon-${size}.png`);
  await sharp(source).resize(size, size).png().toFile(out);
  const {data, info} = await sharp(out).raw().toBuffer({resolveWithObject: true});
  let left = size, top = size, right = -1, bottom = -1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (data[(y * size + x) * info.channels + 3] > 0) {
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  bounds.push({file: path.relative(path.resolve(here, '../..'), out), width: size, height: size, channels: info.channels, artworkBounds: {left, top, right, bottom}});
}
await sharp(master).png().toFile(path.join(here, 'store-icon-128.png'));
await sharp(master).resize(512, 512).png().toFile(path.join(here, 'mark-512.png'));
await sharp(await readFile(path.join(here, 'wordmark.svg'))).png().toFile(path.join(here, 'wordmark.png'));
await writeFile(path.join(here, 'icon-verification.json'), JSON.stringify({generatedBy: 'node marketing/brand/render-icons.mjs', icons: bounds}, null, 2) + '\n');
console.log(JSON.stringify(bounds, null, 2));
