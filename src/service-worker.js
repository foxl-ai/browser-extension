/**
 * Foxl Chrome Extension - Service Worker
 * 
 * Background script that handles:
 * - Side panel management
 * - Communication with Foxl server via WebSocket
 * - Browser automation commands from server
 * - Tab management
 */

import { createInputQueue } from './input-queue.js';
import { captureTabScreenshot, readAllowedPage } from './page-capture.js';
import { getPageSnapshot, clearPageSnapshots } from './page-snapshot.js';
import { loopbackServerUrl } from './server-url.js';
// globalThis.__foxlFilledPrint, the page reader's own fingerprint (WHAT A SAVED SIGN-IN TYPED, below).
import './content-scripts/filled-print.js';

// Configuration - try production port first, then dev
const SERVER_PORTS = [13847, 3847];
const DEFAULT_SERVER_URL = `http://localhost:${SERVER_PORTS[0]}`;

/*
 * THE VERSION HANDSHAKE. This extension auto-updates from the Chrome Web Store; the
 * desktop app waits for a person to install an update. So the extension running
 * AHEAD of the desktop is a matter of time, not of chance, and before this the drift
 * was invisible: the extension announced its version in `extension_connected` and
 * nothing ever replied, while the desktop's own `connected` frame carried the
 * hardcoded literal `1.0.0`.
 *
 * 🔴 `1.0.0` MEANS "UNKNOWN", NOT "NEWER THAN THE FLOOR". Every desktop shipped before
 * this change sends that literal, and comparing it numerically would read as a very
 * new build. It is treated as unknown and never warned about - a false "your desktop
 * is too old" on a working setup is worse than silence, because it teaches the user
 * to ignore the next one.
 */
/*
 * 0.6.5 IS THE FIRST DESKTOP THAT REPORTS A REAL VERSION - everything before it sends
 * the literal `1.0.0`, which is treated as UNKNOWN below and never warned about. So
 * this floor is not a guess about compatibility: it is "the oldest build that can be
 * identified at all", which is the only honest thing to compare against.
 *
 * WHEN TO MOVE IT: only when a specific desktop behaviour becomes required here, and
 * then to the version that introduced it. Do not raise it to "the current release" as
 * a habit - the extension auto-updates from the store and the desktop does not, so a
 * floor at HEAD would warn every user who has not restarted their app today.
 */
const MIN_DESKTOP_VERSION = '0.6.5';
const UNKNOWN_DESKTOP_VERSION = '1.0.0';
let desktopVersion = null;

/** Numeric compare, prerelease ignored. Returns -1 / 0 / 1. */
function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** null when unknown; true only when a REAL version is below the floor. */
function desktopIsTooOld() {
  if (!desktopVersion || desktopVersion === UNKNOWN_DESKTOP_VERSION) return null;
  return compareVersions(desktopVersion, MIN_DESKTOP_VERSION) < 0;
}

/*
 * HOW LONG "I HAVE SEEN A DESKTOP" STAYS TRUE.
 *
 * The panel shows one of two screens when nothing answers: "Foxl Desktop is required"
 * (with the download) or "Reconnecting" (without it). A boolean can only ever be SET,
 * so somebody who UNINSTALLS the desktop is shown "it reconnects automatically as soon
 * as the app is running again" permanently - a sentence that is simply false for them,
 * about an app they no longer have, with no way back to the install screen.
 *
 * 30 days, and the number is a judgement between two real users: someone away for a
 * fortnight with the app closed must NOT be told to reinstall, and someone who removed
 * it should not be told to wait forever. Both errors are recoverable here - the
 * reconnecting screen also carries a quiet install link (`setupGone`) - so this only
 * decides which screen leads.
 */
const DESKTOP_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Has a desktop been reachable recently enough to believe it still exists?
 *
 * PURE, so both odd clocks can be reasoned about rather than discovered in the field:
 *  - no record at all -> false. This is the never-installed case the flag exists for.
 *  - a stamp inside the window -> true.
 *  - a stamp older than the window -> false, which is the whole point.
 *  - a stamp in the FUTURE -> true, and the CALLER re-stamps it to now. The write
 *    itself is evidence a desktop really connected, so the honest reading is "recent
 *    with an unusable clock", not "never happened"; re-stamping is what stops a
 *    fabricated far-future date from making the memory permanent again.
 *  - the legacy BOOLEAN with no stamp -> true, likewise re-stamped by the caller. An
 *    already-installed extension must not be demoted to the install screen just
 *    because it predates the timestamp.
 */
function hasRecentDesktop(stored, nowMs) {
  const ts = Number(stored?.lastConnectedAt);
  if (Number.isFinite(ts) && ts > 0) {
    if (ts > nowMs) return true;
    return nowMs - ts < DESKTOP_MEMORY_MS;
  }
  return !!stored?.everConnected;
}

/** True when the record says "connected" but carries no usable date. */
function needsDateRepair(stored, nowMs) {
  const ts = Number(stored?.lastConnectedAt);
  if (!hasRecentDesktop(stored, nowMs)) return false;
  return !Number.isFinite(ts) || ts <= 0 || ts > nowMs;
}

// State
let serverSocket = null;
let isConnecting = false; // Prevent duplicate connections
let reconnectTimer = null;
let pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
let pilotTabGroupId = null; // Pilot's dedicated tab group
let discoveredServerUrl = null; // Cached auto-discovered URL

// Multi-tab context: tracks all tabs the agent is working with
// { tabId -> { label?: string, createdAt: number } }
let tabContexts = new Map();
let focusedTabId = null; // The tab currently focused for agent operations

/*
 * WHAT THIS BUILD CAN DO BEYOND ITS VERSION, announced in `extension_connected` (additive: every
 * build before 0.11.0 sends `{ version }` only). #6245: tree lines mark what they cut and what is
 * not shown (`read-marks`), one element's whole text is read by ref (`read-text`), a Foxl task
 * tab's downloads are reported (`downloads`), and tabs carry their opener (`tab-openers`).
 * 0.12.0 (foxl-ai/pilot #6394): a click or a key press waits for what it started and reports it,
 * and holds back a form the desktop's chat already sent (`step-watch`, step-watch.js).
 * 0.12.1: a sign-in saved in Foxl Desktop is typed into the tab's own page (`fill-sign-in`, `fill_sign_in`).
 */
const CAPABILITIES = ['read-marks', 'read-text', 'downloads', 'tab-openers', 'step-watch', 'fill-sign-in'];

/*
 * WHERE FOXL LAST ACTED: the last time Foxl clicked, typed, pressed a key, chose an option or
 * navigated in each tab, the steps that can start a download. A download is Foxl's to report only
 * when such a tab, acted in within DOWNLOAD_MATCH_MS, is on the download's origin (#6245).
 */
const actedTabs = new Map(); // tabId -> { at: ms, origin }

// Enable side panel to open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[Foxl] Failed to set panel behavior:', error));

/**
 * Get server URL from storage, or auto-discover by probing ports
 */
async function getServerUrl() {
  // An address the person set, when it is on this computer (src/server-url.js, foxl-ai/pilot #7806). One an
  // earlier build stored for another host is never used: discovery runs instead, and the options page says so.
  const result = await chrome.storage.local.get(['serverUrl']);
  const saved = loopbackServerUrl(result.serverUrl);
  if (saved) {
    return saved;
  }

  // Return cached discovery if still valid
  if (discoveredServerUrl) {
    return discoveredServerUrl;
  }

  // Auto-discover: try each port with a quick health check
  for (const port of SERVER_PORTS) {
    const url = `http://localhost:${port}`;
    try {
      const resp = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (resp.ok) {
        console.log(`[Foxl] Auto-discovered server at ${url}`);
        discoveredServerUrl = url;
        return url;
      }
    } catch (_) {
      // Port not responding, try next
    }
  }

  // Nothing found - fall back to production port
  return DEFAULT_SERVER_URL;
}

/**
 * Clear cached discovery (called on disconnect so next connect re-probes)
 */
function clearDiscoveredUrl() {
  discoveredServerUrl = null;
}

/*
 * ══════════════════════════════════════════════════════════════════════════════
 *  THE LOCAL CHANNEL: NATIVE MESSAGING FIRST, THE WebSocket SECOND
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * A LOOPBACK WebSocket CANNOT TELL THIS EXTENSION FROM ANY OTHER PROGRAM ON THE
 * MACHINE, AND NO AMOUNT OF CARE AT THIS END FIXES THAT. The desktop's `/extension`
 * path used to be gated on the `Origin:` header alone. A BROWSER sets that header and
 * a web page cannot forge it, which makes it a real defence against a page - and it is
 * worth exactly nothing against a process, because a raw socket writes whatever bytes
 * it likes into the handshake. Measured against the real desktop server with a plain
 * node `ws` client and no credential at all, `Origin: chrome-extension://aaaa...` was
 * ACCEPTED and reached the agent with `exec`, `terminal` and `file_write` enabled.
 *
 * The desktop's answer was a PAIRING CODE: a 64-hex secret printed in Settings that a
 * person copied into this extension. It works, and it is the wrong shape for the job -
 * it puts a live credential in `chrome.storage.local` and in this extension's console,
 * it asks every user to perform a ceremony, and a code that is never entered leaves the
 * hole open for as long as the compatibility window lasts.
 *
 * NATIVE MESSAGING REMOVES THE SECRET INSTEAD OF MOVING IT. Chrome - not us - decides
 * who may speak to the host: the host's manifest names the permitted extension ids in
 * `allowed_origins`, "values can't contain wildcards", and Chrome refuses any other
 * caller with "Access to the specified native messaging host is forbidden." The host is
 * also a REAL LOCAL PROCESS rather than a sandboxed page, so it can read the desktop's
 * own 0600 credential off disk - the one thing this extension can never do, and the
 * entire reason the pairing code had to travel through a human in the first place.
 * Reference: developer.chrome.com/docs/extensions/develop/concepts/native-messaging
 * (written without a scheme on purpose - `scripts/audit.mjs` fails any source file
 * carrying a non-local URL literal, and that gate is worth more than a clickable link.)
 *
 * This is also what Anthropic's own Claude extension does, measured from the installed
 * bundle rather than assumed: it declares `nativeMessaging`, probes
 * `com.anthropic.claude_browser_extension` and `com.anthropic.claude_code_browser_extension`
 * with a ping/pong, and keeps no pairing code of any kind.
 *
 * THREE PROPERTIES OF THIS TRANSPORT THAT DIFFER FROM THE WebSocket, all from the page
 * cited above, and each of which breaks something if forgotten:
 *
 *  1. FRAMES ARE OBJECTS, NOT STRINGS. Chrome serializes and parses the JSON itself, so
 *     `port.postMessage(obj)` takes an object and `onMessage` delivers one. A
 *     `JSON.stringify` on the way out arrives as a quoted STRING and every `message.type`
 *     read on the far side is then undefined.
 *  2. THE SIZE LIMITS ARE ASYMMETRIC: 64 MiB from here to the host, but "the maximum size
 *     of a single message from the native messaging host is 1 MB" in the other direction.
 *     An oversized frame from the host kills the port, so the HOST is where that cap is
 *     enforced - it answers with a small error frame instead of a truncated payload.
 *  3. THE HOST'S LIFETIME IS THE PORT'S. "Chrome starts native messaging host process and
 *     keeps it running until the port is destroyed", so one process serves the whole
 *     session and there is nothing to pool or reuse.
 *
 * WHY THE WebSocket STAYS. A desktop older than the release that installs the host
 * manifest has nothing for `connectNative` to reach, and turning browser control off for
 * every existing install on the day this ships is the one irreversible direction. So the
 * native path is tried first, its absence is a normal answer, and the socket is the
 * fallback. Delete the fallback only once the desktop floor has moved past that release.
 */
const NATIVE_HOST_NAME = 'ai.foxl.browser_bridge';

/**
 * How long to wait for the host's `pong` before calling the native path unusable.
 *
 * A PONG IS THE ONLY PROOF, and this is not belt-and-braces. The manifest is a FILE
 * holding an absolute path, so it outlives the app it points at - a moved, updated or
 * deleted Foxl leaves Chrome happily spawning a path that is gone. `connectNative`
 * SUCCEEDS in that case (it returns a port; failures arrive later on `onDisconnect`),
 * so a transport built on "did connectNative throw" would report a working channel into
 * a dead process and never fall back.
 */
const NATIVE_PROBE_TIMEOUT_MS = 3000;

/*
 * The one live channel to the desktop, whichever kind it is:
 *   { kind: 'native' | 'websocket', send(obj) -> bool, isOpen() -> bool, close() }
 *
 * Every caller goes through `transportSend` / `transportIsOpen` so that adding this
 * second transport did not fork the ~8 places that used to touch `serverSocket`
 * directly. `serverSocket` is still the socket itself, because the WebSocket branch
 * below needs its `readyState`.
 */
