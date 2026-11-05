/**
 * A FOXL DESKTOP THAT REQUIRES THE VERIFIED BROWSER CONNECTION (0.14.0, foxl-ai/pilot #5994).
 *
 * Once Foxl Desktop closes its unpaired window, it refuses this extension's local socket with
 * `4004 extension_pairing_required` unless the extension came through Chrome's native messaging (the bridge).
 * When Chrome could not start the bridge (no host installed for this profile, here), the extension must not
 * read as connected: the desktop's health check still answers, so before 0.14.0 the options page said
 * "Connected to Foxl Desktop" and the side panel offered the chat while every command failed. Each case is
 * RED on 0.13.0 (feat/5882-frames-fill-sign-in, 539bfe3).
 *
 * The real extension in Chromium (scripts/browser/harness.mjs with `refuseSocket: 4004`: every /extension socket
 * closed at once, as an enforced desktop closes an unpaired one). Playwright's profile has no native messaging
 * host, so `connectNative` finds none, the extension falls back to the socket, and the socket is refused.
 * Run: npm run test:browser. FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const FIX = 'In Foxl Desktop, open Settings > Web Access and choose Reinstall browser connection';
let ext;
let id;
before(async () => {
  ext = await launchExtension({ refuseSocket: 4004 });
  const worker = ext.context.serviceWorkers()[0] ?? await ext.context.waitForEvent('serviceworker');
  id = new URL(worker.url()).hostname;
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, pred, ms) {
  let v = await read();
  for (const end = Date.now() + ms; !pred(v) && Date.now() < end;) { await sleep(300); v = await read(); }
  return v;
}

test('the worker reports the refusal as the bridge being required, not as connected', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  const status = await until(() => page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' })), (s) => s?.desktopRequiresBridge === true, 30_000);
  await page.close();
  assert.equal(status?.desktopRequiresBridge, true, JSON.stringify(status));
  assert.equal(status.wsConnected, false);
  assert.equal(status.transport, null);
});

test('the options page says where to fix it, never "Connected"', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  const text = await until(() => page.locator('#statusText').innerText(), (t) => t.includes('Reinstall browser connection'), 15_000);
  assert.match(text, /Foxl Desktop needs the verified browser connection: in Foxl Desktop, open Settings > Web Access and choose Reinstall browser connection/);
  assert.equal(await page.locator('#statusDot.connected').count(), 0, 'the dot is not green');
  await page.locator('#testButton').click();
  const message = page.locator('#message');
  await message.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal((await message.innerText()).trim(), `${FIX}.`);
  await page.close();
});

test('the side panel says where to fix it and offers no chat', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  const body = await until(() => page.locator('#setupBody').innerText(), (t) => t.includes('Reinstall browser connection'), 15_000);
  assert.equal(body.trim(), `${FIX}.`);
  assert.equal((await page.locator('#connectionLabel').innerText()).trim(), 'Desktop not connected');
  assert.equal(await page.locator('#inputField').getAttribute('placeholder'), 'Open Foxl Desktop to chat');
  await page.close();
});
