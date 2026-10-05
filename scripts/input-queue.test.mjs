/**
 * The input queue (src/input-queue.js) and the page's deadline check
 * (src/content-scripts/visual-indicator.js), for the case that motivated both: a button whose
 * handler calls confirm() holds its tab, so the click never answers.
 *
 * Before, one queue served every tab and had no timeout: typing into ANOTHER tab waited
 * behind the dialog until the desktop timed out, and ran later anyway.
 *
 * Run: node --test scripts/input-queue.test.mjs   (zero dependencies, like the other scripts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createInputQueue, INPUT_DEADLINE_MS } from '../src/input-queue.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A click whose page opened confirm(): its answer never comes. */
const stuckOnDialog = () => new Promise(() => {});
const DEADLINE = 300;

test('the deadline sits below Foxl Desktop\'s 30 s command timeout', () => {
  assert.ok(INPUT_DEADLINE_MS < 30000);
});

test('a tab stuck on a dialog holds only its own input: typing into another tab runs at once', async () => {
  const q = createInputQueue({ deadlineMs: DEADLINE });
  q.run('tab-A', stuckOnDialog);
  await sleep(20);
  const t0 = Date.now();
  const typed = await q.run('tab-B', async () => ({ success: true, typed: 'hello' }));
  assert.deepEqual(typed, { success: true, typed: 'hello' });
  assert.ok(Date.now() - t0 < DEADLINE / 3, `tab B waited ${Date.now() - t0} ms`);
});

test('on the stuck tab, the next action gets its turn at the stuck one\'s deadline, not never', async () => {
  const q = createInputQueue({ deadlineMs: DEADLINE });
  const t0 = Date.now();
  q.run('tab-A', stuckOnDialog);
  await sleep(100); // queued later, so its own deadline is still ahead when its turn comes
  let startedAfter = null;
  let gotDeadline = null;
  const r = await q.run('tab-A', async (deadline) => { startedAfter = Date.now() - t0; gotDeadline = deadline; return { success: true }; });
  assert.deepEqual(r, { success: true });
  assert.ok(startedAfter >= DEADLINE - 15, `started after ${startedAfter} ms, before the stuck action's deadline`);
  assert.ok(gotDeadline > Date.now() - DEADLINE, 'the action is handed its OWN deadline, for the page messages it sends');
});

test('an action queued together with the stuck one waited its whole deadline: refused, not run', async () => {
  // The model sends both in one response, so they are queued in the same instant.
  const q = createInputQueue({ deadlineMs: DEADLINE });
  q.run('tab-A', stuckOnDialog);
  let ran = false;
  const r = await q.run('tab-A', async () => { ran = true; return { success: true }; });
  assert.equal(ran, false);
  assert.equal(r.nothingWasDone, true);
  assert.match(r.error, /never finished .* nothing was done/);
});

test('an action whose turn comes after its own deadline is refused and not run', async () => {
  const q = createInputQueue({ deadlineMs: DEADLINE });
  q.run('tab-A', stuckOnDialog);
  let ran = false;
  const late = q.run('tab-A', async () => { ran = true; return { success: true }; });
  // A suspended or busy service worker: no timer fires until well past both deadlines.
  const until = Date.now() + DEADLINE * 2.5;
  while (Date.now() < until) { /* block the event loop */ }
  const r = await late;
  assert.equal(ran, false, 'nothing was done');
  assert.equal(r.success, false);
  assert.equal(r.nothingWasDone, true);
  assert.match(r.error, /nothing was done/);
});

test('Stop answers every waiting action at once, and none of them runs later', async () => {
  const q = createInputQueue({ deadlineMs: DEADLINE });
  const t0 = Date.now();
  q.run('tab-A', stuckOnDialog);
  let ran = false;
  const queued = q.run('tab-A', async () => { ran = true; return { success: true }; });
  await sleep(20);
  q.stop();
  const r = await queued;
  assert.ok(Date.now() - t0 < DEADLINE / 2, `answered ${Date.now() - t0} ms in, at Stop, not at its turn`);
  assert.equal(r.nothingWasDone, true);
  assert.match(r.error, /stopped before this action ran/);
  // An action queued after Stop still waits for the stuck one (one at a time), then runs.
  await sleep(130); // queued late enough that its own deadline is still well ahead at its turn
  let laterStartedAt = null;
  const later = await q.run('tab-A', async () => { laterStartedAt = Date.now() - t0; return { success: true }; });
  assert.deepEqual(later, { success: true }, 'an action queued after Stop runs');
  assert.ok(laterStartedAt >= DEADLINE - 15, `it waited for the stuck action's deadline (${laterStartedAt} ms)`);
  assert.equal(ran, false, 'the stopped action never ran, not even at its turn');
});

test('the queue forgets a tab once its last action is done', async () => {
  const q = createInputQueue({ deadlineMs: DEADLINE });
  await q.run('tab-A', async () => ({ success: true }));
  await sleep(5);
  assert.equal(q.size(), 0);
});

test('the page refuses a message that reaches it after its deadline (it waited behind the dialog)', () => {
  let listener = null;
  const calls = [];
  const sandbox = {
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: async () => {} } },
    Date,
  };
  sandbox.window = {
    addEventListener() {},
    __pilotClickFallback: (refId) => { calls.push(refId); return { success: true, method: 'synthetic' }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, 'src/content-scripts/visual-indicator.js'), 'utf8'), sandbox);
  assert.ok(listener, 'visual-indicator.js registers its message listener');
  const answer = (message) => { let out; listener(message, {}, (r) => { out = r; }); return out; };

  const late = answer({ type: 'CLICK_FALLBACK', refId: 'ref_7', deadline: Date.now() - 1 });
  assert.equal(late.success, false);
  assert.equal(late.nothingWasDone, true);
  assert.deepEqual(calls, [], 'the click was not performed');

  const inTime = answer({ type: 'CLICK_FALLBACK', refId: 'ref_7', deadline: Date.now() + 5000 });
  assert.equal(inTime.success, true);
  assert.deepEqual(calls, ['ref_7']);

  const noDeadline = answer({ type: 'CLICK_FALLBACK', refId: 'ref_8' });
  assert.equal(noDeadline.success, true, 'a message with no deadline (an older service worker) is performed as before');
});