let transport = null;

/** Why the native host is unavailable, for the panel and for the log. */
let nativeUnavailableReason = null;

/**
 * The desktop refused the local socket with 4004 (it requires the bridge) and the bridge could not be reached
 * either: the options page and the side panel say where to fix it. Cleared by any channel that opens.
 */
let desktopRequiresBridge = false;

/**
 * Is this error message Chrome saying "there is no host here"?
 *
 * Both spellings are Chrome's own, matched whole: a missing manifest ("Specified native
 * messaging host not found.") and a manifest that does not list this extension ("Access to
 * the specified native messaging host is forbidden."). Neither is worth retrying - the first
 * needs the desktop app to install itself, the second needs a new manifest. Any OTHER
 * disconnect reason (the host exited, it could not reach the desktop, it was mid-update) is a
 * host that EXISTS, and never sends the extension to the local socket.
 */
function nativeHostAbsent(message) {
  return /^(?:Specified native messaging host not found|Access to the specified native messaging host is forbidden)\.?$/.test(
    String(message || '').trim(),
  );
}

/*
 * THE LOCAL SOCKET IS ONLY FOR A DESKTOP THAT NEVER INSTALLED THE BRIDGE (foxl-ai/pilot #7795).
 * The socket cannot tell Foxl Desktop from any other program holding its port, so it is the
 * fallback for one case only: Chrome says there is no host for this extension, and the bridge
 * has never answered in this browser profile. A host that exists but did not answer `pong` (the
 * desktop is not running, or could not be reached) is retried as the bridge, never as the
 * socket; and once the bridge has answered here, a later "no host" (a moved or reinstalled app)
 * is a broken bridge to repair from Foxl Desktop, not a reason to trust the port. The record is
 * this profile's (`chrome.storage.local`), so it outlives a browser restart.
 */
const BRIDGE_ANSWERED_KEY = 'bridgeAnsweredAt';
let bridgeAnswered = null; // null until read from storage

/** Has the bridge ever opened a channel in this browser profile? */
async function bridgeAnsweredHere() {
  if (bridgeAnswered === null) {
    const stored = await chrome.storage.local.get(BRIDGE_ANSWERED_KEY).catch(() => ({}));
    bridgeAnswered = Number(stored?.[BRIDGE_ANSWERED_KEY]) > 0;
  }
  return bridgeAnswered;
}

function noteBridgeAnswered() {
  bridgeAnswered = true;
  chrome.storage.local.set({ [BRIDGE_ANSWERED_KEY]: Date.now() }).catch(() => {});
}

/**
 * Why the last attempt did not open the local socket even though no channel opened (the host
 * exists, or the bridge answered here before), for the status surfaces. False once a channel
 * opens or the socket is tried.
 */
let socketDeclined = false;
/** The native host's last answer was Chrome's "no host here" (above). */
let nativeHostMissing = false;

/** True while a live channel of any kind is open. */
function transportIsOpen() {
  return !!transport?.isOpen();
}

/** Send one frame. Returns false when nothing is connected. */
function transportSend(message) {
  if (!transport?.isOpen()) return false;
  try {
    return transport.send(message);
  } catch (err) {
    console.error('[Foxl] Send failed:', err);
    return false;
  }
}

/** The kind of channel in use, for the status surfaces. `null` when down. */
function transportKind() {
  return transport?.isOpen() ? transport.kind : null;
}

/**
 * Everything both transports do the moment they are up: remember the desktop, announce
 * ourselves, start the keep-alive. Shared so the two paths cannot drift - the
 * `extension_connected` frame is what tells the desktop our version, and a path that
 * forgot it would look connected and be invisible to the version handshake.
 */
function onTransportOpen(kind) {
  console.log(`[Foxl] Connected to desktop over ${kind}`);
  isConnecting = false;
  desktopRequiresBridge = false;
  socketDeclined = false;
  if (kind === 'native') noteBridgeAnswered();
  /*
   * REMEMBER THAT A DESKTOP HAS EVER BEEN REACHABLE.
   *
   * This one boolean is what lets the side panel tell "you do not have Foxl
   * Desktop" apart from "your desktop is asleep" - and until it existed, every
   * person who installed this from a store saw the SECOND message (a grey dot
   * titled "Disconnected") for a product they had never installed. That is the
   * screen a store reviewer sees too.
   *
   * `chrome.storage.local`, not `session`: the question is "has this ever
   * worked", and session storage is cleared on every browser restart, which
   * would send a long-time user back to the install screen every morning.
   *
   * The TIMESTAMP is what makes the memory expire. A bare boolean can only be
   * set, so a person who uninstalls Foxl Desktop is told "reconnecting
   * automatically" forever, with no route back to the install screen - the flag
   * that fixed one wrong message introduced another. `hasRecentDesktop()` reads
   * the date; the boolean is still written so an older panel build and the
   * release gate both keep working.
   */
  chrome.storage.local.set({ everConnected: true, lastConnectedAt: Date.now() }).catch(() => {});
  // `capabilities` (0.11.0) and `transport` are both additive: a desktop reads only what it knows.
  transportSend({
    type: 'extension_connected',
    data: { version: chrome.runtime.getManifest().version, capabilities: CAPABILITIES, transport: kind },
  });
  // A Stop pressed while no channel was open reaches the desktop now (STOP HOLDS).
  if (stopLatch?.unsent && transportSend({ type: 'stop_agent' })) stopLatch.unsent = false;
  startKeepAlive();
}

/** Everything both transports do when they go down. */
function onTransportClosed(kind, detail) {
  console.log(`[Foxl] Disconnected from desktop (${kind})${detail ? `: ${detail}` : ''}`);
  // A side panel waiting on this channel is told at once (0.10.0), whichever kind of channel it was.
  if (pendingPanelChat) {
    chrome.runtime.sendMessage({
      type: 'SERVER_RESPONSE',
      data: { error: 'The connection was lost. Your task may still be running; check Foxl Desktop before trying again.' },
      ...pendingPanelChat,
    }).catch(() => {});
    pendingPanelChat = null;
  }
  clearPageSnapshots();
  transport = null;
  serverSocket = null;
  // Forget the peer's version with the connection. Keeping it would attribute the
  // old desktop's version to whatever answers next.
  desktopVersion = null;
  isConnecting = false;
  clearDiscoveredUrl();
  stopKeepAlive();
  scheduleReconnect();
}

/**
 * Try the native host. Resolves to a transport, or null when it is not available.
 *
 * Never throws and never rejects: an absent host is the NORMAL state on a machine whose
 * desktop predates the bridge, and treating it as an error would put a red line in the
 * console on every reconnect for a setup that is working fine over the socket.
 */
function openNativeTransport() {
  nativeHostMissing = false;
  if (typeof chrome.runtime.connectNative !== 'function') {
    nativeUnavailableReason = 'this browser has no native messaging';
    nativeHostMissing = true;
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      // Thrown when the `nativeMessaging` permission is missing, which is a packaging
      // mistake rather than a missing desktop - so it is named differently. There is no host
      // this build can reach, the same answer as "not found".
      nativeUnavailableReason = `connectNative refused: ${err.message}`;
      nativeHostMissing = true;
      resolve(null);
      return;
    }

    let probed = false;
    const settleProbe = (value) => {
      if (probed) return;
      probed = true;
      resolve(value);
    };

    const nativeTransport = {
      kind: 'native',
      send: (message) => {
        port.postMessage(message);
        return true;
      },
      // A native port has no readyState. `transport` is nulled on disconnect, so
      // identity against the live transport IS the open test.
      isOpen: () => transport === nativeTransport,
      close: () => {
        try {
          port.disconnect();
        } catch (err) {
          // Already gone.
        }
      },
    };

    port.onMessage.addListener((message) => {
      if (!probed) {
        /*
         * ONLY a `pong` opens the channel. The host answers the probe before it has
         * reached the desktop server, so anything else here - including an `error`
         * frame naming an unreachable server - means the far side is not ready, and
         * adopting the port on any first message would report a live channel into a
         * host that cannot serve one.
         */
        if (message?.type !== 'pong') return;
        clearTimeout(probeTimer);
        transport = nativeTransport;
        nativeUnavailableReason = null;
        settleProbe(nativeTransport);
        onTransportOpen('native');
        return;
      }
      // Frames arrive already parsed - see property 1 in the block above.
      handleServerMessage(message).catch((err) => {
        console.error('[Foxl] Message handler error:', err);
      });
    });

    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message || '';
      clearTimeout(probeTimer);
      if (!probed) {
        nativeUnavailableReason = detail || 'the native host closed the port';
        nativeHostMissing = nativeHostAbsent(detail);
        if (!nativeHostMissing) {
          console.warn('[Foxl] Native host disconnected during handshake:', detail);
        }
        settleProbe(null);
        return;
      }
      if (transport === nativeTransport) onTransportClosed('native', detail);
    });

    const probeTimer = setTimeout(() => {
      nativeUnavailableReason = 'the native host did not answer the handshake';
      try {
        port.disconnect();
      } catch (err) {
        // Already gone.
      }
      settleProbe(null);
    }, NATIVE_PROBE_TIMEOUT_MS);

    try {
      port.postMessage({ type: 'ping' });
    } catch (err) {
      clearTimeout(probeTimer);
      nativeUnavailableReason = `could not reach the native host: ${err.message}`;
      settleProbe(null);
    }
  });
}

/**
 * Connect to the desktop: the native host if it is there, the WebSocket if it is not.
 */
async function connectToServer() {
  if (transportIsOpen()) {
    return true;
  }

  // Prevent duplicate connection attempts
  if (isConnecting) {
    return false;
  }
  isConnecting = true;

  const native = await openNativeTransport();
  if (native) return true;

  // The local socket only when Chrome says there is no host and the bridge never answered here (above).
  if (!nativeHostMissing || await bridgeAnsweredHere()) {
    socketDeclined = true;
    isConnecting = false;
    console.log(`[Foxl] The browser bridge did not open (${nativeUnavailableReason}); not using the local socket, trying the bridge again later`);
    scheduleReconnect();
    return false;
  }
  socketDeclined = false;
  console.log(`[Foxl] No browser bridge for this extension (${nativeUnavailableReason}); trying the local socket`);

  return openWebSocketTransport();
}

/**
 * The pre-native transport, kept for desktops that do not install a host manifest.
 */
async function openWebSocketTransport() {
  // Close existing socket if in bad state
  if (serverSocket && serverSocket.readyState !== WebSocket.CLOSED) {
    try {
      serverSocket.close();
    } catch (e) {
      // Ignore
    }
  }

  const serverUrl = await getServerUrl();
  const wsUrl = serverUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/extension';

  return new Promise((resolve) => {
    try {
      console.log('[Foxl] Connecting to', wsUrl);
      serverSocket = new WebSocket(wsUrl);
      const socket = serverSocket;
      transport = {
        kind: 'websocket',
        send: (message) => {
          socket.send(JSON.stringify(message));
          return true;
        },
        isOpen: () => socket.readyState === WebSocket.OPEN,
        close: () => socket.close(),
      };

      serverSocket.onopen = () => {
        // Cache the working server URL for faster reconnects
        getServerUrl().then(url => { discoveredServerUrl = url; });
        onTransportOpen('websocket');
        resolve(true);
      };

      serverSocket.onclose = (event) => {
        /*
         * 4004 IS THE DESKTOP SAYING "PAIR FIRST", AND IT MUST NOT RENDER AS
         * "Reconnecting". A desktop that enforces pairing closes an unpaired socket with
         * `4004 extension_pairing_required`, and this handler used to log the code and
         * schedule a retry like any other close - so the one thing the user needed to
         * know arrived as a grey dot and an endless retry. There is nothing to type any
         * more: the fix is a desktop new enough to install the native host, which is
         * what the message says.
         */
        if (event.code === 4004) {
          desktopRequiresBridge = true;
          nativeUnavailableReason = `Foxl Desktop requires the verified browser connection and Chrome could not start it (${nativeUnavailableReason || 'no answer'})`;
          console.warn(`[Foxl] Desktop refused the socket: ${event.reason || 'pairing required'}.`
            + ' In Foxl Desktop, Settings > Web Access, choose Reinstall browser connection.');
        }
        onTransportClosed('websocket', `${event.code}${event.reason ? ` ${event.reason}` : ''}`);
        resolve(false);
      };

      serverSocket.onerror = (error) => {
        console.error('[Foxl] WebSocket error:', error);
        isConnecting = false;
        resolve(false);
      };
      
      serverSocket.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          await handleServerMessage(message);
        } catch (err) {
          console.error('[Foxl] Message parse error:', err);
        }
      };
    } catch (err) {
      console.error('[Foxl] Connection error:', err);
      isConnecting = false;
      resolve(false);
    }
  });
}

