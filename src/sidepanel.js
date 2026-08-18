/**
 * Foxl Side Panel
 * Handles chat UI, streaming responses, connection status, model display
 */

const messagesContainer = document.getElementById('messages');
const inputField = document.getElementById('inputField');
const sendButton = document.getElementById('sendButton');
const statusDot = document.getElementById('statusDot');
const modelLabel = document.getElementById('modelLabel');
const settingsBtn = document.getElementById('settingsBtn');
const setupState = document.getElementById('setupState');
const setupTitle = document.getElementById('setupTitle');
const setupBody = document.getElementById('setupBody');
const setupCta = document.getElementById('setupCta');
const setupGone = document.getElementById('setupGone');
const setupRetry = document.getElementById('setupRetry');
const setupSettings = document.getElementById('setupSettings');
const inputContainer = document.querySelector('.input-container');

let isConnected = false;
let isLoading = false;
let streamingEl = null;

const tabBar = document.getElementById('tabBar');
const tabBarInner = document.getElementById('tabBarInner');

const urlParams = new URLSearchParams(window.location.search);
const tabId = urlParams.get('tabId');

// --- Status ---

/*
 * THREE STATES, NOT TWO.
 *
 * The dot alone had exactly two, and the one it could not express is the one most
 * people who install this from a store are in: no Foxl Desktop at all. The extension
 * speaks only to a LOCAL websocket (13847, then 3847), so with no desktop there is
 * nothing to connect to, ever - and a chat box that accepts a message and silently
 * drops it is worse than a screen that says why.
 *
 *   never connected -> "Foxl Desktop is required" + how to get it + a port hint
 *   was connected   -> "Reconnecting" (the backoff is already running)
 *   connected       -> the chat, exactly as before
 *
 * `everConnected` comes from the service worker, which writes it the first time a
 * socket opens.
 */
function updateStatus(connected, model, everConnected, peer) {
  isConnected = connected;
  statusDot.classList.toggle('connected', connected);
  const peerNote = peer?.desktopVersion ? ` (desktop ${peer.desktopVersion}, extension ${peer.extensionVersion || '?'})` : '';
  statusDot.title = connected
    ? `Connected${peerNote}`
    : (everConnected ? 'Reconnecting to Foxl Desktop' : 'Foxl Desktop not found');
  renderVersionNotice(connected, peer);
  if (model) {
    const short = model.split('/').pop()?.split('.').pop() || model;
    modelLabel.textContent = short;
  }
  renderSetupState(connected, everConnected);
}

/*
 * THE DRIFT NOTICE, and the two reasons it is this quiet.
 *
 * Only a REAL version below the floor is warned about: `desktopTooOld` is null when
 * the desktop's version is unknown, which includes every desktop shipped before the
 * handshake existed (they send the literal `1.0.0`). A false "your desktop is too
 * old" on a working setup is worse than silence - it is what teaches somebody to
 * ignore the true one.
 *
 * It is a line in the transcript rather than a modal because the extension still
 * WORKS against an older desktop for everything that does not need the newer
 * behaviour; the failure being fixed here is that it used to fail SILENTLY.
 */
let versionNoticeShown = false;
function renderVersionNotice(connected, peer) {
  if (!connected || !peer || peer.desktopTooOld !== true || versionNoticeShown) return;
  versionNoticeShown = true;
  addMessage(
    'system',
    `Foxl Desktop ${peer.desktopVersion} is older than this extension needs (${peer.minDesktopVersion}+). `
    + 'Update the desktop app if something here does not work.',
    'tool',
  );
}

/** Show the setup panel instead of the transcript when there is nothing to talk to. */
function renderSetupState(connected, everConnected) {
  if (!setupState) return;
  if (connected) {
    setupState.style.display = 'none';
    messagesContainer.style.display = '';
    inputContainer?.classList.remove('is-disabled');
    inputField.placeholder = 'Message Foxl...';
    return;
  }
  setupState.style.display = 'flex';
  messagesContainer.style.display = 'none';
  inputContainer?.classList.add('is-disabled');
  if (everConnected) {
    // A machine that HAS run Foxl Desktop: this is a reconnect, and the service
    // worker's backoff is already trying. Offering a download as the PRIMARY action
    // here would read as "your install is broken".
    //
    // But it cannot be the only story either: somebody who UNINSTALLED the desktop
    // is in this state permanently, and telling them it reconnects automatically is
    // false. So the download stays reachable as a quiet secondary link, and the
    // service worker expires the flag on its own (see DESKTOP_MEMORY_MS) so this
    // screen eventually goes back to the install copy on a machine where the app is
    // really gone. Two independent ways out, because guessing which one applies is
    // exactly what this panel cannot do.
    setupTitle.textContent = 'Reconnecting to Foxl Desktop';
    setupBody.textContent = 'Foxl Desktop is not answering on this computer. It reconnects automatically as soon as the app is running again.';
    setupCta.style.display = 'none';
    if (setupGone) setupGone.style.display = '';
  } else {
    setupTitle.textContent = 'Foxl Desktop is required';
    setupBody.textContent = 'This extension is the browser half of Foxl. It connects to the Foxl Desktop app running on this computer - nothing is sent to a Foxl server from here.';
    setupCta.style.display = '';
    if (setupGone) setupGone.style.display = 'none';
  }
}

// --- Messages ---

