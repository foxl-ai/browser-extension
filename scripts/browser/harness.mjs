/**
 * THE REAL EXTENSION IN CHROMIUM, DRIVEN THE WAY FOXL DESKTOP DRIVES IT.
 *
 * `launchExtension()` copies this checkout (or `FOXL_EXTENSION_DIR`, another build: the red run
 * points it at a release's tree) to a temporary directory, loads it unpacked in Chromium
 * (Playwright's, a persistent profile, Chrome's pop-up blocker left ON), and serves on two
 * OS-assigned loopback ports the desktop's side of the protocol (`desktopOrigin`: `/api/health`
 * for the extension's discovery, the `/extension` WebSocket that sends `browser_command`
 * frames and reads `browser_result` ones, as docs/DEVELOPMENT.md documents them, and at `/` a page
 * standing in for the desktop's own app) and a fictional site (`origin`, the `routes`). Two ports,
 * because a tab Foxl works in never opens the connected desktop's port (foxl-ai/pilot #8212).
 *
 * The one change to the copy: `SERVER_PORTS` in its service worker names the desktop's port instead of
 * Foxl Desktop's (13847, 3847), so a test never reaches a real desktop running on the same machine
 * (the extension discovers a desktop by probing those ports). The rewrite must match exactly once,
 * or the harness refuses to start.
 *
 * `grant: ['downloads']` also moves that OPTIONAL permission into `permissions` in the copy, so it is
 * granted at load: headless Chromium cannot answer the prompt chrome.permissions.request opens
 * (measured: a click on the options page's Allow left it not granted). The shipped manifest keeps it
 * optional, which scripts/audit.mjs reports and the suite's not-granted case runs against.
 *
 * NEVER THE REAL BROWSER BRIDGE EITHER (0.14.0). The extension first asks Chrome for the native-messaging
 * host `ai.foxl.browser_bridge`, which Foxl Desktop installs for every Chromium browser it knows, and the
 * checkout's manifest carries the store item's `key`, so an unpacked copy has the store ID that host admits.
 * A test that reached that host would start the REAL bridge, which presents the real desktop's key to the
 * real desktop (on a Mac with Foxl Desktop, `~/Library/Application Support/Chromium/NativeMessagingHosts/
 * ai.foxl.browser_bridge.json` exists and admits the store ID). The run's profile is a fresh folder, and
 * Chromium 156 read user-level hosts from the profile's own NativeMessagingHosts folder on macOS and Linux
 * (native-bridge.test.mjs), so that host is out of reach already; the harness does not rely on it. A build
 * that declares `nativeMessaging` asks for `HARNESS_HOST_NAME` instead (the constant matched exactly once,
 * like SERVER_PORTS, or the harness refuses to start), and every copy carries a key minted for this run in
 * place of the store's, so its ID is one no installed host lists. `nativeHost` installs a host under that
 * name for this run's profile only (`native-host-relay.mjs`), connected to this harness.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'store', 'docs', '.store-research']);

/** What the desktop's own port serves at `/` here, standing in for its app (foxl-ai/pilot server.ts `serveSpa`). */
export const DESKTOP_APP_PAGE = '<!doctype html><html><head><title>Foxl Desktop</title></head><body><h1>Foxl Desktop app</h1><p id="chats">Recent chats of the person</p><button id="setting">Allow every tool</button></body></html>';

/** The native-messaging host a copy asks for: no Foxl Desktop installs one by this name. */
export const HARNESS_HOST_NAME = 'ai.foxl.browser_bridge_harness';
const STORE_ID = 'ijlihobebaeangjiacfomjdkhlpbmlhi';

/** A key minted for one run, and the extension ID Chrome derives from it (SHA-256 of the DER key, 0-f as a-p). */
function runKey() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const id = createHash('sha256').update(der).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  return { key: der.toString('base64'), id };
}

