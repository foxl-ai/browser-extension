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
 */
const CAPABILITIES = ['read-marks', 'read-text', 'downloads', 'tab-openers', 'step-watch'];

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
  // User explicitly set a URL - always use it
  const result = await chrome.storage.local.get(['serverUrl']);
  if (result.serverUrl) {
    return result.serverUrl;
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

/**
 * Connect to server via WebSocket
 */
async function connectToServer() {
  if (serverSocket?.readyState === WebSocket.OPEN) {
    return true;
  }
  
  // Prevent duplicate connection attempts
  if (isConnecting) {
    return false;
  }
  isConnecting = true;
  
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
      
      serverSocket.onopen = () => {
        console.log('[Foxl] Connected to server');
        isConnecting = false;
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
        // Cache the working server URL for faster reconnects
        getServerUrl().then(url => { discoveredServerUrl = url; });
        serverSocket.send(JSON.stringify({
          type: 'extension_connected',
          data: { version: chrome.runtime.getManifest().version, capabilities: CAPABILITIES }
        }));
        
        // Start keep-alive ping to prevent service worker from sleeping
        startKeepAlive();
        
        resolve(true);
      };
      
      serverSocket.onclose = (event) => {
        console.log('[Foxl] Disconnected from server:', event.code, event.reason);
        if (pendingPanelChat) {
          chrome.runtime.sendMessage({
            type: 'SERVER_RESPONSE',
            data: { error: 'The connection was lost. Your task may still be running; check Foxl Desktop before trying again.' },
            ...pendingPanelChat,
          }).catch(() => {});
          pendingPanelChat = null;
        }
        clearPageSnapshots();
        serverSocket = null;
        // Forget the peer's version with the socket. Keeping it would attribute the
        // old desktop's version to whatever answers next.
        desktopVersion = null;
        isConnecting = false;
        clearDiscoveredUrl();
        stopKeepAlive();
        scheduleReconnect();
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
    if (serverSocket?.readyState === WebSocket.OPEN) {
      serverSocket.send(JSON.stringify({ type: 'ping' }));
    } else {
      // Socket died silently - trigger reconnect
      console.log('[Foxl] Keep-alive detected dead socket, reconnecting...');
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
    if (!serverSocket || serverSocket.readyState !== WebSocket.OPEN) {
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
      if (INPUT_ACTIONS.has(data?.action)) {
        const tab = await resolveTargetTab(data.tabId);
        result = await inputQueue.run(tab ?? 'no-tab', (deadline) => executeBrowserCommand({ ...data, tabId: tab ?? data.tabId, deadline }));
      } else {
        result = await executeBrowserCommand(data);
      }
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
 * ONE INPUT AT A TIME, PER TAB, WITH A DEADLINE (src/input-queue.js has the measurements).
 * Clicks, typing, keys and hovers on one tab share its focus, and Foxl Desktop runs a
 * model's tool calls concurrently, so on one tab they are queued. A tab whose page is stuck
 * (a confirm() dialog, a hung script) holds only its own queue, and only until the
 * action's deadline; an action that could not start in time is refused, not run late.
 */
const INPUT_ACTIONS = new Set(['click', 'type', 'select', 'click_at', 'press_key', 'hover']);
const inputQueue = createInputQueue();

/**
 * Execute browser command from server
 */
async function executeBrowserCommand(command) {
  const { action, tabId, params, deadline } = command;
  const targetTabId = await resolveTargetTab(tabId);
  // A navigation to a file downloads from the site it names, so it is remembered with that one.
  if (targetTabId && (INPUT_ACTIONS.has(action) || action === 'navigate')) await noteActed(targetTabId, action === 'navigate' ? params?.url : null);

  try {
    // 0.12.0 (foxl-ai/pilot #6394): a click or a key press that sends a form is watched until its answer starts.
    const watched = targetTabId && stepWatched(action, params) ? await armStep(targetTabId, params?.hold, params?.chat) : null;
    if (watched) {
      const result = await runWatchedStep(action, targetTabId, params, deadline);
      const step = result && result.success !== false ? await finishStep(targetTabId, watched) : null;
      const out = step && step.settled !== 'nothing' ? { ...result, step } : { ...result };
      // A form a stopped step of this chat sent here: held this time, and reported for the desktop to record.
      if (watched.leftover) out.leftover = watched.leftover;
      // Nothing happened: the answer is what it always was.
      return step && step.settled !== 'nothing' || watched.leftover ? out : result;
    }
    switch (action) {
      case 'get_accessibility_tree':
        if (params?.snapshot) return withDownloads(await getPageSnapshot(targetTabId, params), targetTabId);
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

      // Added in 0.8.0: what a person does without an element ref (page events).
      case 'click_at':
        return await clickAt(targetTabId, params?.x, params?.y, deadline);

      case 'press_key':
        return await pressKey(targetTabId, params?.key, params?.refId, deadline);

      case 'hover':
        return await hoverElement(targetTabId, params?.refId, params?.x, params?.y, deadline);
        
      case 'select':
        return await selectOption(targetTabId, params.refId, params.value, deadline);
        
      case 'navigate':
        return await navigateTab(targetTabId, params.url);
        
      case 'new_tab':
        return await createNewTab(params.url);
        
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

      case 'screenshot': {
        // No target tab known: 0.8.1 captured the selected tab of the current window
        // (captureVisibleTab(null)), and Foxl Desktop sends no tabId when the model omits it.
        const shotTabId = targetTabId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
        return await captureTabScreenshot(shotTabId, params);
      }
        
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
  const page = await readAllowedPage(tabId, ({ refId, offset, maxChars }) => {
    if (typeof window.__pilotReadText !== 'function') {
      return { url: location.href, success: false, error: 'This page was opened before Foxl\'s extension updated. Reload the page to read an element\'s whole text.' };
    }
    return { ...window.__pilotReadText(refId, offset, maxChars), url: location.href };
  }, [{ refId: params.refId, offset: params.offset ?? 0, maxChars: params.maxChars ?? 4000 }]);
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
      refId: params.refId
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

    const read = await chrome.tabs.sendMessage(tabId, { type: 'READ_VALUE', refId });
    if (!read?.success) return read || { success: false, error: `Could not read ${refId} back` };
    if (!read.password && !valueHolds(read.value, text)) {
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
    
    // If tab is not in Pilot group, add it (don't create a new one)
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

/** A message to the tab's top frame, or null when no page there answers (gone, or not there yet). */
async function askTopFrame(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    return null;
  }
}

/** Arms the tab's page (its top frame), or null when it cannot be armed: the step then runs as before. */
async function armStep(tabId, hold, chat) {
  const r = await askTopFrame(tabId, { type: 'STEP_ARM', hold: Array.isArray(hold) ? hold : [], chat: typeof chat === 'string' ? chat : '' });
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

/** What the step sent, or null when the page could not say (the step's own answer then stands). */
async function finishStep(tabId, armed) {
  const started = Date.now();
  const report = (r) => ({ settled: r.settled, navigated: !!r.navigated, submitted: r.submitted || null, blocked: r.blocked || null, waitedMs: Date.now() - started, page: r.page || null });
  const look = await askTopFrame(tabId, { type: 'STEP_LOOK', origin: armed.origin, chat: armed.chat });
  // No page answered: the step's page load is under way (or committed before the look). Wait it out and read it.
  if (!look || !look.success) return pageAfterStep(tabId, armed, started, null, false);
  if (look.phase === 'done') {
    // A link the step followed: a read sent now would reach the page being left, so its load is waited out.
    if (look.settled === 'nothing' && look.navigated) return pageAfterStep(tabId, armed, started, null, true);
    return report(look);
  }
  // A form being sent: until its answer starts.
  const settle = await askTopFrame(tabId, { type: 'STEP_SETTLE', origin: armed.origin, chat: armed.chat });
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
    trackTab(tab.id, url ? new URL(url).hostname : 'new tab', true);
    
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
async function getTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    return {
      success: true,
      tabs: tabs.map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        // #6245: the tab that opened this one (a pop-up, a target=_blank link), or null.
        openerTabId: t.openerTabId ?? null
      }))
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
  if (serverSocket?.readyState === WebSocket.OPEN) {
    serverSocket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/**
 * Send chat message to server via HTTP (fallback)
 */
let pendingPanelChat = null;

async function sendChatMessage(message, tabId, panelId, requestId) {
  if (pendingPanelChat) {
    return { success: false, error: 'Foxl is working in another side panel. Let that request finish, then try again.' };
  }
  // Try WebSocket first
  if (serverSocket?.readyState === WebSocket.OPEN) {
    pendingPanelChat = { panelId, requestId, tabId };
    try {
      serverSocket.send(JSON.stringify({ type: 'chat', message, tabId }));
    } catch (error) {
      pendingPanelChat = null;
      return { success: false, error: error.message };
    }
    return { success: true, pending: true };
  }
  
  // Fallback to HTTP
  const serverUrl = await getServerUrl();
  
  try {
    const response = await fetch(`${serverUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });
    
    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }
    
    const data = await response.json();
    return { success: true, content: data.response };
  } catch (err) {
    console.error('[Foxl] Chat error:', err);
    return { success: false, error: err.message };
  }
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

/**
 * Show agent indicators on tab
 */
async function showAgentIndicators(tabId) {
  const targetTabId = tabId || focusedTabId;
  if (!targetTabId) return;

  try {
    await chrome.tabs.sendMessage(targetTabId, { type: 'SHOW_AGENT_INDICATORS' });
  } catch (err) {
    console.error('[Foxl] Failed to show indicators:', err);
  }
}

/**
 * Hide agent indicators on tab
 */
async function hideAgentIndicators(tabId) {
  const targetTabId = tabId || focusedTabId;
  if (!targetTabId) return;

  try {
    await chrome.tabs.sendMessage(targetTabId, { type: 'HIDE_AGENT_INDICATORS' });
  } catch (err) {
    console.error('[Foxl] Failed to hide indicators:', err);
  }
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
        const wsConnected = serverSocket?.readyState === WebSocket.OPEN;
        const httpConnected = await checkServerHealth();
        // `everConnected` distinguishes "no desktop installed" from "desktop asleep".
        // Read here rather than in the panel so both surfaces (side panel, options)
        // get the same answer from one place - and it is a DATED question now, so the
        // memory expires instead of pinning a former user to "reconnecting" forever.
        const stored = await chrome.storage.local.get(['everConnected', 'lastConnectedAt']).catch(() => ({}));
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
          everConnected: seenDesktop,
          serverUrl: await getServerUrl(),
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

      case 'SEND_TO_SERVER':
        if (message.data?.type === 'chat' && message.data?.message) {
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
        // Nothing queued before Stop runs afterwards (src/input-queue.js).
        inputQueue.stop();
        sendToServer({ type: 'stop_agent' });
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
        try {
          await chrome.tabs.get(switchId);
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
  if (serverSocket) serverSocket.close();
  else connectToServer();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPageSnapshots(tabId);
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
