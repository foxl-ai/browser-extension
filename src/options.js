/**
 * Foxl Options Page Script
 */

const serverUrlInput = document.getElementById('serverUrl');
const saveButton = document.getElementById('saveButton');
const testButton = document.getElementById('testButton');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const messageEl = document.getElementById('message');
const versionEl = document.getElementById('version');

// Set version
versionEl.textContent = chrome.runtime.getManifest().version;

/*
 * DOWNLOAD RECEIPTS (#6245). `downloads` is an optional permission (a required one turns the
 * extension off at update until the person accepts it), so it is asked for here, from the person's
 * click: chrome.permissions.request needs a user gesture, so it is called in the handler itself,
 * before any await. The service worker reads Chrome's download list when asked, so a grant takes
 * effect at once; until then Foxl is told receipts are not allowed, and this row shows that it asked.
 */
const DOWNLOADS = { permissions: ['downloads'] };
const downloadsDot = document.getElementById('downloadsDot');
const downloadsText = document.getElementById('downloadsText');
const downloadsButton = document.getElementById('downloadsButton');
let downloadsGranted = false;

async function showDownloads() {
  downloadsGranted = await chrome.permissions.contains(DOWNLOADS).catch(() => false);
  const { downloadReceiptsAsked } = await chrome.storage.local.get('downloadReceiptsAsked').catch(() => ({}));
  downloadsDot.classList.toggle('connected', downloadsGranted);
  downloadsText.textContent = downloadsGranted ? 'On' : downloadReceiptsAsked ? 'Off. Foxl asked to confirm a download.' : 'Off';
  downloadsButton.textContent = downloadsGranted ? 'Turn off' : 'Allow';
}

downloadsButton.addEventListener('click', () => {
  const change = downloadsGranted ? chrome.permissions.remove(DOWNLOADS) : chrome.permissions.request(DOWNLOADS);
  change.catch(() => false).finally(showDownloads);
});
chrome.permissions.onAdded.addListener(showDownloads);
chrome.permissions.onRemoved.addListener(showDownloads);
showDownloads();

// Populate shortcut list (reads the actual binding Chrome assigned, which may
// differ from the manifest `suggested_key` if there was a conflict at install time)
const COMMAND_LABELS = {
  'toggle-side-panel': 'Toggle Side Panel',
  '_execute_action': 'Open Foxl',
};
const shortcutsList = document.getElementById('shortcutsList');

function openShortcutsTab() {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

if (shortcutsList && chrome.commands?.getAll) {
  chrome.commands.getAll((commands) => {
    shortcutsList.innerHTML = '';
    for (const cmd of commands) {
      const label = COMMAND_LABELS[cmd.name] || cmd.description || cmd.name;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'shortcut shortcut-clickable';
      row.title = 'Click to change in Chrome shortcuts settings';
      row.addEventListener('click', openShortcutsTab);

      const name = document.createElement('span');
      name.textContent = label;
      row.appendChild(name);

      const keys = document.createElement('div');
      keys.className = 'shortcut-keys';
      if (cmd.shortcut) {
        for (const part of cmd.shortcut.split(/\+/)) {
          const key = document.createElement('span');
          key.className = 'key';
          key.textContent = part.trim();
          keys.appendChild(key);
        }
      } else {
        const unset = document.createElement('span');
        unset.className = 'key key-unset';
        unset.textContent = 'Click to set';
        keys.appendChild(unset);
      }
      row.appendChild(keys);
      shortcutsList.appendChild(row);
    }
  });
}

const openShortcutsBtn = document.getElementById('openShortcutsBtn');
if (openShortcutsBtn) {
  openShortcutsBtn.addEventListener('click', openShortcutsTab);
}

// Load saved settings
chrome.storage.local.get(['serverUrl', 'appearance'], (result) => {
  if (result.serverUrl) {
    serverUrlInput.value = result.serverUrl;
    document.getElementById('advancedConnection').open = true;
  }
  document.getElementById('appearance').value = result.appearance || 'system';
  // If no saved URL, leave empty (auto-detect mode)
  checkConnection();
});

// Check connection status
async function checkConnection() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' });
    updateStatus(response.connected, response.serverUrl);
    return Boolean(response.connected);
  } catch (err) {
    updateStatus(false);
    return false;
  }
}

function updateStatus(connected, serverUrl) {
  statusDot.classList.toggle('connected', connected);
  if (connected && serverUrl) {
    statusText.textContent = 'Connected to Foxl Desktop';
    statusText.title = serverUrl;
  } else if (connected) {
    statusText.textContent = 'Connected to Foxl Desktop';
  } else {
    statusText.textContent = 'Open Foxl Desktop to connect';
    statusText.removeAttribute('title');
  }
}

function showMessage(text, type) {
  messageEl.className = `message ${type}`;
  messageEl.textContent = text;
  messageEl.style.display = 'block';
  
  setTimeout(() => {
    messageEl.style.display = 'none';
  }, 5000);
}

// Save settings
saveButton.addEventListener('click', async () => {
  serverUrlInput.setCustomValidity('');
  if (serverUrlInput.value.trim() && !/^https?:\/\//i.test(serverUrlInput.value.trim())) {
    serverUrlInput.setCustomValidity('Use an http:// or https:// server URL.');
  }
  if (!serverUrlInput.reportValidity()) return;
  const serverUrl = serverUrlInput.value.trim();
  saveButton.disabled = true;

  try {
    if (serverUrl) {
      await chrome.storage.local.set({ serverUrl });
      showMessage('Connection saved. Reconnecting…', 'success');
    } else {
      await chrome.storage.local.remove('serverUrl');
      showMessage('Connection saved. Finding Foxl Desktop…', 'success');
    }
    
    // Reconnect with new URL
    await chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' });
    setTimeout(checkConnection, 1000);
  } catch (err) {
    showMessage('Failed to save settings: ' + err.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
});
serverUrlInput.addEventListener('input', () => serverUrlInput.setCustomValidity(''));

document.getElementById('appearance').addEventListener('change', async (event) => {
  try {
    await chrome.storage.local.set({ appearance: event.target.value });
  } catch (error) {
    showMessage('Could not save appearance: ' + error.message, 'error');
  }
});

// Test connection
testButton.addEventListener('click', async () => {
  testButton.disabled = true;
  testButton.textContent = 'Checking…';
  try {
    await chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' });
    const connected = await checkConnection();
    showMessage(connected ? 'Connected to Foxl Desktop.' : 'Open Foxl Desktop and try again.', connected ? 'success' : 'error');
  } catch (err) {
    showMessage('Failed to connect: ' + err.message, 'error');
    updateStatus(false);
  } finally {
    testButton.disabled = false;
    testButton.textContent = 'Check connection';
  }
});

// Check connection periodically
setInterval(checkConnection, 10000);
