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
      const row = document.createElement('div');
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
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) {
    serverUrlInput.value = result.serverUrl;
  }
  // If no saved URL, leave empty (auto-detect mode)
  checkConnection();
});

// Check connection status
async function checkConnection() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' });
    updateStatus(response.connected, response.serverUrl);
  } catch (err) {
    updateStatus(false);
  }
}

function updateStatus(connected, serverUrl) {
  statusDot.classList.toggle('connected', connected);
  if (connected && serverUrl) {
    statusText.textContent = `Connected to ${serverUrl}`;
  } else if (connected) {
    statusText.textContent = 'Connected to Foxl server';
  } else {
    statusText.textContent = 'Not connected';
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
  const serverUrl = serverUrlInput.value.trim();

  try {
    if (serverUrl) {
      await chrome.storage.local.set({ serverUrl });
      showMessage('Settings saved. Using: ' + serverUrl, 'success');
    } else {
      await chrome.storage.local.remove('serverUrl');
      showMessage('Settings saved. Using auto-discovery (port 13847 / 3847)', 'success');
    }
    
    // Reconnect with new URL
    await chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' });
    setTimeout(checkConnection, 1000);
  } catch (err) {
    showMessage('Failed to save settings: ' + err.message, 'error');
  }
});

// Test connection
testButton.addEventListener('click', async () => {
  const serverUrl = serverUrlInput.value.trim();
  
  // If no URL, test auto-discovery ports
  if (!serverUrl) {
    const ports = [13847, 3847];
    for (const port of ports) {
      const url = `http://localhost:${port}`;
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok) {
          showMessage(`Found server at ${url}`, 'success');
          updateStatus(true, url);
          // Trigger WebSocket connection in service worker
          await chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' });
          return;
        }
      } catch (_) {}
    }
    showMessage('No server found on port 13847 or 3847', 'error');
    updateStatus(false);
    return;
  }

  try {
    const response = await fetch(`${serverUrl}/api/health`);
    if (response.ok) {
      showMessage('Connection successful!', 'success');
      updateStatus(true, serverUrl);
      // Trigger WebSocket connection in service worker
      await chrome.runtime.sendMessage({ type: 'CONNECT_TO_SERVER' });
    } else {
      showMessage('Server responded with error: ' + response.status, 'error');
      updateStatus(false);
    }
  } catch (err) {
    showMessage('Failed to connect: ' + err.message, 'error');
    updateStatus(false);
  }
});

// Check connection periodically
setInterval(checkConnection, 10000);
