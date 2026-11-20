/**
 * THE REAL EXTENSION IN CHROMIUM, DRIVEN THE WAY FOXL DESKTOP DRIVES IT.
 *
 * `launchExtension()` copies this checkout (or `FOXL_EXTENSION_DIR`, another build: the red run
 * points it at a release's tree) to a temporary directory, loads it unpacked in Chromium
 * (Playwright's, a persistent profile, Chrome's pop-up blocker left ON), and serves on one
 * OS-assigned loopback port both a fictional site and the desktop's side of the protocol: `/api/health`
 * for the extension's discovery, and the `/extension` WebSocket that sends `browser_command`
 * frames and reads `browser_result` ones, as docs/DEVELOPMENT.md documents them.
 *
 * The one change to the copy: `SERVER_PORTS` in its service worker names that port instead of
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
  writeFileSync(program, `#!/bin/sh\nFOXL_HARNESS_BRIDGE_URL=${sh(url)} FOXL_HARNESS_BRIDGE_MODE=${sh(mode)} exec ${sh(process.execPath)} ${sh(relay)} "$@"\n`);
  chmodSync(program, 0o755);
  const hosts = join(profile, 'NativeMessagingHosts');
  mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, `${HARNESS_HOST_NAME}.json`), JSON.stringify({
    name: HARNESS_HOST_NAME,
    description: 'Foxl extension test harness bridge',
    path: program,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2));
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
 * desktop. `sockets` lists every `/extension` socket the harness accepted or refused, in order:
 * `{ paired, caller, refused }` (`caller` is the origin Chrome gave the bridge as its first argument).
 */
export async function launchExtension({ routes = {}, grant = [], refuseSocket = null, nativeHost = null } = {}) {
  let socket = null;
  let hello = null;
  let nextId = 1;
  const pairing = randomBytes(16).toString('hex');
  const seen = [];
  const waiting = new Map();
  let onHello;
  const helloSeen = new Promise((r) => { onHello = r; });

  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    const route = routes[path];
    if (route) return route(req, res);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/extension') { sock.destroy(); return; }
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
        if (msg.type === 'browser_result' && waiting.has(msg.requestId)) {
          waiting.get(msg.requestId)(msg.data);
          waiting.delete(msg.requestId);
        }
      });
      ws.send(JSON.stringify({ type: 'connected', version: 'test-desktop' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = `http://localhost:${port}`;

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
  try {
    ({ dir: extDir, id: extensionId } = extensionCopy(port, grant));
    config = mkdtempSync(join(tmpdir(), 'foxl-extension-profile-'));
    const profile = join(config, 'chromium');
    mkdirSync(profile, { recursive: true });
    if (nativeHost) {
      if (!['relay', 'unreachable'].includes(nativeHost)) throw new Error(`nativeHost must be 'relay' or 'unreachable', got ${JSON.stringify(nativeHost)}`);
      installHarnessHost({ profile, config, id: extensionId, url: `ws://127.0.0.1:${port}/extension?pairing=${pairing}`, mode: nativeHost });
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
    announced = refuseSocket && nativeHost !== 'relay' ? null : await Promise.race([
      helloSeen,
      new Promise((_, reject) => { helloTimer = setTimeout(() => reject(new Error('the extension never connected to the test desktop')), 20_000); }),
    ]);
  } catch (err) {
    await context?.close().catch(() => {});
    sockets.close();
    await new Promise((r) => server.close(r));
    if (extDir) rmSync(extDir, { recursive: true, force: true });
    if (config) rmSync(config, { recursive: true, force: true });
    throw err;
  } finally {
    clearTimeout(helloTimer);
  }

  /** One command, as the desktop sends it; resolves to the extension's `browser_result` data. */
  const command = (action, tabId, params = {}) => new Promise((resolveResult, reject) => {
    if (!socket) { reject(new Error('no extension socket')); return; }
    const requestId = `r${nextId++}`;
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`${action}: no browser_result in 20 s`)); }, 20_000);
    waiting.set(requestId, (data) => { clearTimeout(timer); resolveResult(data); });
    socket.send(JSON.stringify({ type: 'browser_command', requestId, data: { action, ...(tabId ? { tabId } : {}), params } }));
  });

  /** The extension's tab id for a Playwright page (matched by URL through get_tabs). */
  const tabIdOf = async (page) => {
    const tabs = await command('get_tabs');
    const tab = tabs.tabs?.find((t) => t.url === page.url());
    if (!tab) throw new Error(`no tab for ${page.url()} in ${JSON.stringify(tabs)}`);
    return tab.id;
  };

  const close = async () => {
    await context.close().catch(() => {});
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(extDir, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  };
  return { context, origin, command, tabIdOf, announced, close, extensionId, sockets: seen };
}
