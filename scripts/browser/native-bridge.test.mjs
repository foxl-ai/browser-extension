/**
 * THE NATIVE CHANNEL, IN THE REAL EXTENSION (0.14.0, foxl-ai/pilot #5994).
 *
 * Chromium starts a native-messaging host for the extension and the extension adopts it only on a `pong`:
 * scripts/browser/harness.mjs `nativeHost` installs the harness's own bridge (native-host-relay.mjs) into the
 * run's profile, admitting exactly the copy's ID, and relays to the harness the way Foxl Desktop's bridge relays
 * to the desktop. What Foxl Desktop's own host does is foxl-ai/pilot's to prove
 * (`foxl/scripts/probe-extension-bridge-chrome.mjs`); this file proves the extension's half: it asks Chrome for
 * the host, waits for the pong, announces `transport: "native"`, carries the desktop's commands and answers as
 * objects over the port, says so on the options page, and treats anything but a pong as no bridge.
 *
 * Chromium reads a user-level host from the profile's own NativeMessagingHosts folder: on Linux the profile is
 * `<XDG_CONFIG_HOME>/chromium`, which the harness sets for the browser alone, and on macOS Chromium 156 found the
 * run's host in the run's profile the same way (measured, all five cases green). Nothing outside the run's
 * folder is written.
 * Run: npm run test:browser. FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, pred, ms) {
  let v = await read();
  for (const end = Date.now() + ms; !pred(v) && Date.now() < end;) { await sleep(300); v = await read(); }
  return v;
}
const status = (page) => page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' }));

describe('a bridge that answers pong', () => {
  let ext;
  before(async () => { ext = await launchExtension({ nativeHost: 'relay', refuseSocket: 4004 }); }, { timeout: 60_000 });
  after(async () => { await ext?.close(); });

  test('Chrome starts the bridge for this extension, and the extension announces the native transport', () => {
    assert.equal(ext.announced?.transport, 'native', JSON.stringify(ext.announced));
    assert.ok(Array.isArray(ext.announced.capabilities), JSON.stringify(ext.announced));
    const bridged = ext.sockets.filter((s) => s.paired);
    assert.equal(bridged.length, 1, JSON.stringify(ext.sockets));
    assert.equal(bridged[0].caller, `chrome-extension://${ext.extensionId}/`, 'Chrome passed the caller origin to the host');
    assert.equal(ext.sockets.filter((s) => !s.paired).length, 0, 'the local socket was never tried');
  });

  test('a desktop command goes through the bridge and its answer comes back as an object', async () => {
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/options.html`);
    const answer = await ext.command('get_tabs');
    assert.ok(Array.isArray(answer?.tabs), JSON.stringify(answer));
    assert.ok(answer.tabs.some((t) => t.url === page.url()), JSON.stringify(answer.tabs.map((t) => t.url)));
    await page.close();
  });

  test('the worker and the options page say the verified connection is in use', async () => {
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/options.html`);
    const s = await until(() => status(page), (v) => v?.transport === 'native', 15_000);
    assert.equal(s.transport, 'native', JSON.stringify(s));
    assert.equal(s.wsConnected, true);
    assert.equal(s.desktopRequiresBridge, false);
    assert.equal(s.nativeUnavailableReason, null);
    const text = page.locator('#statusText');
    await until(() => text.innerText(), (t) => t.includes('Connected to Foxl Desktop'), 15_000);
    assert.equal((await text.innerText()).trim(), 'Connected to Foxl Desktop');
    assert.equal(await text.getAttribute('title'), 'Over the verified browser connection');
    await page.close();
  });
});

describe('a bridge that cannot reach the desktop', () => {
  let ext;
  before(async () => { ext = await launchExtension({ nativeHost: 'unreachable' }); }, { timeout: 60_000 });
  after(async () => { await ext?.close(); });

  test('anything but a pong is no bridge: the extension falls back to the local socket', async () => {
    assert.equal(ext.announced?.transport, 'websocket', JSON.stringify(ext.announced));
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/options.html`);
    const s = await until(() => status(page), (v) => v?.transport === 'websocket', 15_000);
    assert.equal(s.transport, 'websocket', JSON.stringify(s));
    assert.match(String(s.nativeUnavailableReason), /closed the port|exited|desktop_unreachable|did not answer/i, JSON.stringify(s));
    await page.close();
  });
});

describe('no bridge installed', () => {
  let ext;
  before(async () => { ext = await launchExtension({}); }, { timeout: 60_000 });
  after(async () => { await ext?.close(); });

  test('the extension connects over the local socket and says which', () => {
    assert.equal(ext.announced?.transport, 'websocket', JSON.stringify(ext.announced));
    assert.deepEqual(ext.sockets.map((s) => s.paired), [false]);
  });
});
