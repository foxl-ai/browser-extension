// The release workflow's inputs reach a shell only as data (foxl-ai/pilot #7805).
//
// A workflow_dispatch input reaches the shell only as data. The property: no `run:` body in release.yml contains an
// expression (every input arrives as an environment variable), and the
// first step refuses a version that is not MAJOR.MINOR.PATCH before anything is checked out or built. The first
// step's own script is run here, under bash, with each input.
//
// Zero dependencies, like the audit: the workflow is read as text, line by line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8').split('\n');
const indent = (line) => line.length - line.trimStart().length;

/** Every `run:` body in the file: { at (1-based line), body }. A block scalar runs to the first line indented no deeper than its key. */
function runBodies() {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const keyIndent = indent(lines[i]) + (lines[i].trimStart().startsWith('-') ? 2 : 0);
    if (!/^[|>][-+]?\s*$/.test(m[2])) { out.push({ at: i + 1, body: m[2] }); continue; }
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || indent(lines[j]) > keyIndent); j++) body.push(lines[j]);
    out.push({ at: i + 1, body: body.join('\n') });
  }
  return out;
}

/** The release job's first step, as the lines of its list item. */
function firstStep() {
  const steps = lines.findIndex((l) => /^\s+steps:\s*$/.test(l));
  assert.ok(steps > 0, 'release.yml has a steps list');
  const start = lines.findIndex((l, i) => i > steps && /^\s+-\s/.test(l));
  const itemIndent = indent(lines[start]);
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim() && indent(lines[end]) <= itemIndent)) end++;
  return lines.slice(start, end);
}

test('no run: body in release.yml contains a ${{ }} expression; every input reaches the shell as an environment variable', () => {
  const bodies = runBodies();
  assert.ok(bodies.length >= 5, `found ${bodies.length} run: bodies`);
  const expanded = bodies.filter((b) => b.body.includes('${{'));
  assert.deepEqual(expanded.map((b) => `line ${b.at}`), [], 'run: bodies with an expression pasted into the script');
  assert.match(lines.join('\n'), /^\s+VERSION: \$\{\{ inputs\.version \}\}$/m, 'the version input is an environment variable');
});

test('the first step refuses a version that is not MAJOR.MINOR.PATCH, before any checkout or build', () => {
  const step = firstStep();
  assert.ok(!step.some((l) => /uses:/.test(l)), `the first step runs no action:\n${step.join('\n')}`);
  const at = step.findIndex((l) => /^\s*(?:-\s+)?run:\s*\|/.test(l));
  assert.ok(at >= 0, `the first step is a script:\n${step.join('\n')}`);
  const bodyIndent = indent(step[at + 1]);
  const script = step.slice(at + 1).map((l) => l.slice(Math.min(bodyIndent, indent(l) || bodyIndent))).join('\n');
  const run = (version) => spawnSync('bash', ['--noprofile', '--norc', '-e', '-s'], {
    input: script,
    env: { PATH: process.env.PATH, VERSION: version },
    encoding: 'utf8',
  });
  for (const good of ['0.14.1', '1.0.0', '10.20.30']) {
    const r = run(good);
    assert.equal(r.status, 0, `${JSON.stringify(good)} is a version: ${r.stdout}${r.stderr}`);
  }
  for (const bad of ['', '0.14', '0.14.1.2', 'v0.14.1', '0.14.1-beta.1', ' 0.14.1', '0.14.1 ', '0.14.1\n', '0.14.1\nx', '0.14.1$x', '0.14.1"x', "0.14.1'x", '0.14.1;x', '0.14.1`x`']) {
    const r = run(bad);
    assert.notEqual(r.status, 0, `${JSON.stringify(bad)} must be refused`);
    assert.ok(!r.stdout.includes(bad.trim() || '\u0000'), `the refusal does not print the input back: ${r.stdout}`);
  }
});