// Keep-alive mechanism to prevent service worker from sleeping
let keepAliveInterval = null;

function startKeepAlive() {
  stopKeepAlive();
  // Send ping every 20 seconds to keep connection alive
  keepAliveInterval = setInterval(() => {
    if (transportIsOpen()) {
      transportSend({ type: 'ping' });
    } else {
      // Channel died silently - trigger reconnect
      console.log('[Foxl] Keep-alive detected a dead channel, reconnecting...');
      stopKeepAlive();
      scheduleReconnect();
    }
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

/**
 * Schedule reconnection attempt with exponential backoff.
 * Uses chrome.alarms to survive service worker restarts.
 */
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000; // 30 seconds max

function scheduleReconnect() {
  if (reconnectTimer) return;
  
  const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  
  console.log(`[Foxl] Scheduling reconnect in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
  
  // Use chrome.alarms as backup - survives service worker sleep
  chrome.alarms.create('pilot-reconnect', { delayInMinutes: delay / 60000 });
  
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const connected = await connectToServer();
    if (connected) {
      reconnectAttempts = 0; // Reset on success
      console.log('[Foxl] Reconnected successfully');
    }
    // If not connected, onclose handler will call scheduleReconnect again
  }, delay);
}

// Handle alarm-based reconnection (backup for when setTimeout doesn't fire)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pilot-reconnect' || alarm.name === 'pilot-health-check') {
    if (!transportIsOpen()) {
      console.log(`[Foxl] ${alarm.name}: socket not connected, reconnecting...`);
      reconnectAttempts = 0; // Reset for health check triggered reconnects
      const connected = await connectToServer();
      if (!connected) {
        scheduleReconnect();
      }
    }
  }
});

/**
 * Handle messages from server
 */
async function handleServerMessage(message) {
  const { type, requestId, data } = message;
  
  switch (type) {
    case 'connected':
      // The desktop's own build version rides this frame.
      if (message.version) desktopVersion = String(message.version);
      console.log('[Foxl] Server confirmed connection, desktop', desktopVersion || 'unknown');
      break;

    case 'desktop_version':
      // The reply to our own `extension_connected` announcement. Handled as well as
      // `connected` because a reconnect can deliver them in either order, and a
      // missed frame would leave the version unknown for the life of the socket.
      if (data && data.version) desktopVersion = String(data.version);
      break;

    case 'pong':
      // A normal keep-alive reply, not an unexpected server message.
      break;
      
    case 'SERVER_RESPONSE':
      // The desktop has one uncorrelated response channel. Deliver only to
      // the panel that sent this request, not every open Chrome window.
      if (pendingPanelChat) {
        chrome.runtime.sendMessage({
          type: 'SERVER_RESPONSE',
          data: message.data,
          ...pendingPanelChat,
        }).catch(() => {});
        if (!['stream_start', 'stream_delta', 'tool'].includes(message.data?.type)) {
          const completedTab = pendingPanelChat.tabId;
          pendingPanelChat = null;
          // The legacy side-panel chat endpoint does not send hide_indicators.
          // A completed request must not leave its original page looking busy.
          if (completedTab) hideAgentIndicators(completedTab);
        }
      }
      break;
      
    case 'browser_command':
      // Execute browser command and send result back. Input actions run one at a time PER
      // TAB, each with a deadline (src/input-queue.js); everything else stays concurrent.
      let result;
      // A command of a run the person stopped is refused, input or not (STOP HOLDS, below).
      const stopGeneration = stopCount;
      const runOf = commandRun(data);
      if (heldByStop(runOf)) {
        result = stoppedRefusal(data?.action);
      } else if (INPUT_ACTIONS.has(data?.action)) {
        const tab = await resolveTargetTab(data.tabId);
        result = await inputQueue.run(tab ?? 'no-tab', (deadline) => (stopCount !== stopGeneration
          ? stoppedRefusal(data?.action)
          : executeBrowserCommand({ ...data, tabId: tab ?? data.tabId, deadline })));
      } else {
        result = await executeBrowserCommand(data);
      }
      if (runOf) lastRun = runOf;
      if (requestId) {
        sendToServer({
          type: 'browser_result',
          requestId,
          data: result
        });
      }
      break;
      
    case 'show_indicators':
      await showAgentIndicators(data?.tabId);
      break;
      
    case 'hide_indicators':
      // After a Stop this is the desktop's answer to it (it has sent one in reply to stop_agent since before 0.7).
      if (stopLatch) stopLatch.answeredAt = Date.now();
      await hideAgentIndicators(data?.tabId);
      break;

    default:
      console.log('[Foxl] Unknown message type:', type);
  }
}

/**
 * Get the effective target tab: explicit tabId > focusedTabId > first Pilot group tab
 */
async function resolveTargetTab(tabId) {
  if (tabId) return tabId;
  if (focusedTabId) {
    // Verify it still exists
    try {
      await chrome.tabs.get(focusedTabId);
      return focusedTabId;
    } catch {
      tabContexts.delete(focusedTabId);
      focusedTabId = null;
    }
  }
  // Fallback: first Pilot group tab
  const pilotTabs = await getPilotTabs();
  if (pilotTabs.tabs && pilotTabs.tabs.length > 0) {
    return pilotTabs.tabs[0].id;
  }
  return null;
}

/**
 * Track a tab in contexts and optionally focus it
 */
function trackTab(tabId, label, focus = true) {
  tabContexts.set(tabId, { label: label || null, createdAt: Date.now() });
  if (focus) focusedTabId = tabId;
  broadcastTabContexts();
}

/**
 * Broadcast tab contexts to sidepanel
 */
function broadcastTabContexts() {
  const contexts = [];
  for (const [id, ctx] of tabContexts) {
    contexts.push({ tabId: id, label: ctx.label, focused: id === focusedTabId });
  }
  chrome.runtime.sendMessage({
    type: 'TAB_CONTEXTS_UPDATED',
    data: { tabs: contexts, focusedTabId }
  }).catch(() => {});
}

/*
 * ═══════════════════════════════════════════════════════════════════════════════════
 *  FOXL ACTS ONLY IN ITS OWN TABS (foxl-ai/pilot #7802)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * A command names a tab by id, and it acts only in a tab that is Foxl's:
 *   - a tab Foxl opened (`new_tab`, a navigation that had no tab), tracked in `tabContexts`;
 *   - a tab in the Foxl tab group, which includes a tab the person moves into it;
 *   - the tab the person is on when they send a message from Foxl's side panel (`handedTabs`,
 *     kept in chrome.storage.session so a restarted worker still has it);
 *   - what one of those opens: a link's new tab joins the Foxl group by itself, and a pop-up window (a sign-in
 *     pop-up) counts by its opener (isFoxlTab).
 * Anything else is refused by name, with nothing done, and a command never pulls a tab into
 * Foxl's group or focus on its own say-so (`switch_tab`, `add_to_group`, `navigate`).
 * `get_tabs` lists only Foxl's tabs, and counts the others (`otherTabs`) without naming them.
 */
const HANDED_TABS_KEY = 'foxlHandedTabs';
const handedTabs = new Set();
let handedLoaded = null;
const FOXL_GROUP_TITLES = new Set(['Foxl', 'Pilot']);
const OPENER_DEPTH = 5;

function loadHandedTabs() {
  handedLoaded ??= chrome.storage.session.get(HANDED_TABS_KEY).then((stored) => {
    for (const id of stored?.[HANDED_TABS_KEY] ?? []) if (Number.isSafeInteger(id)) handedTabs.add(id);
  }).catch(() => {});
  return handedLoaded;
}

function saveHandedTabs() {
  chrome.storage.session.set({ [HANDED_TABS_KEY]: [...handedTabs] }).catch(() => {});
}

/** A message from one of this extension's own pages (the side panel, the options page), never a content script. */
function fromExtensionPage(sender) {
  return sender?.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

/** The person handed this tab to Foxl (Foxl's side panel, on that tab). */
async function handTab(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) return;
  try { await chrome.tabs.get(tabId); } catch { return; }
  await loadHandedTabs();
  handedTabs.add(tabId);
  saveHandedTabs();
}

async function isFoxlGroup(groupId) {
  if (!Number.isSafeInteger(groupId) || groupId < 0) return false;
  if (groupId === pilotTabGroupId) return true;
  try { return FOXL_GROUP_TITLES.has((await chrome.tabGroups.get(groupId)).title); } catch { return false; }
}

/**
 * Is this one of Foxl's tabs (above)? A tab that no longer exists is not.
 *
 * BY ITS OPENER ONLY IN A POP-UP WINDOW. A link a Foxl tab opens in a new tab joins the Foxl group by itself
 * (Chromium 156, measured: target=_blank from a grouped tab lands in the group). A page's pop-up window
 * (window.open with features, a sign-in pop-up) cannot join a group, so it counts by its opener. In a normal
 * window the opener says nothing about who opened the tab: Chromium names the tab that was selected as the
 * opener of a new tab the person opens there (measured: a tab opened next to a Foxl tab had it as its opener).
 */
async function isFoxlTab(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) return false;
  await loadHandedTabs();
  let id = tabId;
  for (let depth = 0; Number.isSafeInteger(id) && depth <= OPENER_DEPTH; depth++) {
    let tab;
    try { tab = await chrome.tabs.get(id); } catch { return false; }
    if (tabContexts.has(id) || handedTabs.has(id)) return true;
    if (await isFoxlGroup(tab.groupId)) return true;
    let windowType = null;
    try { windowType = (await chrome.windows.get(tab.windowId)).type; } catch { windowType = null; }
    if (windowType !== 'popup') return false;
    id = tab.openerTabId;
  }
  return false;
}

/**
 * isFoxlTab for a whole tab list at once (get_tabs), with the same rules: the groups and the pop-up windows are read
 * once, not per tab, so listing a hundred tabs costs three calls, not three hundred.
 */
async function foxlTabsAmong(tabs) {
  await loadHandedTabs();
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  const foxlGroups = new Set(groups.filter((g) => g.id === pilotTabGroupId || FOXL_GROUP_TITLES.has(g.title)).map((g) => g.id));
  const popups = new Set((await chrome.windows.getAll({ windowTypes: ['popup'] }).catch(() => [])).map((w) => w.id));
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const own = (t) => tabContexts.has(t.id) || handedTabs.has(t.id) || foxlGroups.has(t.groupId);
  return tabs.map((tab) => {
    let t = tab;
    for (let depth = 0; t && depth <= OPENER_DEPTH; depth++) {
      if (own(t)) return true;
      if (!popups.has(t.windowId)) return false;
      t = byId.get(t.openerTabId);
    }
    return false;
  });
}

/** The answer for a command that names a tab Foxl may not act in: nothing was done, and why. */
function notFoxlTab(tabId) {
  return {
    success: false,
    nothingWasDone: true,
    notFoxlTab: true,
    tabId,
    error: `Tab ${tabId} is not one of Foxl's tabs, so nothing was done. Foxl acts only in tabs it opened (new_tab, and the tabs those open), tabs in the Foxl tab group, and the tab the person sends a message from in Foxl's side panel. Open the page with new_tab, or ask the person to move that tab into the Foxl group.`,
  };
}

/** The actions that name no tab of their own (a list, the group, a new tab, the downloads). */
const TABLESS_ACTIONS = new Set(['get_tabs', 'get_pilot_tabs', 'list_contexts', 'collapse_group', 'expand_group', 'new_tab', 'get_downloads']);

/*
 * ONE INPUT AT A TIME, PER TAB, WITH A DEADLINE (src/input-queue.js has the measurements).
 * Clicks, typing, keys and hovers on one tab share its focus, and Foxl Desktop runs a
 * model's tool calls concurrently, so on one tab they are queued. A tab whose page is stuck
 * (a confirm() dialog, a hung script) holds only its own queue, and only until the
 * action's deadline; an action that could not start in time is refused, not run late.
 */
const INPUT_ACTIONS = new Set(['click', 'type', 'select', 'click_at', 'press_key', 'hover', 'fill_sign_in']);
const inputQueue = createInputQueue();

/*
 * STOP HOLDS (foxl-ai/pilot #7927). After the person's "Stop Foxl", the stopped run's commands
 * that still reach the extension are refused, input or not, with `stopped: true`.
 *
 * Which run a command belongs to: a desktop that sends `data.run` names it, so a command of the
 * stopped run is refused for as long as it keeps coming, and a command with another run id is a
 * new run and ends the hold. A desktop that sends no run id (every one so far) is held until it
 * has answered the Stop (the `hide_indicators` it sends in reply to `stop_agent`) and then
 * sent nothing for STOP_QUIET_MS: commands it had already sent before it stopped the run are
 * refused, and after that the rest of the run is the desktop's own stop. A desktop that sends each
 * command's run id is the desktop half of foxl-ai/pilot #7927.
 * A Stop pressed while no channel was open is sent again when one opens.
 */
const STOP_QUIET_MS = 1500;
let stopLatch = null; // { run, answeredAt, lastRefusedAt, unsent }
let stopCount = 0;
let lastRun = null;

/** The run a command names (`data.run`, a desktop that sends one), or null. */
function commandRun(data) {
  return typeof data?.run === 'string' && data.run ? data.run.slice(0, 128) : null;
}

function holdStoppedRun() {
  stopCount += 1;
  stopLatch = { run: lastRun, answeredAt: null, lastRefusedAt: Date.now(), unsent: false };
}

/** Is a command of this run (null: none named) held by the person's Stop? Ends the hold once a new run has begun. */
function heldByStop(run) {
  if (!stopLatch) return false;
  if (run) {
    if (stopLatch.run && run === stopLatch.run) return true;
    stopLatch = null;
    return false;
  }
  const now = Date.now();
  if (stopLatch.answeredAt && now - Math.max(stopLatch.answeredAt, stopLatch.lastRefusedAt) >= STOP_QUIET_MS) {
    stopLatch = null;
    return false;
  }
  stopLatch.lastRefusedAt = now;
  return true;
}

function stoppedRefusal(action) {
  return {
    success: false,
    nothingWasDone: true,
    stopped: true,
    error: `The person pressed Stop Foxl in this browser, so ${action ? `this ${action}` : 'this command'} was not done. Nothing more of the stopped task runs here; wait for the person's next request.`,
  };
}

/**
 * Execute browser command from server
 */
async function executeBrowserCommand(command) {
  const { action, tabId, params, deadline } = command;
  let targetTabId = await resolveTargetTab(tabId);
  // Only in Foxl's own tabs (FOXL ACTS ONLY IN ITS OWN TABS, above), before anything reaches the tab.
  if (!TABLESS_ACTIONS.has(action) && targetTabId != null && !(await isFoxlTab(targetTabId))) return notFoxlTab(targetTabId);
  // No tab named and none of Foxl's to fall back on: 0.8.1 captured the selected tab of the current window
  // (captureVisibleTab(null)), and Foxl Desktop sends no tabId when the model omits it. That tab is captured
  // only when it is Foxl's own.
  if (action === 'screenshot' && targetTabId == null) {
    const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    if (active == null) return { success: false, error: 'No tab to capture.' };
    if (!(await isFoxlTab(active))) return notFoxlTab(active);
    targetTabId = active;
  }
  // A web page only (WHERE A TAB MAY GO), refused before the step is noted or any tab changes.
  if (action === 'navigate' || action === 'new_tab') {
    const to = navigableUrl(params?.url, { required: action === 'navigate' });
    if (!to.ok) return to.refusal;
  }
  // A navigation to a file downloads from the site it names, so it is remembered with that one.
  if (targetTabId && (INPUT_ACTIONS.has(action) || action === 'navigate')) await noteActed(targetTabId, action === 'navigate' ? params?.url : null);

  // The tab shows that Foxl is acting while this runs (WHILE FOXL ACTS IN A TAB, THAT TAB SAYS SO).
  const overlayTab = OVERLAY_ACTIONS.has(action) && targetTabId != null ? targetTabId : null;
  if (overlayTab != null) beginActing(overlayTab);
  try {
    return await dispatchBrowserCommand({ action, targetTabId, params, deadline });
  } finally {
    if (overlayTab != null) endActing(overlayTab);
  }
}

/** The command itself, once executeBrowserCommand has checked where it may act. */
async function dispatchBrowserCommand({ action, targetTabId, params, deadline }) {
  try {
    // 0.12.0 (foxl-ai/pilot #6394): a click or a key press that sends a form is watched until its answer starts.
    const watched = targetTabId && stepWatched(action, params) ? await armStep(targetTabId, params?.hold, params?.chat) : null;
    if (watched) {
      let result = null;
      try {
        result = await runWatchedStep(action, targetTabId, params, deadline);
      } finally {
        // A step whose action failed or threw is read too, which ends it in the page: left armed, the page would look at
        // every submit for the rest of its hold window, and those are the person's own (described, and stopped when held).
        // Its answer stays the failure it was.
        if (!result || result.success === false) await endStep(targetTabId, watched).catch(() => null);
      }
      const step = result && result.success !== false ? await finishStep(targetTabId, watched) : null;
      const out = step && step.settled !== 'nothing' ? { ...result, step } : { ...result };
      // A form a stopped step of this chat sent here: held this time, and reported for the desktop to record.
      if (watched.leftover) out.leftover = watched.leftover;
      // Nothing happened: the answer is what it always was.
      return step && step.settled !== 'nothing' || watched.leftover ? out : result;
    }
    switch (action) {
      case 'get_accessibility_tree':
        if (params?.snapshot) return withDownloads(await getPageSnapshot(targetTabId, params, await filledFor(targetTabId)), targetTabId);
        return withDownloads(await getAccessibilityTree(targetTabId, params), targetTabId);

      // Added in 0.11.0 (#6245): one element's whole text, a slice at a time.
      case 'read_text':
        return await readElementText(targetTabId, params);

      // Added in 0.11.0 (#6245): the downloads Foxl's task tabs started, with their state.
      case 'get_downloads':
        return await getDownloads(params);
        
      case 'click':
        return await clickElement(targetTabId, params.refId, deadline);

      case 'type':
        return await typeInElement(targetTabId, params.refId, params.text, params.submit, deadline);

      // Added in 0.12.1: a sign-in saved in Foxl Desktop, typed into the tab's top document on its own site only.
      case 'fill_sign_in':
        return await fillSignIn(targetTabId, params, deadline);

      // Added in 0.8.0: what a person does without an element ref (page events).
      case 'click_at':
        return await clickAt(targetTabId, params?.x, params?.y, deadline);

      case 'press_key':
        return await pressKey(targetTabId, params?.key, params?.refId, deadline);

      case 'hover':
        return await hoverElement(targetTabId, params?.refId, params?.x, params?.y, deadline);
        
      case 'select':
        return await selectOption(targetTabId, params.refId, params.value, deadline);
        
      case 'navigate': {
        // A web page only (WHERE A TAB MAY GO, below).
        const to = navigableUrl(params?.url, { required: true });
        if (!to.ok) return to.refusal;
        return await navigateTab(targetTabId, to.url);
      }

      case 'new_tab': {
        const to = navigableUrl(params?.url, { required: false });
        if (!to.ok) return to.refusal;
        return await createNewTab(to.url);
      }
        
      case 'close_tab':
        return await closeTab(targetTabId);
        
      case 'get_tabs':
        return await getTabs();
        
      case 'get_pilot_tabs':
        return await getPilotTabs();
        
      case 'collapse_group':
        return await setPilotGroupCollapsed(true);
        
      case 'expand_group':
        return await setPilotGroupCollapsed(false);
        
      case 'add_to_group':
        if (!targetTabId) return { success: false, error: 'Tab ID required' };
        const groupId = await addTabToPilotGroup(targetTabId);
        return { success: !!groupId, groupId };

      case 'switch_tab':
        if (!params?.tabId) return { success: false, error: 'params.tabId required for switch_tab' };
        try {
          await chrome.tabs.get(params.tabId);
          // Focus moves only among Foxl's own tabs: a command never adopts another tab.
          if (!(await isFoxlTab(params.tabId))) return notFoxlTab(params.tabId);
          focusedTabId = params.tabId;
          if (!tabContexts.has(params.tabId)) {
            trackTab(params.tabId, params.label || null, true);
          } else {
            broadcastTabContexts();
          }
          return { success: true, focusedTabId: params.tabId };
        } catch {
          return { success: false, error: `Tab ${params.tabId} does not exist` };
        }

      case 'list_contexts':
        // Clean up stale entries
        for (const [id] of tabContexts) {
          try { await chrome.tabs.get(id); } catch { tabContexts.delete(id); }
        }
        if (focusedTabId && !tabContexts.has(focusedTabId)) focusedTabId = null;
        const ctxList = [];
        for (const [id, ctx] of tabContexts) {
          try {
            const tab = await chrome.tabs.get(id);
            ctxList.push({ tabId: id, label: ctx.label, url: tab.url, title: tab.title, focused: id === focusedTabId });
          } catch { /* skip */ }
        }
        return { success: true, contexts: ctxList, focusedTabId };

      case 'screenshot':
        // With no tab named, the selected tab when it is Foxl's (executeBrowserCommand).
        return await captureTabScreenshot(targetTabId, params);
        
      case 'scroll':
        return await scrollPage(targetTabId, params.direction, params.amount);
        
      case 'get_page_info':
        return await getPageInfo(targetTabId);
        
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/*
 * ONE ELEMENT'S WHOLE TEXT (#6245). A tree line shows 100 characters of an element's text and marks
 * the rest (`clipped=100/5000`); this reads it by ref, from `offset`, at most 20,000 characters a
 * call (the content script's `__pilotReadText`). Read-only, the top frame of the target tab. A tab
 * opened before the extension updated still runs the old content script until it reloads, and
 * says so.
 */
async function readElementText(tabId, params = {}) {
  if (!tabId) return { success: false, error: 'No active tab' };
  if (typeof params?.refId !== 'string' || !params.refId) return { success: false, error: 'params.refId required for read_text' };
  const page = await readAllowedPage(tabId, ({ refId, offset, maxChars, filled }) => {
    if (typeof window.__pilotReadText !== 'function') {
      return { url: location.href, success: false, error: 'This page was opened before Foxl\'s extension updated. Reload the page to read an element\'s whole text.' };
    }
    return { ...window.__pilotReadText(refId, offset, maxChars, filled), url: location.href };
  }, [{ refId: params.refId, offset: params.offset ?? 0, maxChars: params.maxChars ?? 4000, filled: await filledFor(tabId) }]);
  const { documentId: _documentId, ...result } = page;
  return { ...result, tabId };
}

/*
 * DOWNLOADS, AS A RECEIPT (#6245). A site's "your file is ready" screen is not a file: in the case
 * behind #6245 Chrome's "download multiple files" prompt held the second and third files of one
 * export, and the page said all three were done. So the downloads a Foxl task tab started come back
 * with what Chrome's own download list says about them (file name, never the folder; state, bytes,
 * error), from `get_downloads` and with the next read of that tab (`downloads`).
 *
 * `downloads` is an OPTIONAL permission: a required one makes Chrome turn the extension off for
 * every person at update until they accept it. Until the person allows it on the options page,
 * `get_downloads` answers `granted: false` (and the options page shows that Foxl asked), and
 * everything else works as without it. The list is read when asked (`chrome.downloads.search`), so
 * a grant takes effect at once and no listener has to be registered after it.
 *
 * A download is Foxl's when it started within two minutes after Foxl clicked, typed, pressed a key,
 * chose an option or navigated in a tab on the download's site (its referrer's, else its own). The
 * person's downloads anywhere else are never read. Chrome's download records name no tab, so one the
 * person starts on that same site in that window is counted as Foxl's: the residual of reading
 * downloads without a tab.
 */
const DOWNLOAD_KEEP = 20;
const DOWNLOAD_MATCH_MS = 2 * 60_000;
const DOWNLOAD_READ_WINDOW_MS = 10 * 60_000;
const ACTED_KEY = 'foxlActedTabs';
const DOWNLOADS_ASKED_KEY = 'downloadReceiptsAsked';
let actedLoaded = null;

function originOf(url) {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

/** Foxl's step in a tab, with that tab's site (or `url`'s), kept for the session so a restarted worker has it. */
async function noteActed(tabId, url = null) {
  let origin = url ? originOf(url) : null;
  if (!origin) {
    try { origin = originOf((await chrome.tabs.get(tabId)).url); } catch { /* the tab is gone */ }
  }
  if (!origin) return;
  await loadActed();
  actedTabs.set(tabId, { at: Date.now(), origin });
  for (const [id, step] of actedTabs) if (Date.now() - step.at > DOWNLOAD_READ_WINDOW_MS) actedTabs.delete(id);
  chrome.storage.session.set({ [ACTED_KEY]: [...actedTabs] }).catch(() => {});
}

function loadActed() {
  actedLoaded ??= chrome.storage.session.get(ACTED_KEY).then((stored) => {
    for (const [id, step] of stored?.[ACTED_KEY] ?? []) if (!actedTabs.has(id)) actedTabs.set(id, step);
  }).catch(() => {});
  return actedLoaded;
}

/** Where a download came from, without its query or fragment (a link can carry a token there). */
function downloadSource(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.origin}${u.pathname}`;
    if (u.protocol === 'blob:') return `blob:${u.origin}`;
    return `${u.protocol} URL`;
  } catch {
    return null;
  }
}

/** The file's name: the last part of the path Chrome saves it to, never the folder. */
function baseName(path) {
  const name = String(path || '').split(/[\\/]/).pop();
  return name || null;
}

const DANGER_SAFE = new Set(['safe', 'accepted']);

/** The Foxl tab a download belongs to: the last step on its site before it started, within the window. */
function taskTabOf(item) {
  const from = originOf(item.referrer) || originOf(item.finalUrl || item.url);
  const started = Date.parse(item.startTime) || 0;
  if (!from || !started) return null;
  let best = null;
  for (const [tabId, step] of actedTabs) {
    if (step.origin !== from) continue;
    const after = started - step.at;
    // A second of clock skew: Chrome stamps the download, this worker stamps the step.
    if (after < -1000 || after > DOWNLOAD_MATCH_MS) continue;
    if (!best || step.at > best.at) best = { tabId, at: step.at };
  }
  return best?.tabId ?? null;
}

function downloadRecord(item, tabId) {
  return {
    id: item.id,
    tabId,
    file: baseName(item.filename),
    source: downloadSource(item.finalUrl || item.url),
    mime: item.mime || null,
    state: item.state || 'in_progress',
    bytesReceived: Number(item.bytesReceived) || 0,
    totalBytes: Number(item.totalBytes) > 0 ? Number(item.totalBytes) : null,
    error: item.error || null,
    danger: item.danger && !DANGER_SAFE.has(item.danger) ? item.danger : null,
    startedAt: Date.parse(item.startTime) || null,
    endedAt: item.endTime ? (Date.parse(item.endTime) || null) : null,
  };
}

/** Chrome's list of the last ten minutes, Foxl's downloads only, oldest first; null without the permission. */
async function taskDownloads() {
  if (!chrome.downloads?.search) return null;
  await loadActed();
  const items = await chrome.downloads.search({
    startedAfter: new Date(Date.now() - DOWNLOAD_READ_WINDOW_MS).toISOString(),
    orderBy: ['-startTime'],
    limit: 100,
  });
  const mine = [];
  for (const item of items) {
    const tabId = taskTabOf(item);
    if (tabId) mine.push(downloadRecord(item, tabId));
  }
  return mine.slice(0, DOWNLOAD_KEEP).reverse();
}

async function getDownloads(params = {}) {
  const list = await taskDownloads();
  if (list === null) {
    // The options page shows that Foxl asked, beside the switch that allows it.
    chrome.storage.local.set({ [DOWNLOADS_ASKED_KEY]: Date.now() }).catch(() => {});
    return {
      success: false,
      granted: false,
      error: 'Download receipts are not allowed in this browser yet. The person can turn them on in the Foxl extension\'s options (Download receipts, Allow).',
    };
  }
  const tabId = Number.isSafeInteger(params?.tabId) ? params.tabId : null;
  const since = Number(params?.since) || 0;
  return { success: true, granted: true, downloads: list.filter((d) => (tabId === null || d.tabId === tabId) && (d.startedAt ?? 0) >= since) };
}

/** A read of a tab, with the downloads that tab started in the last ten minutes when there are any. */
async function withDownloads(result, tabId) {
  if (!result || result.success === false || !tabId) return result;
  let list = null;
  try { list = await taskDownloads(); } catch { list = null; }
  const mine = (list ?? []).filter((d) => d.tabId === tabId);
  return mine.length ? { ...result, downloads: mine } : result;
}

/**
 * Get accessibility tree from tab
 */
async function getAccessibilityTree(tabId, params = {}) {
  if (!tabId) {
    tabId = await resolveTargetTab(null);
  }
  
  if (!tabId) {
    return { success: false, error: 'No active tab' };
  }
  
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_ACCESSIBILITY_TREE',
      filter: params.filter || 'all',
      depth: params.depth || 15,
      maxChars: params.maxChars,
      refId: params.refId,
      filled: await filledFor(tabId),
    }, { frameId: 0 });
    if (!result?.success || result.data?.error) {
      return { success: false, error: result?.error || result?.data?.error || 'The page reader returned no result.' };
    }
    return { success: true, data: result.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/*
 * CLICK, TYPE, KEYS AND HOVER, and what each one really did.
 *
 * The old path was `element.click()`, `element.value = text` plus two plain Events, and
 * `form.submit()`, and it answered `{ success: true }` whatever the page did with them: a
 * contenteditable editor ignored `.value` entirely, Enter skipped the page's own submit
 * handling (and reloaded a React form), and the agent was told it had worked. Typing is now
 * READ BACK and reported as a failure when the text is not in the field, and every answer
 * names how it acted (`method`).
 *
 * Input remains in the content script. The debugger permission used for background
 * screenshots does not change these events into trusted input.
 */

/**
 * Does the field hold what was typed? Whitespace-insensitive (editors reflow it, and `\s`
 * also matches their no-break spaces), and also on LETTERS AND DIGITS ONLY, case-insensitive,
 * so a masked input that formats as you type (5551234567 -> "(555) 123-4567") is not
 * reported as a failure.
 */
function valueHolds(value, text) {
  const squash = (s) => String(s ?? '').replace(/\s+/g, '');
  if (squash(value).includes(squash(text))) return true;
  const alnum = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const want = alnum(text);
  return want.length > 0 && alnum(value).includes(want);
}

/**
 * Click element by ref ID
 */
async function clickElement(tabId, refId, deadline) {
  if (!tabId || !refId) {
    return { success: false, error: 'Tab ID and ref ID required' };
  }

  try {
    // Show visual indicator
    await chrome.tabs.sendMessage(tabId, {
      type: 'HIGHLIGHT_ELEMENT',
      refId,
      duration: 500,
      deadline,
    });

    const result = await chrome.tabs.sendMessage(tabId, { type: 'CLICK_FALLBACK', refId, deadline });
    return { ...(result || { success: false, error: 'No answer from the page' }), ref: refId };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Type into element: focus it and select its contents, insert the text through the
 * editing engine, READ IT BACK, then press Enter if asked and report whether the form
 * really submitted.
 */
async function typeInElement(tabId, refId, text, submit = false, deadline) {
  if (!tabId || !refId) {
    return { success: false, error: 'Tab ID and ref ID required' };
  }

  try {
    const typed = await chrome.tabs.sendMessage(tabId, { type: 'INSERT_TEXT_FALLBACK', refId, text: String(text), deadline });
    if (!typed?.success) return typed || { success: false, error: `No answer from the page for ${refId}` };
    const method = typed.method;

    const read = await chrome.tabs.sendMessage(tabId, { type: 'READ_VALUE', refId, filled: await filledFor(tabId), text: String(text) });
    if (!read?.success) return read || { success: false, error: `Could not read ${refId} back` };
    // A field holding what a saved sign-in typed is read back without its value (WHAT A SAVED SIGN-IN TYPED).
    if (read.filled) {
      if (read.holds !== true) {
        return { success: false, method, error: `Typed into ${refId}, but the field now holds what a saved sign-in typed, not the text. The page rejected or rewrote it.` };
      }
    } else if (!read.password && !valueHolds(read.value, text)) {
      return {
        success: false,
        method,
        error: `Typed into ${refId}, but the field now holds ${JSON.stringify(String(read.value).slice(0, 200))}, not the text. The page rejected or rewrote it.`,
      };
    }
    if (read.password && read.length < String(text).length) {
      return { success: false, method, error: `Typed into ${refId}, but the password field holds only ${read.length} characters.` };
    }

    const out = { success: true, method, ref: refId, verified: true, submitted: false };
    if (submit) {
      // What happened, not what was asked: `submitted` is true only when a submit event
      // was observed, and `enterHandledByPage` when the page took Enter itself (a chat
      // composer that sends on Enter calls preventDefault and has no form).
      // Enter goes to the field just typed into, not to whatever has focus now.
      const key = await chrome.tabs.sendMessage(tabId, { type: 'KEY_FALLBACK', key: 'Enter', refId, deadline });
      if (key?.nothingWasDone) {
        return { success: false, method, ref: refId, nothingWasDone: true, error: `Typed into ${refId}, but Enter reached the page after its deadline and was not pressed: ${key.error}` };
      }
      out.submitted = !!key?.submitted;
      if (key?.enterHandledByPage) out.enterHandledByPage = true;
      if (key?.invalid) out.invalid = key.invalid;
    }
    return out;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Click at a point of the page, in viewport CSS pixels (what a screenshot shows at 1x). */
async function clickAt(tabId, x, y, deadline) {
  if (!tabId || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { success: false, error: 'click_at needs a tab and numeric x, y (viewport CSS pixels)' };
  }
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'CLICK_AT_FALLBACK', x, y, deadline });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Press a key ("Enter", "Escape", "Tab", "ArrowDown", "Control+a") on whatever has focus -
 * on refId if given, which is FOCUSED first (not clicked: a click can toggle, submit or
 * navigate, which is not what pressing a key on an element asks for).
 */
async function pressKey(tabId, key, refId, deadline) {
  if (!tabId || !key) return { success: false, error: 'press_key needs a key, e.g. "Enter" or "Control+a"' };
  try {
    if (refId) {
      const focus = await chrome.tabs.sendMessage(tabId, { type: 'FOCUS_ELEMENT', refId, deadline });
      if (!focus?.success) return focus || { success: false, error: `No answer from the page for ${refId}` };
    }
    const r = await chrome.tabs.sendMessage(tabId, { type: 'KEY_FALLBACK', key, refId, deadline });
    return { ...(r || { success: false, error: 'No answer from the page' }), key };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Move the pointer over an element (refId) or a point (x, y) - menus that open on hover. */
async function hoverElement(tabId, refId, x, y, deadline) {
  if (!tabId || (!refId && !(Number.isFinite(x) && Number.isFinite(y)))) {
    return { success: false, error: 'hover needs a refId or x, y' };
  }
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'HOVER_FALLBACK', refId, x, y, deadline });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/*
 * A SAVED SIGN-IN (0.12.1). Foxl Desktop sends the username, password or one-time code it holds and the
 * origin the sign-in was saved for. It goes to the tab's TOP frame only (frame 0), and the page checks that
 * it is the top document and still on that origin right before each value (`__pilotFillSignIn`). Nothing here
 * logs, stores or answers a value: the answer names the fields filled, and an error never quotes one.
 * Its message carries the input queue's deadline like every other input action's, so a fill that reaches a page
 * after it (a dialog, a hung script) is refused there, never typed after the desktop was told it failed.
 */
const SIGN_IN_KINDS = new Set(['username', 'password', 'code']);

/*
 * WHAT A SAVED SIGN-IN TYPED, WHEREVER THE PAGE PUTS IT (foxl-ai/pilot #7859). The page marks the element it typed
 * into, and a page that draws the field again as a new element loses that mark. So for FILLED_WINDOW_MS after a fill,
 * per tab and origin, this keeps a salted fingerprint of each value sent (src/content-scripts/filled-print.js), never
 * the value, in chrome.storage.session (memory only, gone with the browser), and every read of the tab carries them
 * (`filled`): the page reader shows `filled-by-foxl` for any text field whose value has one, in the tree, a
 * snapshot, read_text and a typing's read-back. The window covers a sign-in's next steps; a value the person types
 * later is theirs to show.
 */
const FILLED_WINDOW_MS = 10 * 60_000;
const FILLED_KEY = 'foxlFilledPrints';
const filledPrints = new Map(); // tabId -> { origin, salt, prints, until }
let filledLoaded = null;

function loadFilled() {
  filledLoaded ??= chrome.storage.session.get(FILLED_KEY).then((stored) => {
    for (const [id, entry] of stored?.[FILLED_KEY] ?? []) if (!filledPrints.has(id)) filledPrints.set(id, entry);
  }).catch(() => {});
  return filledLoaded;
}

function saveFilled() {
  chrome.storage.session.set({ [FILLED_KEY]: [...filledPrints] }).catch(() => {});
}

/** Before a fill's values reach the page: their fingerprints, for this tab and origin. */
async function noteFilled(tabId, origin, values) {
  await loadFilled();
  const now = Date.now();
  let entry = filledPrints.get(tabId);
  if (!entry || entry.origin !== origin || entry.until < now) {
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    entry = { origin, salt, prints: [], until: 0 };
  }
  for (const value of values) {
    for (const form of new Set([value, value.trim()])) {
      if (!form) continue;
      const print = globalThis.__foxlFilledPrint(entry.salt, form);
      if (!entry.prints.includes(print)) entry.prints.push(print);
    }
  }
  entry.prints = entry.prints.slice(-24);
  entry.until = now + FILLED_WINDOW_MS;
  filledPrints.set(tabId, entry);
  saveFilled();
}

/** The fingerprints a read of this tab carries, or null. */
async function filledFor(tabId) {
  await loadFilled();
  const entry = filledPrints.get(tabId);
  if (!entry) return null;
  if (entry.until < Date.now()) {
    filledPrints.delete(tabId);
    saveFilled();
    return null;
  }
  return { origin: entry.origin, salt: entry.salt, prints: entry.prints.slice() };
}

async function fillSignIn(tabId, params = {}, deadline) {
  if (!tabId) return { success: false, error: 'fill_sign_in needs a tab' };
  const expectedOrigin = typeof params.expectedOrigin === 'string' ? params.expectedOrigin : '';
  let origin = '';
  try { origin = new URL(expectedOrigin).origin; } catch { origin = ''; }
  const loopback = /^http:\/\/(?:localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);
  if (!origin || origin !== expectedOrigin || !(origin.startsWith('https://') || loopback)) {
    return { success: false, error: 'fill_sign_in needs the https origin the sign-in was saved for' };
  }
  const fields = Array.isArray(params.fields) ? params.fields : [];
  if (fields.length === 0 || fields.length > 3) return { success: false, error: 'fill_sign_in takes one to three fields' };
  for (const field of fields) {
    const ref = typeof field?.refId === 'string' ? field.refId : '';
    if (!/^ref_\d+$/.test(ref)) return { success: false, refused: 'frame', error: 'A saved sign-in is typed only into the page itself: a field ref of the top document (ref_N) is needed' };
    if (!SIGN_IN_KINDS.has(field?.kind) || typeof field?.value !== 'string' || field.value.length === 0 || field.value.length > 512) {
      return { success: false, error: `fill_sign_in: field ${ref} needs a kind (username, password or code) and a value` };
    }
  }
  // A first look at where the tab is; the page's own check right before each value is the one that counts.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let tabOrigin = '';
  try { tabOrigin = tab?.url ? new URL(tab.url).origin : ''; } catch { tabOrigin = ''; }
  if (tabOrigin !== origin) return { success: false, refused: 'origin', error: `The tab is on ${tabOrigin || 'a page Foxl cannot read'}, not ${origin}, the site the sign-in was saved for. Nothing was typed.` };
  // Fingerprinted before any value reaches the page, so no read can catch one first (WHAT A SAVED SIGN-IN TYPED).
  await noteFilled(tabId, origin, fields.map((field) => field.value));
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'FILL_SIGN_IN', expectedOrigin: origin, fields, deadline }, { frameId: 0 });
    return result || { success: false, error: 'No answer from the page' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Select option in dropdown
 */
async function selectOption(tabId, refId, value, deadline) {
  if (!tabId || !refId) {
    return { success: false, error: 'Tab ID and ref ID required' };
  }
  
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'SELECT_OPTION',
      refId,
      value,
      deadline,
    });
    
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/*
 * WHERE A TAB MAY GO (foxl-ai/pilot #7924). `navigate` and `new_tab` open a web page (http or https) or a blank
 * tab, nothing else: `file:`, `data:`, `blob:`, `javascript:` and the browser's own pages are not a page a task is
 * on. Anything else is refused
 * by name, before a tab is created or changed. A relative or scheme-less address was never a page either (Chrome
 * reads it relative to the extension's own origin).
 */
function navigableUrl(url, { required }) {
  const refuse = (error) => ({ ok: false, refusal: { success: false, nothingWasDone: true, error } });
  if (url === undefined || url === null || url === '') {
    return required ? refuse('navigate needs a url: an http:// or https:// address.') : { ok: true, url: null };
  }
  if (typeof url !== 'string') return refuse('The url must be a string: an http:// or https:// address.');
  const text = url.trim();
  if (text === 'about:blank') return { ok: true, url: 'about:blank' };
  let parsed;
  try { parsed = new URL(text); } catch { parsed = null; }
  if (!parsed) return refuse(`${JSON.stringify(text.slice(0, 200))} is not a full address. Foxl opens only http:// and https:// pages (or about:blank); nothing was opened.`);
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { ok: true, url: parsed.href };
  return refuse(`Foxl opens only http:// and https:// pages (or about:blank), not ${parsed.protocol} addresses; nothing was opened.`);
}

/**
 * Navigate tab to URL
 * IMPORTANT: Only navigates Pilot's working tab, not user's current tab
 */
async function navigateTab(tabId, url) {
  // Use explicit tabId, or focused tab, or find existing Pilot tab, or create new one
  let targetTabId = await resolveTargetTab(tabId);

  // If still no tab, create one
  if (!targetTabId) {
    const result = await createBackgroundTab(url);
    return result;
  }
  
  // Verify the tab still exists
  try {
    const tab = await chrome.tabs.get(targetTabId);
    const pilotGroupId = await getOrCreatePilotTabGroup();

    // A Foxl tab outside the group (one the person handed over, a pop-up a Foxl tab opened) joins it; any
    // other tab was refused before this (executeBrowserCommand, FOXL ACTS ONLY IN ITS OWN TABS).
    if (pilotGroupId && tab.groupId !== pilotGroupId) {
      await addTabToPilotGroup(targetTabId);
    }
  } catch (e) {
    // Tab doesn't exist anymore, create new one
    tabContexts.delete(targetTabId);
    if (focusedTabId === targetTabId) focusedTabId = null;
    const result = await createBackgroundTab(url);
    return result;
  }
  
  try {
    const loaded = waitForTabLoad(targetTabId);
    await chrome.tabs.update(targetTabId, { url });
    await loaded;

    return { success: true, tabId: targetTabId };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Resolve when the tab's page has loaded, or after `LOAD_WAIT_MS`.
 *
 * THE LISTENER USED TO BE ADDED AFTER THE NAVIGATION, so a page that finished loading
 * in between (a fast local page, a cached one) never fired a 'complete' the listener could
 * see, and every such `navigate` / `new_tab` sat out the full 30 s - exactly the desktop's
 * own command timeout, so the desktop gave up first and reported "timed out" for a page
 * that had loaded in under a second. Measured with a local page: 30 s per new tab.
 *
 * Now the listener is attached BEFORE the navigation starts (`navigateTab`), and for a tab
 * whose navigation is already under way (`chrome.tabs.create`) the tab's current status is
 * read after attaching, so a load that already completed resolves at once. 25 s, so the
 * extension answers before the desktop's 30 s timeout ever fires.
 */
const LOAD_WAIT_MS = 25000;
function waitForTabLoad(tabId, { alreadyStarted = false, waitMs = LOAD_WAIT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, waitMs);
    if (alreadyStarted) {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === 'complete' && tab.url && tab.url !== 'about:blank') finish();
      }).catch(finish);
    }
  });
}

/*
 * WHAT A CLICK OR A KEY PRESS SENT (0.12.0, foxl-ai/pilot #6394; the page side is step-watch.js). A
 * click returns as soon as the content script has clicked, before a form's navigation starts, so a
 * read sent with it saw the form again and one bill dispute was filed twice. Here a read sent while a
 * page load is under way reaches the OLD page (unlike Foxl's own browser, whose next read waits for it),
 * so a load the step started is waited out before the step answers. The design is the desktop's
 * (foxl-ai/pilot server/tools/browser-step-watch.ts):
 *   1. armed before the step (`STEP_ARM`, with `hold`: the forms the desktop's chat already sent, and
 *      `chat`: that chat's key, which finds a form a stopped step of the chat left on this site);
 *   2. asked at once after it (`STEP_LOOK`): a step that sent no form and started no page load is done;
 *   3. for a form, waited on in the page until its answer starts (`STEP_SETTLE`);
 *   4. a page load, then waited out and the page it led to read (`STEP_PAGE`): a new page, or the same one
 *      for a download or a 204, as soon as the tab stops loading, never past STEP_SETTLE_MS.
 */
const STEP_SETTLE_MS = 8000;
/*
 * How long STEP_SETTLE's answer is waited for HERE: the page's own loop (STEP_SETTLE_MS, then at most 1.5 s of quiet),
 * plus a second. That loop runs on the page's timers, which do not run while the page shows a dialog (an alert() after a
 * fetch-sent form: the answer came 40 s later with the dialog open 40 s, past the desktop's 30 s timeout) and are
 * throttled in a tab the person is not looking at; this timer is the service worker's own.
 */
const STEP_SETTLE_ANSWER_MS = STEP_SETTLE_MS + 2500;
const LATE = Symbol('late');

/** The steps that can send a form or start a navigation: a click, a key press, and typing that presses Enter. */
function stepWatched(action, params) {
  return action === 'click' || action === 'click_at' || action === 'press_key' || (action === 'type' && params?.submit === true);
}

function runWatchedStep(action, tabId, params, deadline) {
  switch (action) {
    case 'click': return clickElement(tabId, params.refId, deadline);
    case 'click_at': return clickAt(tabId, params?.x, params?.y, deadline);
    case 'press_key': return pressKey(tabId, params?.key, params?.refId, deadline);
    case 'type': return typeInElement(tabId, params.refId, params.text, params.submit, deadline);
    default: return Promise.resolve({ success: false, error: `Unknown action: ${action}` });
  }
}

/** A message to the tab's top frame, or null when no page there answers (gone, or not there yet); LATE past `waitMs`. */
async function askTopFrame(tabId, message, waitMs = 0) {
  try {
    const answer = chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    if (!waitMs) return await answer;
    answer.catch(() => {});
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(LATE), waitMs); });
    try { return await Promise.race([answer, late]); } finally { clearTimeout(timer); }
  } catch {
    return null;
  }
}

