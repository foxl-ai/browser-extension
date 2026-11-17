/**
 * The manifest the store receives (scripts/store-manifest.mjs): this repository's manifest.json minus its `key`
 * line, every other byte unchanged, and anything ambiguous refused rather than guessed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { storeManifest } from './store-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'manifest.json'), 'utf8');

test('the checkout keeps the store item key: an unpacked copy has the store ID', () => {
  const key = JSON.parse(source).key;
  assert.equal(typeof key, 'string');
  // Chrome's ID for a keyed extension: the first 16 bytes of SHA-256 over the DER public key, 0-f as a-p.
  const id = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  assert.equal(id, 'ijlihobebaeangjiacfomjdkhlpbmlhi');
});

test('the store manifest is the checkout minus exactly the key line', () => {
  const out = storeManifest(source);
  const removed = source.split('\n').filter((line) => !out.split('\n').includes(line));
  assert.equal(removed.length, 1);
  assert.match(removed[0], /^\s*"key": "/);
  const { key: _key, ...rest } = JSON.parse(source);
  assert.deepEqual(JSON.parse(out), rest);
  assert.equal(Object.hasOwn(JSON.parse(out), 'key'), false);
  assert.equal(out.split('\n').length, source.split('\n').length - 1);
});

test('a manifest without a key passes through byte for byte', () => {
  const out = storeManifest(source);
  assert.equal(storeManifest(out), out);
});

test('an ambiguous key is refused, never guessed', () => {
  const twice = source.replace(/^(\s*"key": "[^"]+",\n)/m, '$1$1');
  assert.throws(() => storeManifest(twice), /expected one "key" line|not JSON/);
  const inline = '{ "manifest_version": 3, "key": "abc", "name": "x" }';
  assert.throws(() => storeManifest(inline), /removing the "key" line changed another member|not JSON|expected one/);
  const last = '{\n  "name": "x",\n  "key": "abc"\n}';
  assert.throws(() => storeManifest(last), /not JSON/);
});