function clearEmptyState() {
  const el = messagesContainer.querySelector('.empty-state');
  if (el) el.remove();
}

function addMessage(role, content, cls) {
  clearEmptyState();
  const el = document.createElement('div');
  el.className = `message ${role}${cls ? ' ' + cls : ''}`;
  el.textContent = content;
  messagesContainer.appendChild(el);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  return el;
}

function startStreaming() {
  clearEmptyState();
  streamingEl = document.createElement('div');
  streamingEl.className = 'message assistant streaming';
  streamingEl.textContent = '';
  messagesContainer.appendChild(streamingEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function appendStreaming(text) {
  if (streamingEl) {
    streamingEl.textContent += text;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function endStreaming() {
  if (streamingEl) {
    streamingEl.classList.remove('streaming');
    streamingEl = null;
  }
}

function showLoading() {
  isLoading = true;
  sendButton.disabled = true;
  const el = document.createElement('div');
  el.className = 'loading';
  el.id = 'loadingIndicator';
  el.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div><span>Thinking...</span>';
  messagesContainer.appendChild(el);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function hideLoading() {
  isLoading = false;
  sendButton.disabled = false;
  document.getElementById('loadingIndicator')?.remove();
}

// --- Send ---

async function sendMessage(content) {
  if (!content.trim() || isLoading) return;
  addMessage('user', content.trim());
  inputField.value = '';
  inputField.style.height = 'auto';
  showLoading();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SEND_TO_SERVER',
      data: { type: 'chat', message: content.trim(), tabId: tabId ? parseInt(tabId) : null }
    });

    if (response.pending) return; // response via onMessage

    hideLoading();
    if (response.success && response.content) {
      addMessage('assistant', response.content);
    } else if (response.error) {
      addMessage('system', response.error);
    }
  } catch (err) {
    hideLoading();
    addMessage('system', err.message);
  }
}

// --- Server response handler ---

function handleServerResponse(data) {
  if (data.type === 'stream_start') {
    hideLoading();
    startStreaming();
  } else if (data.type === 'stream_delta') {
    appendStreaming(data.content || '');
  } else if (data.type === 'stream_end') {
    endStreaming();
  } else if (data.type === 'tool') {
    addMessage('tool', `${data.name || 'tool'}`, 'tool');
  } else {
    // Legacy non-streaming
    hideLoading();
    if (data.error) addMessage('system', data.error);
    else if (data.content) addMessage('assistant', data.content);
  }
}

// --- Connection check ---

async function checkConnection() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' });
    updateStatus(res.connected, res.model, res.everConnected, res);
    if (!res.connected) {
      await chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' });
      // Re-ask after the attempt: a successful connect here is the difference
      // between the setup panel and the chat on first open, and the handshake's
      // version frame has landed by then.
      const after = await chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' });
      updateStatus(after.connected, after.model, after.everConnected, after);
    }
  } catch {
    // The service worker was evicted mid-question. Nothing is known about the
    // desktop, so do not claim it was never there: leave `everConnected` undefined
    // and let the next poll answer.
    updateStatus(false, undefined, undefined);
  }
}

setupRetry?.addEventListener('click', () => {
  setupTitle.textContent = 'Looking for Foxl Desktop...';
  checkConnection();
});
setupSettings?.addEventListener('click', () => chrome.runtime.openOptionsPage());

// --- Textarea auto-resize ---

inputField.addEventListener('input', () => {
  inputField.style.height = 'auto';
  inputField.style.height = Math.min(inputField.scrollHeight, 120) + 'px';
});

// --- Events ---

sendButton.addEventListener('click', () => sendMessage(inputField.value));

inputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(inputField.value);
  }
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'SERVER_RESPONSE': handleServerResponse(msg.data); break;
    // `msg.everConnected` may be absent on a broadcast; a connected socket implies
    // it, and for a disconnect the stored value is re-read by the next poll.
    case 'CONNECTION_STATUS': updateStatus(msg.connected, msg.model, msg.everConnected ?? msg.connected); break;
    case 'TOOL_EXECUTION': addMessage('tool', msg.toolName, 'tool'); break;
    case 'TAB_CONTEXTS_UPDATED': renderTabBar(msg.data); break;
  }
  sendResponse({ success: true });
  return true;
});

// --- Tab bar ---

function renderTabBar(data) {
  if (!data || !data.tabs || data.tabs.length === 0) {
    tabBar.style.display = 'none';
    return;
  }
  tabBar.style.display = '';
  tabBarInner.innerHTML = '';
  for (const t of data.tabs) {
    const chip = document.createElement('div');
    chip.className = 'tab-chip' + (t.focused ? ' focused' : '');
    chip.title = t.url || t.title || `Tab ${t.tabId}`;
    const dot = document.createElement('span');
    dot.className = 'tab-chip-dot';
    chip.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = t.label || t.title || `Tab ${t.tabId}`;
    chip.appendChild(label);
    chip.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'SWITCH_TAB', tabId: t.tabId });
    });
    tabBarInner.appendChild(chip);
  }
}

async function loadTabContexts() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_TAB_CONTEXTS' });
    if (res?.contexts) {
      renderTabBar({ tabs: res.contexts, focusedTabId: res.focusedTabId });
    }
  } catch {}
}

// Init
checkConnection();
loadTabContexts();
setInterval(checkConnection, 5000);
setInterval(loadTabContexts, 3000);
inputField.focus();
