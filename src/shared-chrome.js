/**
 * CDP for Foxl's internal browser, on the SAME tabs this extension controls.
 * Only tabs registered with Foxl (or created here) are exposed. Chrome itself is
 * never launched, closed, or given a copied profile. Disconnect releases debugger
 * attachments; it does not close any of the person's tabs.
 *
 * A desktop supplies a one-use loopback capability through its browser-command
 * channel. This module does not listen on a port or accept a page's messages.
 *
 * Wire references:
 * developer.chrome.com/docs/extensions/reference/api/debugger
 * chromedevtools.github.io/devtools-protocol/tot/Target/
 * chromedevtools.github.io/devtools-protocol/tot/Page/#event-screencastFrame
 */
import { readAllowedPage } from './page-capture.js';

export function createSharedChrome({ knownTabs, registerTab }) {
  const owned = new Set();
  const clients = new Map();
  const attached = new Map();
  const inputs = new Map();
  const targetIds = new Map();
  let socket = null;
  let generation = 0;
  const allowed = id => owned.has(id) || knownTabs().includes(id);
  const emit = (client, message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ client, message }));
  };
  const state = id => {
    if (!clients.has(id)) clients.set(id, { discover: false, sessions: new Map(), attaching: new Map() });
    return clients.get(id);
  };
  const targetInfo = target => ({
    targetId: target.id, type: 'page', title: target.title || '', url: target.url || 'about:blank',
    attached: attached.has(target.tabId), canAccessOpener: false, browserContextId: 'foxl-shared-chrome',
    ...(target.openerId ? { openerId: target.openerId } : {}),
  });
  async function targets() {
    const [all, tabs] = await Promise.all([chrome.debugger.getTargets(), chrome.tabs.query({})]);
    for (const t of all) if (t.tabId) targetIds.set(t.tabId, t.id);
    return all.filter(t => t.type === 'page' && allowed(t.tabId)).map(t => ({
      ...t, openerId: targetIds.get(tabs.find(tab => tab.id === t.tabId)?.openerTabId),
    }));
  }
  async function target(id) {
    const found = (await targets()).find(t => t.id === id);
    if (!found) throw new Error('This tab is not shared with Foxl or has closed.');
    return found;
  }
  async function access(tabId) {
    if (!allowed(tabId)) throw new Error('This tab is not shared with Foxl.');
    const tab = await chrome.tabs.get(tabId);
    // A newly created blank tab has no host grant to test.
    if (owned.has(tabId) && (tab.url === 'about:blank' || !tab.url)) return;
    await readAllowedPage(tabId);
  }
  async function retain(tabId) {
    let rec = attached.get(tabId);
    if (!rec) {
      rec = { count: 0, ready: chrome.debugger.attach({ tabId }, '1.3') };
      attached.set(tabId, rec);
      rec.ready.catch(() => { if (attached.get(tabId) === rec) attached.delete(tabId); });
    }
    await rec.ready;
    rec.count++;
  }
  async function release(tabId) {
    const rec = attached.get(tabId);
    if (!rec || --rec.count > 0) return;
    attached.delete(tabId);
    await rec.ready.catch(() => {});
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  async function disconnect(id) {
    const rec = clients.get(id);
    if (!rec) return;
    clients.delete(id);
    await Promise.all([...rec.sessions.values()].filter(s => !s.child).map(s => release(s.tabId)));
  }
  async function announce(tabId) {
    const found = (await targets()).find(t => t.tabId === tabId);
    if (!found) return;
    for (const [id, rec] of clients) if (rec.discover) emit(id, { method: 'Target.targetCreated', params: { targetInfo: targetInfo(found) } });
  }
  async function dispatch(id, message) {
    const rec = state(id);
    const { method, sessionId } = message;
    const params = message.params || {};
    if (sessionId) {
      const bound = rec.sessions.get(sessionId);
      if (!bound) throw new Error('The shared Chrome tab detached. Read the page again.');
      // No profile export: authentication remains in the actual Chrome profile.
      if (/^(Storage\.|Network\.(?:getAllCookies|setCookie|deleteCookies|clearBrowser))/.test(method)) {
        throw new Error('Shared Chrome does not export or replace the browser profile.');
      }
      if (method.startsWith('Target.') && method !== 'Target.setAutoAttach') {
        throw new Error('Other tabs must be addressed through the shared browser target list.');
      }
      const send = async () => {
        await access(bound.tabId);
        if (clients.get(id) !== rec) throw new Error('The shared Chrome client disconnected.');
        if (method === 'Network.getCookies') {
          // Read cookies for this tab only, never for another domain supplied by a client.
          const tab = await chrome.tabs.get(bound.tabId);
          return chrome.debugger.sendCommand({ tabId: bound.tabId }, method, { urls: [tab.url] });
        }
        if (method === 'Page.navigate' && !/^https?:\/\/|^about:blank$/.test(params.url || '')) {
          throw new Error('Shared Chrome navigation requires an HTTP(S) page.');
        }
        return chrome.debugger.sendCommand(
          { tabId: bound.tabId, ...(bound.child ? { sessionId: bound.child } : {}) }, method, params,
        );
      };
      // Access checks are asynchronous. Preserve pressed/released/key ordering
      // even if a later scripting call finishes before an earlier one.
      if (!method.startsWith('Input.')) return send();
      const queued = (inputs.get(bound.tabId) || Promise.resolve()).catch(() => {}).then(send);
      inputs.set(bound.tabId, queued);
      try { return await queued; }
      finally { if (inputs.get(bound.tabId) === queued) inputs.delete(bound.tabId); }
    }
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: navigator.userAgent.match(/(?:Chrome|Chromium)\/\S+/)?.[0] || 'Chrome', revision: '', userAgent: navigator.userAgent, jsVersion: '' };
      case 'Target.getBrowserContexts': return { browserContextIds: [] };
      case 'Target.setDiscoverTargets':
        rec.discover = params.discover === true;
        if (rec.discover) for (const t of await targets()) emit(id, { method: 'Target.targetCreated', params: { targetInfo: targetInfo(t) } });
        return {};
      case 'Target.getTargets': return { targetInfos: (await targets()).map(targetInfo) };
      case 'Target.getTargetInfo': return { targetInfo: targetInfo(await target(params.targetId)) };
      case 'Target.createTarget': {
        if (!/^https?:\/\/|^about:blank$/.test(params.url || '')) throw new Error('Shared Chrome navigation requires an HTTP(S) page.');
        if (params.browserContextId && params.browserContextId !== 'foxl-shared-chrome') throw new Error('A separate Chrome profile cannot share this session.');
        let tab;
        if (params.newWindow) {
          const win = await chrome.windows.create({ url: params.url, focused: params.background !== true });
          [tab] = win.tabs || [];
        } else tab = await chrome.tabs.create({ url: params.url, active: params.background !== true });
        if (!tab?.id) throw new Error('Chrome did not create a tab.');
        owned.add(tab.id);
        await registerTab(tab.id);
        const found = (await targets()).find(t => t.tabId === tab.id);
        if (!found) throw new Error('Chrome did not expose the new tab.');
        await announce(tab.id);
        return { targetId: found.id };
      }
      case 'Target.attachToTarget': {
        const found = await target(params.targetId);
        const key = `foxl-tab-${found.tabId}`;
        if (!rec.sessions.has(key)) {
          // Concurrent duplicate attaches must hold one reference, so disconnect
          // can release it completely instead of leaving Chrome debugging the tab.
          if (!rec.attaching.has(key)) rec.attaching.set(key, (async () => {
            await access(found.tabId);
            await retain(found.tabId);
            if (clients.get(id) !== rec) { await release(found.tabId); throw new Error('The shared Chrome client disconnected.'); }
            rec.sessions.set(key, { tabId: found.tabId, targetId: found.id });
          })());
          try { await rec.attaching.get(key); }
          finally { rec.attaching.delete(key); }
        }
        return { sessionId: key };
      }
      case 'Target.detachFromTarget': {
        const bound = rec.sessions.get(params.sessionId);
        if (bound) {
          rec.sessions.delete(params.sessionId);
          if (!bound.child) await release(bound.tabId);
        }
        return {};
      }
      case 'Target.activateTarget': {
        const found = await target(params.targetId);
        await chrome.tabs.update(found.tabId, { active: true });
        return {};
      }
      case 'Target.closeTarget': {
        const found = await target(params.targetId);
        // A transport may close only a tab it created, never an existing extension/user tab.
        if (!owned.has(found.tabId)) throw new Error('Close this existing tab with the extension or Chrome.');
        await chrome.tabs.remove(found.tabId);
        return { success: true };
      }
      case 'Browser.getWindowForTarget': {
        const found = await target(params.targetId);
        const tab = await chrome.tabs.get(found.tabId);
        const win = await chrome.windows.get(tab.windowId);
        return { windowId: win.id, bounds: { left: win.left, top: win.top, width: win.width, height: win.height, windowState: win.state } };
      }
      // The extension API exposes per-tab debugger sessions, not a browser-wide debugger.
      // Reject unsupported browser operations explicitly instead of acknowledging a no-op.
      default: throw new Error(`Shared Chrome does not support ${method} at browser scope.`);
    }
  }
  chrome.debugger.onEvent.addListener(async (source, method, params = {}) => {
    if (!attached.has(source.tabId)) return;
    if (method === 'Page.screencastFrame') {
      // A live stream must stop exposing pixels when the person withholds site access.
      try { await access(source.tabId); } catch { return; }
    }
    for (const [id, rec] of clients) {
      const root = `foxl-tab-${source.tabId}`;
      if (!rec.sessions.has(root)) continue;
      if (method === 'Target.attachedToTarget' && params.sessionId) {
        rec.sessions.set(params.sessionId, { tabId: source.tabId, child: params.sessionId });
      }
      emit(id, { method, params, sessionId: source.sessionId || root });
      if (method === 'Target.detachedFromTarget') rec.sessions.delete(params.sessionId);
    }
  });
  chrome.debugger.onDetach.addListener(source => {
    attached.delete(source.tabId);
    for (const [id, rec] of clients) {
      for (const [key, bound] of rec.sessions) if (bound.tabId === source.tabId) {
        rec.sessions.delete(key);
        emit(id, { method: 'Target.detachedFromTarget', params: { sessionId: key, targetId: bound.targetId } });
      }
    }
  });
  chrome.tabs.onCreated.addListener(tab => {
    if (allowed(tab.openerTabId)) { owned.add(tab.id); void registerTab(tab.id).then(() => announce(tab.id)); }
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!allowed(tabId) || (!change.url && !change.title)) return;
    void targets().then(list => {
      const found = list.find(t => t.tabId === tabId);
      if (found) for (const [id, rec] of clients) if (rec.discover) emit(id, { method: 'Target.targetInfoChanged', params: { targetInfo: targetInfo(found) } });
    });
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    owned.delete(tabId);
    const targetId = targetIds.get(tabId);
    targetIds.delete(tabId);
    for (const [id, rec] of clients) {
      if (rec.discover && targetId) emit(id, { method: 'Target.targetDestroyed', params: { targetId } });
    }
  });
  return {
    async connect(url) {
      if (!/^ws:\/\/127\.0\.0\.1:\d+\/extension\/[a-f0-9]{64}$/.test(url)) throw new Error('The shared browser transport must be a private loopback endpoint.');
      const epoch = ++generation;
      const old = socket;
      socket = null;
      old?.close();
      await Promise.all([...clients.keys()].map(disconnect));
      const ws = new WebSocket(url);
      socket = ws;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('The shared browser transport did not open.')); }, 10_000);
        ws.onopen = () => { clearTimeout(timer); resolve(); };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('The shared browser transport could not connect.')); };
      });
      ws.onmessage = async event => {
        if (epoch !== generation) return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { ws.close(1003); return; }
        if (typeof frame.client !== 'string' || !/^[a-f0-9]{32}$/.test(frame.client)) return;
        if (frame.disconnect) { await disconnect(frame.client); return; }
        const m = frame.message;
        if (!m || !Number.isSafeInteger(m.id) || typeof m.method !== 'string') return;
        try {
          const result = await dispatch(frame.client, m);
          emit(frame.client, { id: m.id, result: result || {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
        } catch (error) {
          emit(frame.client, { id: m.id, error: { code: -32000, message: error.message }, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
        }
      };
      ws.onclose = () => {
        if (epoch !== generation) return;
        socket = null;
        void Promise.all([...clients.keys()].map(disconnect));
      };
      return { success: true };
    },
  };
}
