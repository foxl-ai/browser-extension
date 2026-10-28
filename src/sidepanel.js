import { messageWithPageContext, readPanelPage, shouldSubmitOnEnter } from './panel-context.js';
import { renderMessageText } from './message-text.js';

const $ = (id) => document.getElementById(id);
const thread = $('thread');
const messages = $('messages');
const welcome = $('welcome');
const input = $('inputField');
const sendButton = $('sendButton');
const newChatButton = $('newChatBtn');
const setup = $('setupState');
const pageButton = $('pageContext');
const panelId = crypto.randomUUID();
let windowId;
let currentPage = null;
let includePage = true;
let connected = false;
let busy = false;
let composing = false;
let requestId = null;
let streamingElement = null;
let pageReadSequence = 0;
let connectionCheck = null;
let loadingNotice = null;
let connectionStatus = {};
const history = [];

function scrollToLatest() { thread.scrollTop = thread.scrollHeight; }

function updateControls() {
  input.disabled = !connected;
  sendButton.disabled = !connected || busy || !input.value.trim();
  newChatButton.disabled = busy || messages.childElementCount === 0;
  document.querySelector('.input-container').classList.toggle('is-disabled', !connected);
  pageButton.disabled = busy;
  for (const button of document.querySelectorAll('.suggestion')) {
    button.disabled = !connected || (button.hasAttribute('data-needs-page') && !currentPage);
  }
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  updateControls();
}

function addMessage(role, content, extraClass = '') {
  welcome.hidden = true;
  const element = document.createElement('div');
  element.className = `message ${role} ${extraClass}`.trim();
  element.textContent = content;
  if (role === 'assistant' && content) renderMessageText(element, content);
  messages.append(element);
  updateControls();
  scrollToLatest();
  return element;
}

function showLoading() {
  const loading = document.createElement('div');
  loading.id = 'loadingIndicator';
  loading.className = 'loading';
  loading.setAttribute('role', 'status');
  const dots = document.createElement('span');
  dots.className = 'loading-dots';
  dots.setAttribute('aria-hidden', 'true');
  dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  loading.append(dots, document.createTextNode('Working on it…'));
  messages.append(loading);
  loadingNotice = setTimeout(() => {
    if (loading.isConnected) loading.lastChild.textContent = 'Still working… You can keep browsing.';
  }, 45000);
  updateControls();
  scrollToLatest();
}

function finishRequest() {
  clearTimeout(loadingNotice);
  loadingNotice = null;
  $('loadingIndicator')?.remove();
  if (streamingElement) {
    history.push({ role: 'assistant', content: streamingElement.textContent });
    renderMessageText(streamingElement, streamingElement.textContent);
  }
  streamingElement = null;
  busy = false;
  requestId = null;
  updateControls();
}

function receiveResponse(data) {
  if (data.type === 'stream_start') {
    $('loadingIndicator')?.remove();
    streamingElement = addMessage('assistant', '');
  } else if (data.type === 'stream_delta') {
    if (!streamingElement) streamingElement = addMessage('assistant', '');
    streamingElement.textContent += data.content || '';
    scrollToLatest();
  } else if (data.type === 'tool') {
    const loading = $('loadingIndicator');
    if (loading) loading.lastChild.textContent = 'Working in your browser…';
  } else {
    if (data.error) addMessage('system', data.error, 'error');
    else if (data.content) {
      if (streamingElement) streamingElement.textContent = data.content;
      else {
        addMessage('assistant', data.content);
        history.push({ role: 'assistant', content: data.content });
      }
    }
    finishRequest();
  }
}

function renderPageContext() {
  pageButton.hidden = !currentPage;
  if (currentPage) {
    $('pageContextTitle').textContent = currentPage.title;
    $('pageContextLabel').textContent = includePage ? 'Current page' : 'Page context off';
    pageButton.setAttribute('aria-pressed', String(includePage));
    pageButton.setAttribute('aria-label', `${includePage ? 'Exclude' : 'Include'} current page: ${currentPage.title}`);
    pageButton.title = `${currentPage.url}\n${includePage ? 'Click to exclude this page' : 'Click to include this page'}`;
  }
  updateControls();
}

async function refreshPage() {
  const sequence = ++pageReadSequence;
  try {
    if (windowId === undefined) windowId = (await chrome.windows.getCurrent()).id;
    const page = await readPanelPage(chrome.tabs, windowId);
    if (sequence !== pageReadSequence) return;
    currentPage = page;
    renderPageContext();
  } catch {
    if (sequence !== pageReadSequence) return;
    currentPage = null;
    renderPageContext();
  }
}