/*
 * WHAT A STEP SENT, KEPT WHERE THE PAGE CANNOT REACH IT (foxl-ai/pilot #7925). Every described submit leaves a record
 * of its form and the desktop chat's key, so a step whose answer was never read is held and reported as `leftover` by
 * the next arm on that site, and a step read in the page it led to says what it sent. The page's step watch sends
 * it here (STEP_SENT, its top frame only), and it is kept in
 * chrome.storage.session under the tab and the page's origin as Chrome names the sender: the next arm on that origin
 * in that tab takes it, and a look in a new page of that origin reads it. Only describe's shape and sizes are kept.
 */
const STEP_RECORDS_KEY = 'foxlStepSent';
const STEP_LEFTOVER_MS = 30 * 60_000;
const STEP_RECORDS_MAX = 50;
const stepRecords = new Map(); // `${tabId}|${origin}` -> { info, chat, at, counted }
let stepRecordsLoaded = null;

function loadStepRecords() {
  stepRecordsLoaded ??= chrome.storage.session.get(STEP_RECORDS_KEY).then((stored) => {
    for (const [key, record] of stored?.[STEP_RECORDS_KEY] ?? []) if (!stepRecords.has(key)) stepRecords.set(key, record);
  }).catch(() => {});
  return stepRecordsLoaded;
}

