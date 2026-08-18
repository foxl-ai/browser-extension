#!/usr/bin/env node
/**
 * Build the release zip.
 *
 * Run: node scripts/build.mjs
 * Out: dist/foxl-browser-extension-<version>.zip
 *      dist/foxl-browser-extension-latest.zip   (byte-identical copy, stable URL)
 *      dist/SHA256SUMS.txt
 *
 * THE OUTPUT IS BYTE-REPRODUCIBLE, and that is the point of this file rather
 * than a `zip -r` one-liner. The README tells people to rebuild the zip at the
 * release tag and compare digests with the published one; that check is only
 * meaningful if two honest builds cannot disagree. Three things would break it
 * and are each pinned below:
 *
 *   1. ENTRY ORDER. A directory walk returns whatever order the filesystem
 *      feels like, so the list is sorted before anything is written.
 *   2. TIMESTAMPS. ZIP stores a DOS date per entry; the file's real mtime would
 *      make every clone produce a different archive. Fixed at the DOS epoch
 *      (1980-01-01), which is what every reproducible-build toolchain uses.
 *   3. COMPRESSION. Entries are STORED, not deflated. zlib's output is not
 *      guaranteed identical across zlib versions, so a deflated archive built
 *      on Node 20 and Node 22 can differ byte-for-byte while containing exactly
 *      the same files - which would read as tampering. The whole extension is
 *      ~150 KB, so paying that in download size to keep the digest check honest
 *      is not a real cost.
 *
 * Zero dependencies on purpose: the release artifact of an extension people are
 * auditing should not be produced by code they also have to audit.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

/*
 * An ALLOWLIST, not an ignore list. A denylist ships whatever someone forgot to
 * exclude - a stray probe script, an editor backup, a .env - into an artifact
 * that asks for access to every site the user visits. This way a new file is
 * absent until someone names it here.
 *
 * LICENSE and NOTICE are in the zip because the zip is a distribution under
 * Apache-2.0, which requires the license to travel with it. Chrome ignores
 * files the manifest does not reference.
 */
const INCLUDE = [
  'manifest.json',
  'sidepanel.html',
  'options.html',
  'LICENSE',
  'NOTICE',
  'icons',
  'src',
  'styles',
];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Every file under `entry`, as repo-relative POSIX paths, sorted. */
function collect(entry) {
  const abs = join(root, entry);
  const st = statSync(abs);
  if (st.isFile()) return [entry];
  const out = [];
  for (const name of readdirSync(abs)) out.push(...collect(posix.join(entry, name)));
  return out;
}

const files = INCLUDE.flatMap(collect).sort();
if (!files.includes('manifest.json')) throw new Error('manifest.json missing from the build');

const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`manifest.json version must be X.Y.Z, got ${JSON.stringify(version)}`);
}

// DOS epoch: 1980-01-01 00:00:00. date = (year-1980)<<9 | month<<5 | day.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const STORED = 0;

const locals = [];
const centrals = [];
let offset = 0;

for (const name of files) {
  const data = readFileSync(join(root, name.split(posix.sep).join(sep)));
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed to extract (2.0)
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(STORED, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size == size, stored
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra field length
  locals.push(local, nameBuf, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header signature
  central.writeUInt16LE((3 << 8) | 20, 4); // version made by: UNIX, 2.0
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(STORED, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(0o644 << 16, 38); // external attributes: unix mode
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += 30 + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
eocd.writeUInt16LE(0, 4); // this disk
eocd.writeUInt16LE(0, 6); // disk with central directory
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20); // comment length

const zip = Buffer.concat([...locals, centralBuf, eocd]);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/*
 * TWO NAMES, ONE BUILD. The versioned name is what a release archives; the
 * `-latest` name is what the docs and the desktop app's Settings panel link to,
 * so those links never need editing at release time (same reason the desktop
 * assets carry a fixed filename). They are the same bytes, so the digest check
 * in the README works against either.
 */
const versioned = `foxl-browser-extension-${version}.zip`;
const latest = 'foxl-browser-extension-latest.zip';
writeFileSync(join(outDir, versioned), zip);
writeFileSync(join(outDir, latest), zip);

const digest = createHash('sha256').update(zip).digest('hex');
writeFileSync(join(outDir, 'SHA256SUMS.txt'), `${digest}  ${versioned}\n${digest}  ${latest}\n`);

const rel = (p) => relative(root, p);
console.log(`version   ${version}`);
console.log(`entries   ${files.length}`);
console.log(`size      ${zip.length} bytes`);
console.log(`sha256    ${digest}`);
console.log(`wrote     ${rel(join(outDir, versioned))}`);
console.log(`wrote     ${rel(join(outDir, latest))}`);
console.log(`wrote     ${rel(join(outDir, 'SHA256SUMS.txt'))}`);
