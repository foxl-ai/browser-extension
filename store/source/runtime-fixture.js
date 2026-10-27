// Capture-only transport. The shipped UI renders every message and state.
// This file is served only by scripts/store-preview.mjs, outside the extension.
(() => {
  const fixture = window.captureFixture;
  const listeners = [];
  const connected = fixture.connected !== false;
  const reply = {
    connected,
    everConnected: connected,
    model: '',
    desktopVersion: '0.9.4',
    extensionVersion: '0.9.0',
    desktopTooOld: false,
  };

  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '0.9.0' }),
      openOptionsPage: () => {},
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async (message) => {
        if (message.type === 'GET_SERVER_STATUS') return reply;
        if (message.type === 'GET_TAB_CONTEXTS') {
          return { contexts: fixture.tabs ?? [], focusedTabId: fixture.tabs?.[0]?.tabId };
        }
        return { success: true };
      },
    },
    storage: { local: { get: (_keys, callback) => callback({}) } },
    commands: { getAll: (callback) => callback([{ name: '_execute_action', shortcut: 'Command+Shift+F' }]) },
    tabs: { create: () => {} },
  };

  // All production scripts have loaded when this runs. addMessage is the
  // function declared by the shipping sidepanel.js, with its original CSS.
  window.addEventListener('load', () => {
    for (const message of typeof addMessage === 'function' ? fixture.messages ?? [] : []) {
      if (message.role === 'user') {
        addMessage('user', message.text);
      } else {
        const data = message.role === 'tool'
          ? { type: 'tool', name: message.text }
          : { content: message.text };
        for (const listener of listeners) {
          listener({ type: 'SERVER_RESPONSE', data }, {}, () => {});
        }
      }
    }
    if (fixture.active) {
      for (const listener of listeners) {
        listener({ type: 'SHOW_AGENT_INDICATORS' }, {}, () => {});
      }
    }
    document.documentElement.dataset.captureReady = 'true';
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'foxl-capture-ready' }, window.location.origin);
    }
  });
})();
