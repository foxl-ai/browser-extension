/**
 * STOP HOLDS THE RUN IT STOPPED (foxl-ai/pilot #7927).
 *
 * After Stop, the stopped run's commands still on their way are refused, input or not, with `stopped: true`. From a
 * desktop that names no run (every desktop today) the hold ends once the desktop has answered the Stop (its
 * `hide_indicators`) and then sent nothing for 1.5 s; from one that sends `data.run`, a command with another run id
 * begins a new run. The held cases are RED on 0.14.0 (main a11298c); the
 * new-run cases are the controls.
 *
 * The person's Stop is a real click on the overlay's button (Playwright's, a trusted one). The real extension in
 * Chromium (scripts/browser/harness.mjs). Run: npm run test:browser. FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const PAGE = `<!doctype html><html><head><title>Example Bank - Transfer</title></head><body>
<h1>Transfer</h1><label for="amount">Amount</label><input id="amount">
<script>window.__inputs = 0; document.addEventListener('input', () => { window.__inputs += 1; }, true);</script>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, pred, ms) {
  let v = await read();
  for (const end = Date.now() + ms; !pred(v) && Date.now() < end;) { await sleep(200); v = await read(); }
  return v;
}

let ext;
let page;
let tabId;
let amountRef;
before(async () => {
  ext = await launchExtension({ routes: { '/transfer': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); } } });
  page = await ext.context.newPage();
  await page.goto(`${ext.origin}/transfer`);
  tabId = await ext.tabIdOf(page);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  amountRef = /textbox "Amount" \[(ref_\d+)\]/.exec(tree?.data?.pageContent ?? '')?.[1];
  assert.ok(amountRef, JSON.stringify(tree));
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

/** The person presses the overlay's Stop Foxl button. */
async function pressStop() {
  const stops = ext.frames.filter((f) => f.type === 'stop_agent').length;
  ext.send({ type: 'show_indicators', data: { tabId } });
  const button = page.locator('#pilot-agent-stop-button');
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await sleep(400); // the button slides in
  await button.click();
  await until(() => ext.frames.filter((f) => f.type === 'stop_agent').length, (n) => n > stops, 5_000);
  assert.ok(ext.frames.filter((f) => f.type === 'stop_agent').length > stops, 'the desktop was told');
}

const held = (answer) => {
  assert.equal(answer?.success, false, JSON.stringify(answer));
  assert.equal(answer.stopped, true, JSON.stringify(answer));
  assert.match(String(answer.error), /pressed Stop Foxl/);
};

test('after Stop, a read and a type of the stopped run are refused, and the page sees no input', async () => {
  await pressStop();
  held(await ext.command('get_accessibility_tree', tabId, { filter: 'all' }));
  held(await ext.command('screenshot', tabId, {}));
  held(await ext.command('type', tabId, { refId: amountRef, text: '5000' }));
  held(await ext.command('navigate', tabId, { url: `${ext.origin}/transfer?again` }));
  assert.equal(await page.evaluate(() => window.__inputs), 0);
  assert.equal(await page.evaluate(() => document.getElementById('amount').value), '');
  assert.equal(page.url(), `${ext.origin}/transfer`);
});

test('a desktop with no run ids: once it has answered the Stop and gone quiet, the next request runs as before', async () => {
  ext.send({ type: 'hide_indicators', data: { tabId } });
  await sleep(2_000);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  const typed = await ext.command('type', tabId, { refId: amountRef, text: '25' });
  assert.equal(typed?.success, true, JSON.stringify(typed));
});

test('a desktop that names its runs: the stopped run stays refused, and a new run works at once', async () => {
  const first = await ext.command('get_accessibility_tree', tabId, { filter: 'all' }, { run: 'run-1' });
  assert.equal(first?.success, true, JSON.stringify(first));
  await pressStop();
  ext.send({ type: 'hide_indicators', data: { tabId } });
  await sleep(2_000);
  held(await ext.command('get_accessibility_tree', tabId, { filter: 'all' }, { run: 'run-1' }));
  held(await ext.command('type', tabId, { refId: amountRef, text: '9' }, { run: 'run-1' }));
  const next = await ext.command('get_accessibility_tree', tabId, { filter: 'all' }, { run: 'run-2' });
  assert.equal(next?.success, true, JSON.stringify(next));
});