/** A copy of the extension whose service worker looks for the desktop on `port` only, with this run's key. */
function extensionCopy(port, grant = []) {
  const source = process.env.FOXL_EXTENSION_DIR ? resolve(process.env.FOXL_EXTENSION_DIR) : ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'foxl-extension-'));
  cpSync(source, dir, { recursive: true, filter: (from) => !SKIP.has(from.slice(source.length + 1).split(/[\\/]/)[0]) });
  const worker = join(dir, 'src', 'service-worker.js');
  let text = readFileSync(worker, 'utf8');
  const pattern = /const SERVER_PORTS = \[13847, 3847\];/g;
  const found = text.match(pattern)?.length ?? 0;
  if (found !== 1) throw new Error(`expected SERVER_PORTS = [13847, 3847] once in ${worker}, found ${found}: refusing to run against a real desktop's ports`);
  text = text.replace(pattern, `const SERVER_PORTS = [${port}];`);
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if ((manifest.permissions ?? []).includes('nativeMessaging') || (manifest.optional_permissions ?? []).includes('nativeMessaging')) {
    const host = /const NATIVE_HOST_NAME = 'ai\.foxl\.browser_bridge';/g;
    const hosts = text.match(host)?.length ?? 0;
    if (hosts !== 1) throw new Error(`expected NATIVE_HOST_NAME = 'ai.foxl.browser_bridge' once in ${worker}, found ${hosts}: refusing to run a build that could reach a real desktop's bridge`);
    text = text.replace(host, `const NATIVE_HOST_NAME = '${HARNESS_HOST_NAME}';`);
  }
  writeFileSync(worker, text);
  const { key, id } = runKey();
  if (id === STORE_ID) throw new Error('a run key derived to the store ID');
  manifest.key = key;
  for (const name of grant) {
    if (!(manifest.optional_permissions ?? []).includes(name)) throw new Error(`"${name}" is not an optional permission of this build`);
    manifest.optional_permissions = manifest.optional_permissions.filter((p) => p !== name);
    manifest.permissions = [...(manifest.permissions ?? []), name];
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return { dir, id };
}

/** Single-quoted for /bin/sh. */
const sh = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * This run's host: a manifest named `HARNESS_HOST_NAME` in the profile's own NativeMessagingHosts folder, admitting
 * exactly the copy's ID, whose program runs `native-host-relay.mjs` against `url`. The profile is
 * `<XDG_CONFIG_HOME>/chromium`, the layout Linux Chromium reads user-level hosts from (developer.chrome.com/docs/
 * extensions/develop/concepts/native-messaging, "Native messaging host location"), and the browser gets that
 * XDG_CONFIG_HOME; macOS Chromium read the same folder of the same profile (measured, Chromium 156). Nothing
 * outside the run's folder is read or written.
 */
