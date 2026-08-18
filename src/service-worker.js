/**
 * Foxl Chrome Extension - Service Worker
 * 
 * Background script that handles:
 * - Side panel management
 * - Communication with Foxl server via WebSocket
 * - Browser automation commands from server
 * - Tab management
 */

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
          data: { version: chrome.runtime.getManifest().version }
        }));
        
        // Start keep-alive ping to prevent service worker from sleeping
        startKeepAlive();
        
        resolve(true);
      };
      
      serverSocket.onclose = (event) => {
        console.log('[Foxl] Disconnected from server:', event.code, event.reason);
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
      
    case 'SERVER_RESPONSE':
      // Chat response - broadcast to sidepanel
      chrome.runtime.sendMessage({
        type: 'SERVER_RESPONSE',
        data: message.data
      }).catch(() => {});
      break;
      
    case 'browser_command':
      // Execute browser command and send result back
      const result = await executeBrowserCommand(data);
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

/**
 * Execute browser command from server
 */
async function executeBrowserCommand(command) {
  const { action, tabId, params } = command;
  const targetTabId = await resolveTargetTab(tabId);
  
  try {
    switch (action) {
      case 'get_accessibility_tree':
        return await getAccessibilityTree(targetTabId, params);
        
      case 'click':
        return await clickElement(targetTabId, params.refId);
        
      case 'type':
        return await typeInElement(targetTabId, params.refId, params.text, params.submit);
        
      case 'select':
        return await selectOption(targetTabId, params.refId, params.value);
        
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

      case 'screenshot':
        return await takeScreenshot(targetTabId);
        
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
    });
    
    return { success: true, data: result.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Click element by ref ID
 */
async function clickElement(tabId, refId) {
  if (!tabId || !refId) {
    return { success: false, error: 'Tab ID and ref ID required' };
  }
  
  try {
    // Show visual indicator
    await chrome.tabs.sendMessage(tabId, {
      type: 'HIGHLIGHT_ELEMENT',
      refId,
      duration: 500
    });
    
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'CLICK_ELEMENT',
      refId
    });
    
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Type into element
 */
async function typeInElement(tabId, refId, text, submit = false) {
  if (!tabId || !refId) {
    return { success: false, error: 'Tab ID and ref ID required' };
  }
  
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'TYPE_IN_ELEMENT',
      refId,
      text,
      submit
    });
    
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Select option in dropdown
 */
async function selectOption(tabId, refId, value) {
  if (!tabId || !refId) {
    return { success: false, error: 'Tab ID and ref ID required' };
  }
  
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'SELECT_OPTION',
      refId,
      value
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
    await chrome.tabs.update(targetTabId, { url });
    
    // Wait for page to load
    await new Promise((resolve) => {
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === targetTabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 30000);
    });
    
    return { success: true, tabId: targetTabId };
  } catch (err) {
    return { success: false, error: err.message };
  }
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
    if (url) {
      await new Promise((resolve) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 30000);
      });
    }
    
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
        active: t.active
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
        windowId: t.windowId
      }))
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Temporarily activate a tab, run a callback, then restore the previous tab.
 * Needed because some Chrome APIs (captureVisibleTab, scrollBy) only work on the visible tab.
 */
async function withActiveTab(tabId, fn) {
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;

  // Already active — just run
  if (tab.active) {
    return await fn(tabId, windowId);
  }

  const [prevActive] = await chrome.tabs.query({ active: true, windowId });

  // Activate target
  await chrome.tabs.update(tabId, { active: true });
  await new Promise(r => setTimeout(r, 150));

  try {
    return await fn(tabId, windowId);
  } finally {
    // Restore previous tab
    if (prevActive?.id && prevActive.id !== tabId) {
      await chrome.tabs.update(prevActive.id, { active: true });
    }
  }
}

/**
 * Take screenshot of tab
 */
async function takeScreenshot(tabId) {
  try {
    if (!tabId) {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      return { success: true, dataUrl };
    }

    const dataUrl = await withActiveTab(tabId, async (_tid, windowId) => {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    });

    return { success: true, dataUrl, tabId };
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
    await withActiveTab(tabId, async (tid) => {
      await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: (dir, amt) => {
          const y = dir === 'up' ? -amt : amt;
          window.scrollBy({ top: y, behavior: 'smooth' });
        },
        args: [direction, amount]
      });
      // Wait for smooth scroll to finish
      await new Promise(r => setTimeout(r, 300));
    });
    return { success: true };
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
async function sendChatMessage(message, tabId) {
  // Try WebSocket first
  if (serverSocket?.readyState === WebSocket.OPEN) {
    serverSocket.send(JSON.stringify({
      type: 'chat',
      message,
      tabId
    }));
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
          const result = await sendChatMessage(message.data.message, message.data.tabId);
          
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
chrome.tabs.onRemoved.addListener((tabId) => {
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