function updateConnection(status) {
  connectionStatus = status;
  connected = Boolean(status.connected);
  $('statusDot').classList.toggle('connected', connected);
  $('connectionLabel').textContent = connected ? 'Connected to Desktop' : 'Desktop not connected';
  $('connectionStatus').title = status.desktopVersion
    ? `Foxl Desktop ${status.desktopVersion} · Extension ${status.extensionVersion || chrome.runtime.getManifest().version}`
    : 'Foxl Desktop runs your agent';
  setup.hidden = connected || messages.childElementCount > 0;
  welcome.hidden = !connected || messages.childElementCount > 0;
  messages.hidden = false;
  input.placeholder = connected ? 'Message Foxl…' : 'Open Foxl Desktop to chat';
  if (!connected) {
    $('setupTitle').textContent = status.everConnected ? 'Let’s reconnect.' : 'Meet your browser’s other half.';
    $('setupBody').textContent = status.everConnected
      ? 'Open Foxl Desktop on this computer. Your browser will reconnect automatically.'
      : 'Foxl Desktop is required. Open the app to connect your agent and start working beside the page.';
    $('setupCta').hidden = Boolean(status.everConnected);
    $('setupGone').hidden = !status.everConnected;
  }
  if (connected && status.desktopTooOld && !document.querySelector('[data-version-notice]')) {
    const notice = addMessage('system', `Foxl Desktop ${status.desktopVersion} needs an update for some features. Open Desktop to update.`);
    notice.dataset.versionNotice = 'true';
  }
  updateControls();
}

function checkConnection() {
  if (connectionCheck) return connectionCheck;
  connectionCheck = chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' })
    .then(updateConnection)
    .catch(() => updateConnection({ connected: false, everConnected: true }))
    .finally(() => { connectionCheck = null; });
  return connectionCheck;
}

async function sendMessage() {
  const content = input.value.trim();
  if (!content || busy || !connected || composing) return;
  busy = true;
  updateControls();
  let page = null;
  if (includePage) {
    try {
      if (windowId === undefined) windowId = (await chrome.windows.getCurrent()).id;
      // Re-read at send time: an earlier tab query may have finished after a switch.
      page = await readPanelPage(chrome.tabs, windowId);
    } catch {
      busy = false;
      addMessage('system', 'Couldn’t identify the current page. Try again, or turn page context off.', 'error');
      updateControls();
      return;
    }
  }
  requestId = crypto.randomUUID();
  const request = messageWithPageContext(content, page, history);
  history.push({ role: 'user', content });
  addMessage('user', content);
  input.value = '';
  resizeInput();
  showLoading();
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SEND_TO_SERVER',
      data: { type: 'chat', message: request, tabId: page?.tabId ?? null, panelId, requestId },
    });
    if (response.pending) return;
    receiveResponse(response.error ? { error: response.error } : { content: response.content || 'No response was returned. Please try again.' });
  } catch (error) {
    receiveResponse({ error: error.message });
  }
}

$('composer').addEventListener('submit', (event) => { event.preventDefault(); sendMessage(); });
input.addEventListener('input', resizeInput);
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; updateControls(); });
input.addEventListener('keydown', (event) => {
  if (!composing && shouldSubmitOnEnter(event)) { event.preventDefault(); sendMessage(); }
});
pageButton.addEventListener('click', () => { includePage = !includePage; renderPageContext(); });
newChatButton.addEventListener('click', () => {
  if (busy) return;
  messages.replaceChildren();
  history.length = 0;
  updateConnection(connectionStatus);
  input.value = '';
  resizeInput();
  input.focus();
});
for (const button of document.querySelectorAll('.suggestion')) {
  button.addEventListener('click', () => {
    if (button.hasAttribute('data-needs-page')) { includePage = true; renderPageContext(); }
    input.value = button.dataset.prompt;
    resizeInput();
    input.focus();
  });
}
$('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('setupSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('setupRetry').addEventListener('click', async () => {
  $('connectionLabel').textContent = 'Connecting…';
  try { await chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' }); } catch { /* status below */ }
  await checkConnection();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SERVER_RESPONSE' && message.panelId === panelId && message.requestId === requestId && busy) {
    receiveResponse(message.data || { error: 'No response was returned.' });
  } else if (message.type === 'CONNECTION_STATUS') {
    checkConnection();
  }
});
chrome.tabs.onActivated.addListener((info) => { if (info.windowId === windowId) refreshPage(); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.windowId === windowId && tab.active && (change.url || change.title || change.status === 'complete')) refreshPage();
});
chrome.tabs.onRemoved.addListener((tabId) => { if (currentPage?.tabId === tabId) refreshPage(); });

refreshPage();
checkConnection();
setInterval(checkConnection, 5000);
