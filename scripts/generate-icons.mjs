#!/usr/bin/env node
/**
 * Re-render the PNG toolbar icons from icons/icon.svg.
 *
 * Run: npm install && npm run icons
 *
 * `icons/icon.svg` is the vendored Foxl mark, originally the desktop app's
 * favicon. It is the source of truth for this repository: the extension has its
 * own release cycle now, so it carries its own copy of the mark rather than
 * reaching into another repo at build time.
 *
 * This is the ONLY icon generator here. The move from the monorepo dropped two
 * others - one needing a native `canvas` binding, one needing ImageMagick - that
 * produced the same four PNGs. Three ways to render one asset is noise in a
 * repository whose purpose is being easy to read.
 *
 * The committed PNGs are the artifact; this script only exists for when the mark
 * changes. `scripts/build.mjs` does not run it.
 */
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(root, 'icons', 'icon.svg');
const iconsDir = join(root, 'icons');

const SIZES = [16, 32, 48, 128];

const svg = readFileSync(svgPath, 'utf8');

for (const size of SIZES) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const out = join(iconsDir, `icon-${size}.png`);
  writeFileSync(out, resvg.render().asPng());
  console.log(`wrote icons/icon-${size}.png`);
}
