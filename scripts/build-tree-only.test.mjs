// The release zip packages what the tree holds, never a symbolic link's target (foxl-ai/pilot #7922).
//
// scripts/build.mjs packages an allowlist of paths. Each case copies the files the build reads into a fresh folder
// and runs that copy's own build.mjs: with a symbolic link under src/ pointing at a file outside the copy, the
// build must fail by name and write no zip, so no outside byte reaches the zip or SHA256SUMS.txt; without one it
// builds as before. Zero dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_READS = ['manifest.json', 'sidepanel.html', 'options.html', 'LICENSE', 'NOTICE', 'icons', 'src', 'styles', 'scripts/build.mjs', 'scripts/store-manifest.mjs', 'package.json'];

function copyOfTree() {
  const dir = mkdtempSync(join(tmpdir(), 'foxl-build-tree-'));
  for (const entry of BUILD_READS) cpSync(join(root, entry), join(dir, entry), { recursive: true });
  return dir;
}

const build = (dir) => spawnSync(process.execPath, [join(dir, 'scripts', 'build.mjs')], { cwd: dir, encoding: 'utf8' });

test('a symbolic link in an allowlisted folder fails the build by name, and no zip carries its target', () => {
  const dir = copyOfTree();
  const outside = mkdtempSync(join(tmpdir(), 'foxl-build-outside-'));
  try {
    const marker = `outside-the-tree-${process.pid}-${Date.now()}`;
    writeFileSync(join(outside, 'elsewhere.js'), `// ${marker}\n`);
    symlinkSync(join(outside, 'elsewhere.js'), join(dir, 'src', 'linked.js'));
    const r = build(dir);
    const zips = existsSync(join(dir, 'dist')) ? readdirSync(join(dir, 'dist')).filter((f) => f.endsWith('.zip')) : [];
    const carried = zips.some((f) => readFileSync(join(dir, 'dist', f)).includes(marker));
    assert.equal(carried, false, 'the zip carries the bytes of a file outside the tree');
    assert.notEqual(r.status, 0, `the build succeeded with a symbolic link in src/:\n${r.stdout}`);
    assert.match(r.stderr, /src\/linked\.js is a symbolic link/);
    assert.deepEqual(zips, [], 'a refused build writes no zip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the same tree without the link builds as before', () => {
  const dir = copyOfTree();
  try {
    const r = build(dir);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const version = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version;
    assert.ok(existsSync(join(dir, 'dist', `foxl-browser-extension-${version}.zip`)));
    assert.match(readFileSync(join(dir, 'dist', 'SHA256SUMS.txt'), 'utf8'), /^[0-9a-f]{64} {2}foxl-browser-extension-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