function saveStepRecords() {
  while (stepRecords.size > STEP_RECORDS_MAX) stepRecords.delete(stepRecords.keys().next().value);
  chrome.storage.session.set({ [STEP_RECORDS_KEY]: [...stepRecords] }).catch(() => {});
}

/** A described form in the shape and sizes `describe` gives (step-watch.js), or null. */
function stepFormOf(info) {
  if (!info || typeof info !== 'object' || typeof info.digest !== 'string' || !/^[0-9a-f]{16}$/.test(info.digest)) return null;
  const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
  return { digest: info.digest, host: str(info.host, 255), action: str(info.action, 2048), label: str(info.label, 80), summary: Array.isArray(info.summary) ? info.summary.slice(0, 8).map((l) => str(l, 200)) : [] };
}

/** STEP_SENT from a tab's top frame: its record, under that tab and the origin Chrome names for the sender. */
async function keepStepRecord(sender, record) {
  const tabId = sender?.tab?.id;
  const origin = typeof sender?.origin === 'string' ? sender.origin : originOf(sender?.url);
  const info = stepFormOf(record?.info);
  if (!Number.isSafeInteger(tabId) || sender.frameId !== 0 || !origin || origin === 'null' || !info) return false;
  await loadStepRecords();
  const key = `${tabId}|${origin}`;
  stepRecords.delete(key);
  stepRecords.set(key, { info, chat: typeof record.chat === 'string' ? record.chat.slice(0, 256) : '', at: Number(record.at) || Date.now(), counted: record.counted === true });
  saveStepRecords();
  return true;
}

