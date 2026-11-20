/**
 * THE NATIVE CHANNEL, IN THE REAL EXTENSION (0.14.0, foxl-ai/pilot #5994).
 *
 * Chromium starts a native-messaging host for the extension and the extension adopts it only on a `pong`:
 * scripts/browser/harness.mjs `nativeHost` installs the harness's own bridge (native-host-relay.mjs) into the
 * run's profile, admitting exactly the copy's ID, and relays to the harness the way Foxl Desktop's bridge relays
 * to the desktop. What Foxl Desktop's own host does is foxl-ai/pilot's to prove
 * (`foxl/scripts/probe-extension-bridge-chrome.mjs`); this file proves the extension's half: it asks Chrome for
 * the host, waits for the pong, announces `transport: "native"`, carries the desktop's commands and answers as
 * objects over the port, says so on the options page, and treats anything but a pong as a bridge that did not open:
 * retried as the bridge, never replaced by the local socket (#7795); only a profile with no host at all, where the
 * bridge never answered, uses the socket.
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
    // The open options page is in the answer: listed (0.14.0), or counted among the tabs that are not Foxl's (0.14.1).
    assert.ok(answer.tabs.some((t) => t.url === page.url()) || answer.otherTabs >= 1, JSON.stringify(answer));
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

/*
 * THE LOCAL SOCKET ONLY FOR A DESKTOP THAT NEVER INSTALLED THE BRIDGE (foxl-ai/pilot #7795). A bridge that did not
 * answer pong is retried as the bridge. Each case below is RED on 0.14.0 (main a11298c): an unpaired socket appears.
 */
const unpaired = (ext) => ext.sockets.filter((s) => !s.paired);

describe('a bridge that cannot reach the desktop', () => {
  let ext;
  let page;
  before(async () => {
    ext = await launchExtension({ nativeHost: 'unreachable', expectHello: false });
    page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/options.html`);
  }, { timeout: 60_000 });
  after(async () => { await ext?.close(); });

  test('a host that answers anything but pong is retried as the bridge, never replaced by the local socket', async () => {
    const s = await until(() => status(page), (v) => /exited|closed the port|did not answer/i.test(String(v?.nativeUnavailableReason)), 20_000);
    assert.match(String(s.nativeUnavailableReason), /exited|closed the port|did not answer/i, JSON.stringify(s));
    // Two more tries of the bridge (the reconnect ladder: 3 s, then 4.5 s).
    await sleep(9_000);
    assert.deepEqual(unpaired(ext), [], `the extension opened the local socket: ${JSON.stringify(ext.sockets)}`);
    const later = await status(page);
    assert.equal(later.transport, null, JSON.stringify(later));
    assert.equal(later.wsConnected, false);
    // The desktop's port answers its health check, so the panel says where to repair the bridge, never "Connected".
    assert.equal(later.desktopRequiresBridge, true, JSON.stringify(later));
  });
});

describe('an installed bridge that cannot read its own install, in a profile where it never answered', () => {
  let ext;
  before(async () => { ext = await launchExtension({ nativeHost: 'no-key' }); }, { timeout: 60_000 });
  after(async () => { await ext?.close(); });

  test('uses the local socket as 0.14.0 did, so a desktop up to v0.10.8, which admits it, keeps browser control', () => {
    assert.equal(ext.announced?.transport, 'websocket', JSON.stringify(ext.announced));
    assert.ok(unpaired(ext).length >= 1, JSON.stringify(ext.sockets));
  });
});

describe('a bridge that answered once in this profile', () => {
  let ext;
  let page;
  before(async () => {
    ext = await launchExtension({ nativeHost: 'relay' });
    page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/options.html`);
  }, { timeout: 60_000 });
  after(async () => { await ext?.close(); });

  test('the first channel is the bridge', () => {
    assert.equal(ext.announced?.transport, 'native', JSON.stringify(ext.announced));
    assert.deepEqual(unpaired(ext), []);
  });

  test('then a bridge that cannot reach the desktop never sends it to the local socket', async () => {
    ext.nativeHostMode('unreachable');
    ext.dropSockets();
    const s = await until(() => status(page), (v) => v?.transport === null && /exited|closed the port|did not answer/i.test(String(v?.nativeUnavailableReason)), 20_000);
    assert.equal(s.transport, null, JSON.stringify(s));
    await sleep(6_000);
    assert.deepEqual(unpaired(ext), [], `the extension opened the local socket: ${JSON.stringify(ext.sockets)}`);
  });

  test('a bridge that can reach the desktop again reconnects as before', async () => {
    ext.nativeHostMode('relay');
    ext.dropSockets();
    const s = await until(() => status(page), (v) => v?.transport === 'native', 45_000);
    assert.equal(s.transport, 'native', JSON.stringify(s));
    assert.ok(ext.sockets.filter((x) => x.paired).length >= 2, JSON.stringify(ext.sockets));
  });

  test('and once the bridge answered here, a bridge that cannot read its own install is one to repair, never the local socket', async () => {
    ext.nativeHostMode('no-key');
    ext.dropSockets();
    const s = await until(() => status(page), (v) => v?.transport === null && /exited|closed the port/i.test(String(v?.nativeUnavailableReason)), 20_000);
    assert.equal(s.transport, null, JSON.stringify(s));
    await sleep(6_000);
    assert.deepEqual(unpaired(ext), [], `the extension opened the local socket: ${JSON.stringify(ext.sockets)}`);
  });

  test('and once the bridge answered here, a manifest that is gone is a bridge to repair, never the local socket', async () => {
    ext.removeNativeHost();
    ext.dropSockets();
    const s = await until(() => status(page), (v) => v?.transport === null && /not found/i.test(String(v?.nativeUnavailableReason)), 30_000);
    assert.match(String(s.nativeUnavailableReason), /Specified native messaging host not found/, JSON.stringify(s));
    await sleep(6_000);
    assert.deepEqual(unpaired(ext), [], `the extension opened the local socket: ${JSON.stringify(ext.sockets)}`);
    const later = await status(page);
    assert.equal(later.desktopRequiresBridge, true, JSON.stringify(later));
    const text = page.locator('#statusText');
    await page.reload();
    await until(() => text.innerText(), (t) => t.includes('Reinstall browser connection'), 15_000);
    assert.match(await text.innerText(), /Reinstall browser connection/);
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
