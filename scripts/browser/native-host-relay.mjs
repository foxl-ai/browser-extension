#!/usr/bin/env node
/**
 * THE HARNESS'S BROWSER BRIDGE: a native-messaging host that Chromium starts for the extension under test,
 * standing in for the one Foxl Desktop installs, and relaying to scripts/browser/harness.mjs instead of a
 * desktop. Installed only by `launchExtension({ nativeHost })`, only into that run's profile, under the
 * harness's own host name.
 *
 * It speaks the channel docs/DEVELOPMENT.md documents ("The native channel to Foxl Desktop"), with Chrome's
 * framing (developer.chrome.com/docs/extensions/develop/concepts/native-messaging, "Native messaging
 * protocol": each message is UTF-8 JSON preceded by its 32-bit length in native byte order):
 *   - `{ type: "ping" }` is answered `{ type: "pong" }` only once the socket to the harness is open;
 *   - every other frame is relayed to the harness as JSON text, and the harness's frames come back as objects;
 *   - the socket presents the harness's pairing value and the caller origin Chrome passed as argv[2].
 * `FOXL_HARNESS_BRIDGE_MODE=unreachable` answers the ping with `{ type: "error", error: "desktop_unreachable" }`
 * and exits, as Foxl Desktop's bridge does when it cannot reach the desktop.
 *
 * Stdout carries frames only; everything else goes to stderr, which Chrome keeps in its own log.
 */
import { endianness } from 'node:os';
import { WebSocket } from 'ws';

const URL_TO_HARNESS = process.env.FOXL_HARNESS_BRIDGE_URL || '';
const MODE = process.env.FOXL_HARNESS_BRIDGE_MODE || 'relay';
const CALLER = process.argv[2] || '';
const LE = endianness() === 'LE';

function write(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length, 0); else head.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let socket = null;
let opening = null;
function open() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const url = new URL(URL_TO_HARNESS);
    url.searchParams.set('caller', CALLER);
    const ws = new WebSocket(url.toString());
    ws.on('open', () => { socket = ws; resolve(ws); });
    ws.on('message', (raw) => {
      try { write(JSON.parse(String(raw))); } catch (err) { process.stderr.write(`[harness-bridge] bad frame from the harness: ${err.message}\n`); }
    });
    ws.on('close', () => { if (socket) process.exit(0); reject(new Error('the harness closed the socket')); });
    ws.on('error', (err) => reject(err));
  });
  return opening;
}

let queue = Promise.resolve();
async function handle(message) {
  if (message?.type === 'ping') {
    if (MODE === 'unreachable') {
      write({ type: 'error', error: 'desktop_unreachable', message: 'the harness bridge was told not to reach the harness' });
      process.exit(0);
    }
    try {
      await open();
      write({ type: 'pong' });
    } catch (err) {
      write({ type: 'error', error: 'desktop_unreachable', message: err.message });
      process.exit(0);
    }
    return;
  }
  const ws = await open().catch(() => null);
  if (ws) ws.send(JSON.stringify(message));
}

let buffered = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = LE ? buffered.readUInt32LE(0) : buffered.readUInt32BE(0);
    if (buffered.length < 4 + length) break;
    const body = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);
    let message;
    try { message = JSON.parse(body.toString('utf8')); } catch { continue; }
    queue = queue.then(() => handle(message)).catch((err) => process.stderr.write(`[harness-bridge] ${err.message}\n`));
  }
});
process.stdin.on('end', () => { try { socket?.close(); } catch { /* gone */ } process.exit(0); });
process.stderr.write(`[harness-bridge] ready (caller ${CALLER || 'unknown'}, mode ${MODE})\n`);