/** The record of this tab and origin, removed (the next arm takes it). */
async function takeStepRecord(tabId, origin) {
  await loadStepRecords();
  const key = `${tabId}|${origin}`;
  const record = stepRecords.get(key) ?? null;
  if (record) { stepRecords.delete(key); saveStepRecords(); }
  return record;
}

/** A step read in the page it led to (`fromRecord`): what it sent is this tab's record for that page's origin, for this chat. */
async function withStepRecord(tabId, armed, answer) {
  if (!answer || answer === LATE || !answer.fromRecord) return answer;
  await loadStepRecords();
  const record = typeof answer.pageOrigin === 'string' ? stepRecords.get(`${tabId}|${answer.pageOrigin}`) : null;
  const submitted = record && armed.chat && record.chat === armed.chat ? stepFormOf(record.info) : null;
  const { fromRecord: _fromRecord, pageOrigin: _pageOrigin, ...rest } = answer;
  return { ...rest, submitted };
}

/** Arms the tab's page (its top frame), or null when it cannot be armed: the step then runs as before. */
async function armStep(tabId, hold, chat) {
  // A form a stopped step of this chat sent on this site, taken from the record (WHAT A STEP SENT, below).
  const key = typeof chat === 'string' ? chat : '';
  let origin = null;
  try { origin = originOf((await chrome.tabs.get(tabId)).url); } catch { origin = null; }
  const record = origin ? await takeStepRecord(tabId, origin) : null;
  const sent = record && key && record.chat === key && record.counted && Date.now() - record.at >= 0 && Date.now() - record.at < STEP_LEFTOVER_MS ? record.info : null;
  const r = await askTopFrame(tabId, { type: 'STEP_ARM', hold: Array.isArray(hold) ? hold : [], chat: key, leftover: sent, leftoverOrigin: sent ? origin : '' });
  return r && r.success && typeof r.origin === 'number'
    ? { origin: r.origin, chat: typeof chat === 'string' ? chat : '', leftover: r.leftover || null }
    : null;
}