function installHarnessHost({ profile, config, id, url, mode }) {
  const program = join(config, 'foxl-harness-bridge');
  const relay = join(ROOT, 'scripts', 'browser', 'native-host-relay.mjs');
  // The mode is read from this file at every launch, so a test can change what the next bridge does (`nativeHostMode`).
  const modeFile = join(config, 'foxl-harness-bridge.mode');
  writeFileSync(modeFile, mode);
  writeFileSync(program, `#!/bin/sh\nFOXL_HARNESS_BRIDGE_URL=${sh(url)} FOXL_HARNESS_BRIDGE_MODE_FILE=${sh(modeFile)} exec ${sh(process.execPath)} ${sh(relay)} "$@"\n`);
  chmodSync(program, 0o755);
  const hosts = join(profile, 'NativeMessagingHosts');
  mkdirSync(hosts, { recursive: true });
  const manifest = join(hosts, `${HARNESS_HOST_NAME}.json`);
  writeFileSync(manifest, JSON.stringify({
    name: HARNESS_HOST_NAME,
    description: 'Foxl extension test harness bridge',
    path: program,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2));
  return { modeFile, manifest };
}

/**
 * Starts the site + the desktop socket, then Chromium with the extension. `routes` maps a path to
 * `(req, res)`. Resolves once the extension's worker has connected and announced itself.
 *
 * `refuseSocket: 4004` closes every `/extension` socket at once with that code, as a Foxl Desktop that requires
 * the verified browser connection refuses an unpaired one (0.14.0); the launch then resolves without waiting for
 * an announcement, and `announced` is null. A socket the run's own bridge opens is never refused.
 *
 * `nativeHost: 'relay'` installs this run's bridge (`installHarnessHost`), which reaches this harness with
 * `?pairing=<this run's value>` the way Foxl Desktop's bridge presents its key; `'unreachable'` installs one that
 * answers the extension's ping with an error frame and exits, as the real bridge does when it cannot reach the
 * desktop, and `'no-key'` one that answers it `no pairing key` and exits, as the real bridge does when it cannot
 * read its own install. `sockets` lists every `/extension` socket the harness accepted or refused, in order:
 * `{ paired, caller, refused }` (`caller` is the origin Chrome gave the bridge as its first argument).
 *
 * `expectHello: false` resolves without waiting for an announcement (`announced` is null), for a launch that must open
 * no channel. With a bridge installed, `nativeHostMode(mode)` changes what the NEXT bridge Chrome starts does,
 * `removeNativeHost()` deletes its manifest (Chrome then answers "Specified native messaging host not found."), and
 * `dropSockets()` closes every live `/extension` socket, as a desktop that quits does (a bridge exits with its socket).
 * `holdSockets()` refuses every new `/extension` socket until the function it returns is called, as no desktop running.
 */
export async function launchExtension({ routes = {}, grant = [], refuseSocket = null, nativeHost = null, expectHello = !(refuseSocket && nativeHost !== 'relay') } = {}) {
  let socket = null;
  let hello = null;
  let nextId = 1;
  const pairing = randomBytes(16).toString('hex');
  const seen = [];
  /** Every frame the extension sent but its pings and command answers (`stop_agent`, `chat`, ...), in order. */
  const frames = [];
  const waiting = new Map();
  let onHello;
  const helloSeen = new Promise((r) => { onHello = r; });

  // The desktop's side: discovery, the socket below, and its own app's page.
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DESKTOP_APP_PAGE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  // The fictional site, on a port of its own.
  const site = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const route = routes[path];
    if (route) return route(req, res);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  site.on('upgrade', (req, sock) => { sock.destroy(); });
  const sockets = new WebSocketServer({ noServer: true });
  let socketsHeld = false;
  server.on('upgrade', (req, sock, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/extension' || socketsHeld) { sock.destroy(); return; }
    sockets.handleUpgrade(req, sock, head, (ws) => {
      const paired = url.searchParams.get('pairing') === pairing;
      const entry = { paired, caller: url.searchParams.get('caller'), refused: false };
      seen.push(entry);
      if (refuseSocket && !paired) { entry.refused = true; ws.close(refuseSocket, 'extension_pairing_required'); return; }
      socket = ws;
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'extension_connected') { hello = msg.data ?? {}; onHello(hello); }
        if (msg.type !== 'ping' && msg.type !== 'browser_result') frames.push(msg);
        if (msg.type === 'browser_result' && waiting.has(msg.requestId)) {
          waiting.get(msg.requestId)(msg.data);
          waiting.delete(msg.requestId);
        }
      });
      ws.send(JSON.stringify({ type: 'connected', version: 'test-desktop' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const desktopOrigin = `http://localhost:${port}`;
  const origin = `http://localhost:${site.address().port}`;

  /*
   * A launch that fails after the server is listening closes it again: a listening loopback server
   * keeps node alive after the last test, and the run then never ends (measured: a red run against
   * 0.10.0, whose manifest has no optional `downloads` to grant, hung for 25 minutes).
   */
  let extDir = null;
  let config = null;
  let context = null;
  let announced;
  let helloTimer;
  let extensionId = null;
  let host = null;
  try {
    ({ dir: extDir, id: extensionId } = extensionCopy(port, grant));
    config = mkdtempSync(join(tmpdir(), 'foxl-extension-profile-'));
    const profile = join(config, 'chromium');
    mkdirSync(profile, { recursive: true });
    if (nativeHost) {
      if (!['relay', 'unreachable', 'no-key'].includes(nativeHost)) throw new Error(`nativeHost must be 'relay', 'unreachable' or 'no-key', got ${JSON.stringify(nativeHost)}`);
      host = installHarnessHost({ profile, config, id: extensionId, url: `ws://127.0.0.1:${port}/extension?pairing=${pairing}`, mode: nativeHost });
    }
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      // Playwright turns Chrome's pop-up blocker off by default; a blocked pop-up is under test here.
      ignoreDefaultArgs: ['--disable-popup-blocking'],
      // No name resolves but localhost and 127.0.0.1 (the rules map an IP literal too, measured), so nothing a test
      // types (desktop.example) leaves this computer.
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
      acceptDownloads: true,
      env: { ...process.env, XDG_CONFIG_HOME: config },
    });
    announced = !expectHello ? null : await Promise.race([
      helloSeen,
      new Promise((_, reject) => { helloTimer = setTimeout(() => reject(new Error('the extension never connected to the test desktop')), 20_000); }),
    ]);
  } catch (err) {
    await context?.close().catch(() => {});
    sockets.close();
    await new Promise((r) => server.close(r));
    await new Promise((r) => site.close(r));
    if (extDir) rmSync(extDir, { recursive: true, force: true });
    if (config) rmSync(config, { recursive: true, force: true });
    throw err;
  } finally {
    clearTimeout(helloTimer);
  }

  /** One command, as the desktop sends it; resolves to the extension's `browser_result` data. */
  /** `extra` adds fields beside `action`, `tabId` and `params` (a desktop's `run`). */
  const command = (action, tabId, params = {}, extra = {}) => new Promise((resolveResult, reject) => {
    if (!socket) { reject(new Error('no extension socket')); return; }
    const requestId = `r${nextId++}`;
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`${action}: no browser_result in 20 s`)); }, 20_000);
    waiting.set(requestId, (data) => { clearTimeout(timer); resolveResult(data); });
    socket.send(JSON.stringify({ type: 'browser_command', requestId, data: { action, ...(tabId ? { tabId } : {}), params, ...extra } }));
  });

  /** One frame of the desktop's other kinds (`show_indicators`, `hide_indicators`), as the desktop sends it. */
  const send = (frame) => {
    if (!socket) throw new Error('no extension socket');
    socket.send(JSON.stringify(frame));
  };

  /** The extension's own service worker, for what a person does in Chrome's own UI. */
  const ownWorker = (w) => w.url().startsWith(`chrome-extension://${extensionId}/`);
  const extensionWorker = async () => context.serviceWorkers().filter(ownWorker).at(-1)
    ?? context.waitForEvent('serviceworker', { predicate: ownWorker, timeout: 10_000 });

  /**
   * WHAT AN UPDATE OF THE EXTENSION DOES TO FOXL'S OWN STATE, played without reloading it: chrome.storage.session is
   * cleared and the worker is stopped, so the next event starts it with nothing in memory, while the browser's tabs and
   * tab groups stay with their ids. chrome.runtime.reload() is not playable here: it unloads the copy, whose pages then
   * answer ERR_BLOCKED_BY_CLIENT (measured, Playwright 1.64.1's Chromium on Ubuntu 24.04). The worker is stopped with
   * CDP Target.closeTarget on its service-worker target, from a page's session; the target is then gone, the next
   * event starts the worker with an empty global scope (measured the same way). Unlike a real update, content scripts
   * already in a page stay connected. Resolves once the extension has connected to this desktop again: its options
   * page asks, as a person's would.
   */
  const simulateUpdate = async () => {
    const hellos = frames.filter((f) => f.type === 'extension_connected').length;
    const worker = await extensionWorker();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const swTarget = async () => (await cdp.send('Target.getTargets')).targetInfos
      .find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
    try {
      const target = await swTarget();
      if (!target) throw new Error('no service-worker target for the extension');
      await worker.evaluate(() => chrome.storage.session.clear());
      await cdp.send('Target.closeTarget', { targetId: target.targetId });
      for (const end = Date.now() + 5_000; await swTarget() && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      if (await swTarget()) throw new Error('the extension\'s worker did not stop');
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      for (const end = Date.now() + 45_000; frames.filter((f) => f.type === 'extension_connected').length <= hellos && Date.now() < end;) {
        await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' })).catch(() => {});
        await new Promise((r) => setTimeout(r, 1_000));
      }
    } finally {
      await cdp.detach().catch(() => {});
      await page.close().catch(() => {});
    }
    if (frames.filter((f) => f.type === 'extension_connected').length <= hellos) throw new Error('the extension never connected again after the simulated update');
    return extensionWorker();
  };

  /**
   * The extension's tab id for a Playwright page (matched by URL, asked of Chrome as the person's own browser knows it:
   * get_tabs names only Foxl's tabs since 0.14.1), HANDED TO FOXL the way a person does it: moved into Foxl's own tab
   * group (dragged there in Chrome's tab strip). Foxl acts only in its own tabs (0.14.1, foxl-ai/pilot #7802), and a
   * page a test opens with Playwright is the person's until then. Foxl knows its groups by the id it recorded when it
   * made them, so when there is none yet, Foxl opens a blank tab (`new_tab`, which makes the group) and the person
   * closes that tab once theirs is in the group. `{ handOver: false }` leaves it the person's.
   */
  let foxlGroup = null; // the group Foxl made, as this harness has seen it
  const tabIdOf = async (page, { handOver = true } = {}) => {
    const worker = await extensionWorker();
    const tabs = await worker.evaluate(() => chrome.tabs.query({}).then((all) => all.map((t) => ({ id: t.id, url: t.url }))));
    const tab = tabs.find((t) => t.url === page.url());
    if (!tab) throw new Error(`no tab for ${page.url()} in ${JSON.stringify(tabs)}`);
    if (handOver) {
      const moveInto = (groupId) => worker.evaluate(async ({ id, groupId }) => {
        try { await chrome.tabs.group({ tabIds: [id], groupId }); return true; } catch { return false; }
      }, { id: tab.id, groupId });
      if (foxlGroup == null || !(await moveInto(foxlGroup))) {
        // No url: a blank tab, made at once (with a url, new_tab waits for that page to load).
        const opened = await command('new_tab', undefined, {});
        if (!opened?.success || !Number.isInteger(opened.groupId)) throw new Error(`Foxl opened no tab to make its group: ${JSON.stringify(opened)}`);
        foxlGroup = opened.groupId;
        if (!(await moveInto(foxlGroup))) throw new Error(`could not move ${page.url()} into Foxl's group`);
        await worker.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), opened.tabId);
      }
    }
    return tab.id;
  };

  /** A tab group the person makes in Chrome's tab strip, under a name of their own; resolves to its id. */
  const personGroup = async (tabId, title) => {
    const worker = await extensionWorker();
    return worker.evaluate(async ({ id, title }) => {
      const t = await chrome.tabs.get(id);
      const groupId = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId: t.windowId } });
      await chrome.tabGroups.update(groupId, { title });
      return groupId;
    }, { id: tabId, title });
  };

  const close = async () => {
    await context.close().catch(() => {});
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    server.closeAllConnections?.();
    site.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await new Promise((r) => site.close(r));
    rmSync(extDir, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  };

  const needHost = () => { if (!host) throw new Error('this launch installed no bridge (nativeHost)'); };
  /** What the next bridge Chrome starts does: 'relay', 'unreachable' or 'no-key'. */
  const nativeHostMode = (mode) => {
    needHost();
    if (!['relay', 'unreachable', 'no-key'].includes(mode)) throw new Error(`mode must be 'relay', 'unreachable' or 'no-key', got ${JSON.stringify(mode)}`);
    writeFileSync(host.modeFile, mode);
  };
  /** The bridge's manifest is gone, as when Foxl Desktop is moved or removed. */
  const removeNativeHost = () => { needHost(); rmSync(host.manifest, { force: true }); };
  /** Every live /extension socket closes, as a desktop that quits closes them. */
  const dropSockets = () => {
    for (const ws of sockets.clients) ws.terminate();
    socket = null;
  };
  /** Until the returned function is called, the desktop takes no new /extension socket (a desktop that is not running). */
  const holdSockets = () => {
    socketsHeld = true;
    return () => { socketsHeld = false; };
  };
  return { context, origin, desktopOrigin, desktopPort: port, command, send, frames, tabIdOf, personGroup, announced, close, extensionId, sockets: seen, nativeHostMode, removeNativeHost, dropSockets, holdSockets, simulateUpdate, extensionWorker };
}
