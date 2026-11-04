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
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'store', 'docs', '.store-research']);

/** A copy of the extension whose service worker looks for the desktop on `port` only. */
function extensionCopy(port, grant = []) {
  const source = process.env.FOXL_EXTENSION_DIR ? resolve(process.env.FOXL_EXTENSION_DIR) : ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'foxl-extension-'));
  cpSync(source, dir, { recursive: true, filter: (from) => !SKIP.has(from.slice(source.length + 1).split(/[\\/]/)[0]) });
  const worker = join(dir, 'src', 'service-worker.js');
  const text = readFileSync(worker, 'utf8');
  const pattern = /const SERVER_PORTS = \[13847, 3847\];/g;
  const found = text.match(pattern)?.length ?? 0;
  if (found !== 1) throw new Error(`expected SERVER_PORTS = [13847, 3847] once in ${worker}, found ${found}: refusing to run against a real desktop's ports`);
  writeFileSync(worker, text.replace(pattern, `const SERVER_PORTS = [${port}];`));
  if (grant.length) {
    const path = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    for (const name of grant) {
      if (!(manifest.optional_permissions ?? []).includes(name)) throw new Error(`"${name}" is not an optional permission of this build`);
      manifest.optional_permissions = manifest.optional_permissions.filter((p) => p !== name);
      manifest.permissions = [...(manifest.permissions ?? []), name];
    }
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  }
  return dir;
}

/**
 * Starts the site + the desktop socket, then Chromium with the extension. `routes` maps a path to
 * `(req, res)`. Resolves once the extension's worker has connected and announced itself.
 */
export async function launchExtension({ routes = {}, grant = [] } = {}) {
  let socket = null;
  let hello = null;
  let nextId = 1;
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
    if (new URL(req.url, 'http://localhost').pathname !== '/extension') { sock.destroy(); return; }
    sockets.handleUpgrade(req, sock, head, (ws) => {
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
  let profile = null;
  let context = null;
  let announced;
  let helloTimer;
  try {
    extDir = extensionCopy(port, grant);
    profile = mkdtempSync(join(tmpdir(), 'foxl-extension-profile-'));
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      // Playwright turns Chrome's pop-up blocker off by default; a blocked pop-up is under test here.
      ignoreDefaultArgs: ['--disable-popup-blocking'],
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
      acceptDownloads: true,
    });
    announced = await Promise.race([
      helloSeen,
      new Promise((_, reject) => { helloTimer = setTimeout(() => reject(new Error('the extension never connected to the test desktop')), 20_000); }),
    ]);
  } catch (err) {
    await context?.close().catch(() => {});
    sockets.close();
    await new Promise((r) => server.close(r));
    if (extDir) rmSync(extDir, { recursive: true, force: true });
    if (profile) rmSync(profile, { recursive: true, force: true });
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
    sockets.close();
    await new Promise((r) => server.close(r));
    rmSync(extDir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  };
  return { context, origin, command, tabIdOf, announced, close };
}