/**
 * Until the tab's page load is over, at most `waitMs`. A load that has not shown yet (the navigation starts in a
 * later task) is looked for briefly; a tab that never starts loading has nothing to wait for. True when it ended.
 */
async function waitForPageLoadEnd(tabId, waitMs) {
  const until = Date.now() + waitMs;
  const status = async () => { try { return (await chrome.tabs.get(tabId)).status; } catch { return 'complete'; } };
  let seenLoading = false;
  for (const lookUntil = Date.now() + 500; Date.now() < lookUntil && !seenLoading; ) {
    if (await status() === 'loading') seenLoading = true; else await new Promise((r) => setTimeout(r, 50));
  }
  if (!seenLoading) return true;
  while (Date.now() < until) {
    if (await status() === 'complete') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** The page a step's page load led to: a new page, the same one (a download, a 204), or still loading at the bound. */
async function pageAfterStep(tabId, armed, started, form, followedLink) {
  const ended = await waitForPageLoadEnd(tabId, Math.max(1000, STEP_SETTLE_MS - (Date.now() - started)));
  for (let i = 0; i < 10; i++) {
    const p = await askTopFrame(tabId, { type: 'STEP_PAGE', origin: armed.origin });
    if (p && p.success) {
      const waitedMs = Date.now() - started;
      if (!ended) return { settled: 'still_loading', navigated: true, submitted: form, blocked: null, waitedMs, page: null };
      // A link that led nowhere new (a download): the step's answer is what it always was.
      if (followedLink && !p.newDocument) return null;
      return { settled: p.newDocument || followedLink ? 'answered' : 'no_page', navigated: true, submitted: form, blocked: null, waitedMs, page: p.page || null };
    }
    // The new page's scripts are not there yet.
    await new Promise((r) => setTimeout(r, 200));
  }
  return { settled: 'still_loading', navigated: true, submitted: form, blocked: null, waitedMs: Date.now() - started, page: null };
}

/**
 * After an action that failed or threw: the step is read only to end it in the page (a look ends a step that sent
 * nothing; a form that went out anyway is waited on, bounded, so the page still counts it). No page answering: nothing to end.
 */
async function endStep(tabId, armed) {
  const look = await askTopFrame(tabId, { type: 'STEP_LOOK', origin: armed.origin, chat: armed.chat }, 2000);
  if (look && look !== LATE && look.success && look.phase === 'submitting') {
    await askTopFrame(tabId, { type: 'STEP_SETTLE', origin: armed.origin, chat: armed.chat }, STEP_SETTLE_ANSWER_MS);
  }
}

/** What the step sent, or null when the page could not say (the step's own answer then stands). */
async function finishStep(tabId, armed) {
  const started = Date.now();
  const report = (r) => ({ settled: r.settled, navigated: !!r.navigated, submitted: r.submitted || null, blocked: r.blocked || null, waitedMs: Date.now() - started, page: r.page || null });
  const look = await withStepRecord(tabId, armed, await askTopFrame(tabId, { type: 'STEP_LOOK', origin: armed.origin, chat: armed.chat }));
  // No page answered: the step's page load is under way (or committed before the look). Wait it out and read it.
  if (!look || !look.success) return pageAfterStep(tabId, armed, started, null, false);
  if (look.phase === 'done') {
    // A link the step followed: a read sent now would reach the page being left, so its load is waited out.
    if (look.settled === 'nothing' && look.navigated) return pageAfterStep(tabId, armed, started, null, true);
    return report(look);
  }
  // A form being sent: until its answer starts.
  const settle = await withStepRecord(tabId, armed, await askTopFrame(tabId, { type: 'STEP_SETTLE', origin: armed.origin, chat: armed.chat }, STEP_SETTLE_ANSWER_MS));
  // The page did not answer in time (a dialog, a throttled tab): sent if the page had counted it, and still going.
  if (settle === LATE) return { settled: 'still_loading', navigated: !!look.navigated, submitted: look.counted ? look.submitted || null : null, blocked: null, waitedMs: Date.now() - started, page: null };
  // A page load started (or the page went away while it waited): the form went out; its answer is that load.
  if (!settle || !settle.success || settle.settled === 'navigating') return pageAfterStep(tabId, armed, started, look.submitted || null, false);
  return report(settle);
}

/**
 * Get or create Pilot tab group
 */
async function getOrCreatePilotTabGroup() {
  // Check if existing group is still valid
  if (pilotTabGroupId) {
    try {
      const group = await chrome.tabGroups.get(pilotTabGroupId);
      if (group) return pilotTabGroupId;
    } catch (e) {
      // Group no longer exists
      pilotTabGroupId = null;
    }
  }
  
  // Find existing Pilot group by querying all groups
  try {
    const groups = await chrome.tabGroups.query({});
    const pilotGroup = groups.find(g => g.title === 'Foxl' || g.title === 'Pilot');
    if (pilotGroup) {
      pilotTabGroupId = pilotGroup.id;
      return pilotTabGroupId;
    }
  } catch (e) {
    console.error('[Foxl] Error querying tab groups:', e);
  }
  
  // No existing group, will create when first tab is added
  return null;
}

/**
 * Add tab to Pilot group
 */
async function addTabToPilotGroup(tabId) {
  try {
    let groupId = await getOrCreatePilotTabGroup();
    
    if (groupId) {
      // Add to existing group
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    } else {
      // Create new group with this tab
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      
      // IMPORTANT: Wait before updating - Chrome needs time to create the group
      await new Promise(r => setTimeout(r, 100));
      
      // Update group properties (title, color)
      try {
        await chrome.tabGroups.update(groupId, {
          title: 'Foxl',
          color: 'cyan',
          collapsed: false
        });
        console.log('[Foxl] Created tab group with title and color:', groupId);
      } catch (updateErr) {
        console.error('[Foxl] Failed to update group properties:', updateErr);
      }
      
      pilotTabGroupId = groupId;
    }
    
    return groupId;
  } catch (err) {
    console.error('[Foxl] Failed to add tab to group:', err);
    return null;
  }
}

/**
 * Create new tab in Pilot group (background)
 */
async function createBackgroundTab(url) {
  try {
    // Create tab (not active, so it opens in background)
    const tab = await chrome.tabs.create({ 
      url: url || 'about:blank',
      active: false // Don't switch to this tab
    });
    
    // Track this tab in multi-tab contexts and focus it
    trackTab(tab.id, url ? (new URL(url).hostname || 'new tab') : 'new tab', true);
    
    // Add to Pilot group
    const groupId = await addTabToPilotGroup(tab.id);
    
    // Wait for page to load if URL provided
    if (url) await waitForTabLoad(tab.id, { alreadyStarted: true });
    
    console.log('[Foxl] Created background tab:', tab.id, 'in group:', groupId);
    return { success: true, tabId: tab.id, groupId };
  } catch (err) {
    console.error('[Foxl] Failed to create background tab:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get tabs in Pilot group
 */
async function getPilotTabs() {
  const groupId = await getOrCreatePilotTabGroup();
  if (!groupId) {
    return { success: true, tabs: [], groupId: null };
  }
  
  try {
    const tabs = await chrome.tabs.query({ groupId });
    return {
      success: true,
      groupId,
      tabs: tabs.map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        openerTabId: t.openerTabId ?? null
      }))
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Collapse/expand Pilot tab group
 */
async function setPilotGroupCollapsed(collapsed) {
  const groupId = await getOrCreatePilotTabGroup();
  if (!groupId) {
    return { success: false, error: 'No Pilot tab group' };
  }
  
  try {
    await chrome.tabGroups.update(groupId, { collapsed });
    return { success: true, collapsed };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Create new tab (original function, now uses background tab)
 */
async function createNewTab(url) {
  return createBackgroundTab(url);
}

/**
 * Close tab
 */
async function closeTab(tabId) {
  if (!tabId) {
    return { success: false, error: 'Tab ID required' };
  }
  
  try {
    await chrome.tabs.remove(tabId);
    tabContexts.delete(tabId);
    if (focusedTabId === tabId) {
      // Auto-focus next available tab
      const remaining = [...tabContexts.keys()];
      focusedTabId = remaining.length > 0 ? remaining[0] : null;
    }
    broadcastTabContexts();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get all tabs
 */
/*
 * Foxl's own tabs only (FOXL ACTS ONLY IN ITS OWN TABS). Every other tab is a number, `otherTabs`, never its URL or
 * title: an address alone can carry a secret (a reset link, a document's id). A desktop that looks for a tab on a
 * site (a saved sign-in's page) therefore finds only Foxl's, and opens the page itself when there is none.
 */
async function getTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const foxl = await foxlTabsAmong(tabs);
    const mine = tabs.filter((t, i) => foxl[i]);
    return {
      success: true,
      tabs: mine.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        // #6245: the tab that opened this one (a pop-up, a target=_blank link), or null.
        openerTabId: t.openerTabId ?? null,
      })),
      otherTabs: tabs.length - mine.length,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Scroll page
 */
async function scrollPage(tabId, direction = 'down', amount = 500) {
  if (!tabId) {
    tabId = await resolveTargetTab(null);
  }

  if (!tabId) {
    return { success: false, error: 'No target tab' };
  }
  
  try {
    // A negative amount scrolls the other way, as it did in 0.8.1 (the desktop's schema is
    // z.number(), so a model can send one).
    if (!['up', 'down'].includes(direction) || !Number.isFinite(amount)) {
      return { success: false, error: 'scroll needs direction up/down and a numeric amount.' };
    }
    // Bounded like every other page read: with site access withheld Chrome leaves the
    // injection pending, and the desktop would otherwise wait out its own 30 s timeout.
    const page = await readAllowedPage(tabId, (dir, amt) => {
      window.scrollBy({ top: dir === 'up' ? -amt : amt, behavior: 'instant' });
      return { url: location.href, x: scrollX, y: scrollY };
    }, [direction, amount]);
    /*
     * A tab in the background runs no rendering steps, so the page's scroll listeners and
     * IntersectionObservers (infinite lists, lazy images) do not fire until it is drawn, and
     * the next snapshot showed none of what the scroll should have loaded (measured: 0.8.1,
     * which selected the tab, loaded it; this did not until a screenshot drew the tab). One
     * 1x1 capture draws it once, through the same debugger path and site-access checks.
     */
    const tab = await chrome.tabs.get(tabId);
    const rendered = tab.active || await captureTabScreenshot(tabId, { clip: { x: 0, y: 0, width: 1, height: 1 } })
      .then(() => true, () => false);
    return { success: true, tabId, scroll: { x: page.x, y: page.y }, rendered };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get page info
 */
async function getPageInfo(tabId) {
  if (!tabId) {
    tabId = await resolveTargetTab(null);
  }

  if (!tabId) {
    return { success: false, error: 'No target tab' };
  }
  
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      success: true,
      info: {
        url: tab.url,
        title: tab.title,
        tabId: tab.id
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send message to server
 */
function sendToServer(message) {
  return transportSend(message);
}

/**
 * Send the side panel's message to the desktop over the live channel.
 */
let pendingPanelChat = null;

async function sendChatMessage(message, tabId, panelId, requestId) {
  if (pendingPanelChat) {
    return { success: false, error: 'Foxl is working in another side panel. Let that request finish, then try again.' };
  }
  /*
   * The live channel only (the native host, or the socket on a desktop that never installed the bridge). There is
   * no HTTP fallback to `/api/chat` (foxl-ai/pilot #7795).
   */
  if (transportIsOpen()) {
    pendingPanelChat = { panelId, requestId, tabId };
    if (!transportSend({ type: 'chat', message, tabId })) {
      pendingPanelChat = null;
      return { success: false, error: 'The connection to Foxl Desktop was lost. Try again.' };
    }
    return { success: true, pending: true };
  }
  return { success: false, error: 'Foxl Desktop is not connected. Open Foxl Desktop on this computer, then try again.' };
}

/**
 * Check server health
 */
async function checkServerHealth() {
  const serverUrl = await getServerUrl();
  
  try {
    const response = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch (err) {
    return false;
  }
}

/**
 * Open side panel for tab
 */
async function openSidePanel(tabId) {
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: `sidepanel.html?tabId=${encodeURIComponent(tabId)}`,
      enabled: true
    });
    await chrome.sidePanel.open({ tabId });
  } catch (err) {
    console.error('[Foxl] Failed to open side panel:', err);
  }
}

/*
 * WHILE FOXL ACTS IN A TAB, THAT TAB SAYS SO (foxl-ai/pilot #7804). The extension raises the overlay (the glow and
 * the Stop Foxl button, visual-indicator.js) itself for every command that acts in or captures a tab
 * (OVERLAY_ACTIONS), for as long as the command runs.
 * The desktop's show keeps it up between commands, as before; its hide (and the person's Stop) takes effect at
 * once when no command is running on that tab, else when the last one ends. A command the desktop did not ask
 * the overlay for clears it OVERLAY_GRACE_MS after it ends, so the next command or the desktop's own show,
 * which follows every command, finds it still up. The screenshot itself still leaves it out (page-capture.js).
 * Messages to the page are not awaited: a page held by a dialog never holds a command here.
 */
const OVERLAY_ACTIONS = new Set(['get_accessibility_tree', 'read_text', 'screenshot', 'click', 'type', 'fill_sign_in', 'click_at', 'press_key', 'hover', 'select', 'navigate', 'scroll']);
const OVERLAY_GRACE_MS = 800;
const overlayWanted = new Set(); // tabs the desktop asked to show the overlay on
const commandsActing = new Map(); // tabId -> commands running on it
const overlayHideTimers = new Map(); // tabId -> the grace timer of a pending hide

function overlayMessage(tabId, type) {
  chrome.tabs.sendMessage(tabId, { type }).catch(() => { /* no page script there (yet): nothing to show */ });
}

function cancelOverlayHide(tabId) {
  clearTimeout(overlayHideTimers.get(tabId));
  overlayHideTimers.delete(tabId);
}

/** A command that acts in or captures this tab starts: the overlay is up while it runs. */
function beginActing(tabId) {
  cancelOverlayHide(tabId);
  const n = (commandsActing.get(tabId) || 0) + 1;
  commandsActing.set(tabId, n);
  if (n === 1) overlayMessage(tabId, 'SHOW_AGENT_INDICATORS');
}

/** It ended: the overlay stays while another runs or the desktop wants it, else goes after the grace. */
function endActing(tabId) {
  const n = (commandsActing.get(tabId) || 1) - 1;
  if (n > 0) { commandsActing.set(tabId, n); return; }
  commandsActing.delete(tabId);
  // A navigation replaced the page, and the overlay with it: the desktop's overlay is put back.
  if (overlayWanted.has(tabId)) { overlayMessage(tabId, 'SHOW_AGENT_INDICATORS'); return; }
  cancelOverlayHide(tabId);
  overlayHideTimers.set(tabId, setTimeout(() => {
    overlayHideTimers.delete(tabId);
    if (!commandsActing.get(tabId) && !overlayWanted.has(tabId)) overlayMessage(tabId, 'HIDE_AGENT_INDICATORS');
  }, OVERLAY_GRACE_MS));
}

/**
 * Show agent indicators on tab (the desktop's `show_indicators`)
 */
async function showAgentIndicators(tabId) {
  const targetTabId = tabId || focusedTabId;
  if (!targetTabId) return;
  overlayWanted.add(targetTabId);
  cancelOverlayHide(targetTabId);
  overlayMessage(targetTabId, 'SHOW_AGENT_INDICATORS');
}

/**
 * Hide agent indicators on tab (the desktop's `hide_indicators`, the side panel's answer, the person's Stop):
 * at once when no command runs on it, else when the last one ends.
 */
async function hideAgentIndicators(tabId) {
  const targetTabId = tabId || focusedTabId;
  if (!targetTabId) return;
  overlayWanted.delete(targetTabId);
  if (commandsActing.get(targetTabId)) return;
  cancelOverlayHide(targetTabId);
  overlayMessage(targetTabId, 'HIDE_AGENT_INDICATORS');
}

// Event Listeners

// Keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-side-panel') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        await openSidePanel(tab.id);
      }
    });
  }
});

// Handle messages from content scripts and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'GET_SERVER_STATUS': {
        // `wsConnected` keeps its name: an older side panel reads that field, and the
        // question it answers - is the live channel up - did not change when a second
        // kind of channel arrived. `transport` names WHICH one, for the panel that cares.
        const wsConnected = transportIsOpen();
        const httpConnected = await checkServerHealth();
        // `everConnected` distinguishes "no desktop installed" from "desktop asleep".
        // Read here rather than in the panel so both surfaces (side panel, options)
        // get the same answer from one place - and it is a DATED question now, so the
        // memory expires instead of pinning a former user to "reconnecting" forever.
        const stored = await chrome.storage.local.get(['everConnected', 'lastConnectedAt', 'serverUrl']).catch(() => ({}));
        const nowMs = Date.now();
        const seenDesktop = hasRecentDesktop(stored, nowMs);
        // Make an undatable record datable, so it can expire like any other. Fire and
        // forget: the verdict above is already decided, and failing to write it only
        // costs one more pass through this branch.
        if (needsDateRepair(stored, nowMs)) {
          chrome.storage.local.set({ everConnected: true, lastConnectedAt: nowMs }).catch(() => {});
        }
        sendResponse({
          connected: wsConnected || httpConnected,
          wsConnected,
          transport: transportKind(),
          nativeUnavailableReason: transportKind() === 'native' ? null : nativeUnavailableReason,
          // The HTTP health check answers while the socket is refused, so `connected` alone would read as working. The
          // same when the bridge is installed (or answered here before) and did not open: the socket is never used then.
          desktopRequiresBridge: !wsConnected && (desktopRequiresBridge || (socketDeclined && httpConnected)),
          everConnected: seenDesktop,
          serverUrl: await getServerUrl(),
          // A saved address that is not on this computer, which getServerUrl does not use (src/server-url.js).
          serverUrlIgnored: Boolean(stored.serverUrl) && !loopbackServerUrl(stored.serverUrl),
          extensionVersion: chrome.runtime.getManifest().version,
          desktopVersion,
          desktopTooOld: desktopIsTooOld(),
          minDesktopVersion: MIN_DESKTOP_VERSION,
        });
        break;
      }

      case 'CONNECT_TO_SERVER':
        const connected = await connectToServer();
        sendResponse({ success: connected });
        break;

      // A page's step watch: what a step sent, kept out of the page (WHAT A STEP SENT).
      case 'STEP_SENT':
        sendResponse({ success: await keepStepRecord(sender, message.record) });
        break;

      case 'SEND_TO_SERVER':
        if (message.data?.type === 'chat' && message.data?.message) {
          // The tab the person is on when they send from Foxl's side panel is handed to Foxl
          // (FOXL ACTS ONLY IN ITS OWN TABS): only from this extension's own pages, never a content script.
          if (fromExtensionPage(sender) && message.data.tabId != null) await handTab(message.data.tabId);
          const result = await sendChatMessage(message.data.message, message.data.tabId, message.data.panelId, message.data.requestId);
          
          if (result.pending) {
            // Response will come via WebSocket
            sendResponse({ success: true, pending: true });
          } else if (result.success) {
            sendResponse({ success: true, content: result.content });
          } else {
            sendResponse({ success: false, error: result.error });
          }
        } else {
          sendResponse({ success: false, error: 'Invalid message' });
        }
        break;

      case 'STOP_AGENT':
        // Nothing queued before Stop runs afterwards (src/input-queue.js), and nothing of the stopped run
        // that arrives after it either (STOP HOLDS).
        holdStoppedRun();
        inputQueue.stop();
        if (!sendToServer({ type: 'stop_agent' })) stopLatch.unsent = true;
        await hideAgentIndicators(sender.tab?.id);
        sendResponse({ success: true });
        break;

      case 'GET_TAB_CONTEXTS': {
        // Clean stale entries
        for (const [id] of tabContexts) {
          try { await chrome.tabs.get(id); } catch { tabContexts.delete(id); }
        }
        if (focusedTabId && !tabContexts.has(focusedTabId)) focusedTabId = null;
        const ctxs = [];
        for (const [id, ctx] of tabContexts) {
          try {
            const t = await chrome.tabs.get(id);
            ctxs.push({ tabId: id, label: ctx.label, url: t.url, title: t.title, focused: id === focusedTabId });
          } catch { /* skip */ }
        }
        sendResponse({ contexts: ctxs, focusedTabId });
        break;
      }

      case 'SWITCH_TAB': {
        const switchId = message.tabId;
        if (!switchId) {
          sendResponse({ success: false, error: 'tabId required' });
          break;
        }
        // A tab chosen in Foxl's own pages is the person handing it over; a content script may not.
        if (!fromExtensionPage(sender)) {
          sendResponse({ success: false, error: 'SWITCH_TAB is answered only for Foxl\'s own pages' });
          break;
        }
        try {
          await chrome.tabs.get(switchId);
          await handTab(switchId);
          focusedTabId = switchId;
          if (!tabContexts.has(switchId)) {
            trackTab(switchId, null, true);
          } else {
            broadcastTabContexts();
          }
          sendResponse({ success: true, focusedTabId: switchId });
        } catch {
          sendResponse({ success: false, error: `Tab ${switchId} not found` });
        }
        break;
      }

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  })();
  return true; // Keep channel open for async response
});

