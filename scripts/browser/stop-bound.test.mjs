/**
 * A STOP HOLDS FOR A BOUNDED TIME, AND NEVER ACTS LATER ON A RUN IT WAS NOT PRESSED FOR (foxl-ai/pilot #8210).
 *
 * After the person's Stop, run-less commands are refused until the desktop has answered it (stop-holds.test.mjs). A
 * Stop the desktop never answers (the channel dropped before its reply) holds for 30 s from the press, then the next
 * command runs; a Stop pressed while no channel is open is sent when one opens within those 30 s, and never after. The
 * unanswered case and the late one are RED on 0.14.1 (56318ff), which held until some later run's hide_indicators and
 * sent a Stop whenever the channel next opened; a Stop sent when the channel comes back in time is the control.
 *
 * The person's Stop is a real click on the overlay's button. "No channel open" is the harness's desktop taking no new
 * socket (`holdSockets`) after it dropped the live one. Each bounded case waits the 30 s out. The real extension in
 * Chromium (scripts/browser/harness.mjs). Run: npm run test:browser. FOXL_EXTENSION_DIR=<a tree> runs it against that
 * build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const STOP_BOUND_MS = 30_000;
const PAGE = `<!doctype html><html><head><title>Example Bank - Transfer</title></head><body>
<h1>Transfer</h1><label for="amount">Amount</label><input id="amount"></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, pred, ms, every = 250) {
  let v = await read();
  for (const end = Date.now() + ms; !pred(v) && Date.now() < end;) { await sleep(every); v = await read(); }
  return v;
}

let ext;
let page;
let tabId;
let options;
before(async () => {
  ext = await launchExtension({ routes: { '/transfer': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); } } });
  page = await ext.context.newPage();
  await page.goto(`${ext.origin}/transfer`);
  tabId = await ext.tabIdOf(page);
  options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extensionId}/options.html`);
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const count = (type) => ext.frames.filter((f) => f.type === type).length;
const connected = async () => (await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' })))?.wsConnected === true;
const read = () => ext.command('get_accessibility_tree', tabId, { filter: 'all' });
const held = (answer) => answer?.success === false && answer.stopped === true;

/** The overlay's Stop Foxl button, shown by the desktop and visible. */
async function stopButton() {
  ext.send({ type: 'show_indicators', data: { tabId } });
  const button = page.locator('#pilot-agent-stop-button');
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await sleep(400); // the button slides in
  return button;
}

/** The desktop is gone: the live socket dropped, and no new one is taken until `release()`. */
async function disconnect() {
  const release = ext.holdSockets();
  ext.dropSockets();
  assert.equal(await until(connected, (up) => !up, 10_000), false, 'the extension still reads as connected');
  return release;
}

/** The desktop is back: the extension reconnects (asked from its options page, as the options page's own test does). */
async function reconnect(release) {
  const hellos = count('extension_connected');
  release();
  await until(async () => {
    if (count('extension_connected') > hellos) return true;
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' })).catch(() => null);
    return count('extension_connected') > hellos;
  }, (v) => v, 45_000, 1_000);
  assert.ok(count('extension_connected') > hellos, 'the extension never reconnected');
}

test('CONTROL: a Stop pressed while no channel is open is sent when one opens within the bound, and holds until answered', async () => {
  const button = await stopButton();
  const release = await disconnect();
  const stops = count('stop_agent');
  await button.click();
  await sleep(2_000);
  await reconnect(release);
  assert.equal(await until(() => count('stop_agent'), (n) => n > stops, 5_000), stops + 1, 'the Stop was not sent when the channel opened');
  assert.ok(held(await read()), 'a command ran before the desktop answered the Stop');
  // The desktop's answer, then quiet: the next request runs.
  ext.send({ type: 'hide_indicators', data: { tabId } });
  await sleep(2_000);
  const tree = await read();
  assert.equal(tree?.success, true, JSON.stringify(tree));
});

test('a Stop the desktop never answers holds for the bound, then the next command runs', async () => {
  const button = await stopButton();
  const stops = count('stop_agent');
  await button.click();
  // Timed from the end of the click: Playwright waits for the sliding button to settle before it clicks.
  const pressedAt = Date.now();
  assert.equal(await until(() => count('stop_agent'), (n) => n > stops, 5_000), stops + 1, 'the desktop was not told');
  // No hide_indicators: the desktop never answers. Held inside the bound.
  assert.ok(held(await read()), 'a command ran right after the Stop');
  await sleep(Math.max(0, pressedAt + STOP_BOUND_MS - 5_000 - Date.now()));
  assert.ok(held(await read()), 'the hold ended before the bound');
  await sleep(Math.max(0, pressedAt + STOP_BOUND_MS + 2_000 - Date.now()));
  const tree = await read();
  assert.equal(tree?.success, true, `still held ${Math.round((Date.now() - pressedAt) / 1000)} s after a Stop nobody answered: ${JSON.stringify(tree)}`);
});

test('a Stop pressed while no channel is open is never sent after the bound, and holds nothing after it', async () => {
  const button = await stopButton();
  const release = await disconnect();
  const stops = count('stop_agent');
  await button.click();
  const pressedAt = Date.now();
  await sleep(Math.max(0, pressedAt + STOP_BOUND_MS + 2_000 - Date.now()));
  await reconnect(release);
  await sleep(1_500);
  assert.equal(count('stop_agent'), stops, `a Stop pressed ${Math.round((Date.now() - pressedAt) / 1000)} s ago was sent when the channel opened`);
  const tree = await read();
  assert.equal(tree?.success, true, JSON.stringify(tree));
});
