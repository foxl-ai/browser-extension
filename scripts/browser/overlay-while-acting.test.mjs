/**
 * WHILE FOXL ACTS IN A TAB, THAT TAB SAYS SO (foxl-ai/pilot #7804, part 1).
 *
 * The extension raises the overlay (the glow and the Stop Foxl button) itself for every command that acts in or
 * captures a tab, whatever the desktop sent before, and clears it after the command ends when the desktop did not ask
 * for it: for as long as an action runs, and for a read (a tree, read_text, a screenshot) once the read has been taken,
 * so a page never learns from it that a read is coming (foxl-ai/pilot #8211, read-before-overlay.test.mjs). The page
 * here records, in its own world, when the overlay's glow is added and removed and when its field gets input. The
 * first two cases are RED on 0.14.0 (main a11298c); the third, the desktop's own show and hide, is the control.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs). Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const PAGE = `<!doctype html><html><head><title>Example Shop - Checkout</title></head><body>
<h1>Checkout</h1><label for="name">Name on card</label><input id="name">
<script>
  window.__log = [];
  const note = (what) => window.__log.push({ what, at: Date.now() });
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.id === 'pilot-agent-glow-border') note('overlay+');
      for (const n of r.removedNodes) if (n.id === 'pilot-agent-glow-border') note('overlay-');
    }
  }).observe(document.body, { childList: true });
  document.addEventListener('input', () => note('input'), true);
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, pred, ms) {
  let v = await read();
  for (const end = Date.now() + ms; !pred(v) && Date.now() < end;) { await sleep(150); v = await read(); }
  return v;
}

let ext;
let page;
let tabId;
let nameRef;
const log = () => page.evaluate(() => window.__log.slice());
const glowUp = () => page.evaluate(() => !!document.getElementById('pilot-agent-glow-border'));

before(async () => {
  ext = await launchExtension({ routes: { '/checkout': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); } } });
  page = await ext.context.newPage();
  await page.goto(`${ext.origin}/checkout`);
  tabId = await ext.tabIdOf(page);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  nameRef = /textbox "Name on card" \[(ref_\d+)\]/.exec(tree?.data?.pageContent ?? '')?.[1];
  assert.ok(nameRef, JSON.stringify(tree));
  // The read above put the overlay up for itself; it is cleared once it has ended.
  await until(glowUp, (up) => !up, 5_000);
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

/** After the desktop's hide frame, with the overlay gone and the page's record emptied. */
async function afterHideFrame() {
  ext.send({ type: 'hide_indicators', data: { tabId } });
  await until(glowUp, (up) => !up, 5_000);
  await page.evaluate(() => { window.__log = []; });
}

test('typing shows the overlay while it runs, even right after a hide frame, and it clears after the command ends', async () => {
  await afterHideFrame();
  const typed = await ext.command('type', tabId, { refId: nameRef, text: 'Ada Lovelace' });
  const answeredAt = Date.now();
  assert.equal(typed?.success, true, JSON.stringify(typed));
  const events = await until(log, (l) => l.some((e) => e.what === 'overlay-'), 5_000);
  const up = events.find((e) => e.what === 'overlay+');
  const input = events.find((e) => e.what === 'input');
  const down = events.find((e) => e.what === 'overlay-');
  assert.ok(up, `the overlay never went up: ${JSON.stringify(events)}`);
  assert.ok(input && up.at <= input.at, `the overlay was not up before the typing: ${JSON.stringify(events)}`);
  assert.ok(down && down.at >= answeredAt, `the overlay did not stay until the command ended: ${JSON.stringify(events)}`);
});

test('a screenshot shows it too, from the capture on, and it clears after', async () => {
  await afterHideFrame();
  const startedAt = Date.now();
  const shot = await ext.command('screenshot', tabId, {});
  const answeredAt = Date.now();
  assert.equal(shot?.success, true, JSON.stringify(shot).slice(0, 300));
  const events = await until(log, (l) => l.some((e) => e.what === 'overlay-'), 5_000);
  const up = events.find((e) => e.what === 'overlay+');
  const down = events.find((e) => e.what === 'overlay-');
  assert.ok(up && up.at >= startedAt - 50, `the overlay never went up for the capture: ${JSON.stringify(events)}`);
  assert.ok(down && down.at >= answeredAt && down.at > up.at, `the overlay did not stay until the capture ended: ${JSON.stringify(events)}`);
});

test('the desktop\'s show keeps the overlay up, and its hide takes it down when nothing runs', async () => {
  ext.send({ type: 'show_indicators', data: { tabId } });
  assert.equal(await until(glowUp, (up) => up, 5_000), true);
  // A command while it is up leaves it up after the command too.
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  await sleep(1_500);
  assert.equal(await glowUp(), true, 'the desktop\'s overlay went down after a command');
  ext.send({ type: 'hide_indicators', data: { tabId } });
  assert.equal(await until(glowUp, (up) => !up, 5_000), false);
});