// Tab closed — clean up from contexts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.serverUrl) return;
  clearDiscoveredUrl();
  // A live socket belongs to the old URL. Closing it takes the normal reconnect
  // path, which reads the saved setting again and reports an interrupted request.
  // The native bridge reaches the desktop that installed it, whatever this setting says, so it stays.
  if (transportKind() === 'native') return;
  if (serverSocket) serverSocket.close();
  else connectToServer();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPageSnapshots(tabId);
  loadHandedTabs().then(() => { if (handedTabs.delete(tabId)) saveHandedTabs(); });
  loadFilled().then(() => { if (filledPrints.delete(tabId)) saveFilled(); });
  loadStepRecords().then(() => {
    let removed = false;
    for (const key of [...stepRecords.keys()]) if (key.startsWith(`${tabId}|`)) { stepRecords.delete(key); removed = true; }
    if (removed) saveStepRecords();
  });
  if (tabContexts.has(tabId)) {
    tabContexts.delete(tabId);
    if (focusedTabId === tabId) {
      const remaining = [...tabContexts.keys()];
      focusedTabId = remaining.length > 0 ? remaining[0] : null;
    }
    broadcastTabContexts();
  }
});

// Extension installed/updated
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Foxl] Extension installed:', details.reason);
  
  if (details.reason === 'install') {
    // Open options page on first install
    chrome.tabs.create({ url: 'options.html' });
  }
  
  // Set up periodic health check alarm (every 1 minute)
  // This ensures reconnection even if service worker was killed
  chrome.alarms.create('pilot-health-check', { periodInMinutes: 1 });
  
  // Connect to server
  connectToServer();
});

// Extension started
chrome.runtime.onStartup.addListener(() => {
  console.log('[Foxl] Extension started');
  chrome.alarms.create('pilot-health-check', { periodInMinutes: 1 });
  connectToServer();
});
