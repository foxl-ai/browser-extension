/**
 * The page's own requests, counted only while one of Foxl's steps is sending a form (foxl-ai/pilot #6394).
 *
 * After a click that sends a form, the step's answer can be a navigation (the tab loads a new page) or a
 * `fetch` the page sends, whose answer it then draws. The content script that waits for that answer
 * (step-watch.js) runs in the extension's isolated world and cannot see the page's `fetch` or
 * `XMLHttpRequest`: only a script in the page's OWN world (manifest `"world": "MAIN"`) can. So this one wraps
 * them, but ONLY from the step's own submit until the step has been read: step-watch.js asks with a
 * `foxl-step-requests` event (`watch` / `unwatch`), and the page's own functions are put back after (only
 * if they are still ours: a page that replaced them itself keeps its own). While wrapped, it tells
 * step-watch.js when a request starts and ends, with a `foxl-request` event on the document ('+<id>' and
 * '-<id>'). Each call, its arguments, its return value and its errors are the page's own.
 *
 * Nothing is hidden from the page: the events are plain DOM events it can see. A page that dispatches the
 * same events itself can at worst make a step wait longer, up to step-watch.js's bound, never shorter.
 */
(() => {
  if (window.__foxlRequestWatch) return;
  Object.defineProperty(window, '__foxlRequestWatch', { value: true });
  let next = 0;
  let wrap = null;
  let formOrigin = '';
  // '+<id>!' marks a request that SENDS: it carries a body (a POST, not a poll) and goes to the page's own origin or
  // the form's. Only such a request counts a step's submit as sent: an analytics hit to another host does not.
  const tell = (sign, id, sends = false) => {
    try { document.dispatchEvent(new CustomEvent('foxl-request', { detail: sign + id + (sends ? '!' : '') })); } catch { /* no document yet */ }
  };
  const ownOrigin = (input) => {
    try {
      const o = new URL(String(input && typeof input === 'object' && typeof input.url === 'string' ? input.url : input), location.href).origin;
      return o === location.origin || (!!formOrigin && o === formOrigin);
    } catch { return false; }
  };
  const bodied = (input, init) => {
    try {
      if (init && init.body != null) return true;
      const m = String((init && init.method) || (input && typeof input === 'object' && typeof input.method === 'string' ? input.method : 'GET')).toUpperCase();
      return m !== 'GET' && m !== 'HEAD';
    } catch { return false; }
  };
  const watch = () => {
    if (wrap) return;
    const nativeFetch = window.fetch;
    const nativeSend = window.XMLHttpRequest && window.XMLHttpRequest.prototype.send;
    const wrappedFetch = typeof nativeFetch === 'function' ? function fetch(...args) {
      const id = ++next;
      tell('+', id, bodied(args[0], args[1]) && ownOrigin(args[0]));
      let pending;
      try {
        pending = Reflect.apply(nativeFetch, this, args);
      } catch (err) {
        tell('-', id);
        throw err;
      }
      Promise.resolve(pending).then(() => tell('-', id), () => tell('-', id));
      return pending;
    } : null;
    const wrappedSend = typeof nativeSend === 'function' ? function send(...args) {
      const id = ++next;
      tell('+', id, args[0] != null);
      this.addEventListener('loadend', () => tell('-', id), { once: true });
      try {
        return Reflect.apply(nativeSend, this, args);
      } catch (err) {
        tell('-', id);
        throw err;
      }
    } : null;
    try { if (wrappedFetch) window.fetch = wrappedFetch; } catch { /* not writable here */ }
    try { if (wrappedSend) window.XMLHttpRequest.prototype.send = wrappedSend; } catch { /* not writable here */ }
    wrap = { nativeFetch, nativeSend, wrappedFetch, wrappedSend };
  };
  const unwatch = () => {
    const r = wrap;
    if (!r) return;
    wrap = null;
    try { if (r.wrappedFetch && window.fetch === r.wrappedFetch) window.fetch = r.nativeFetch; } catch { /* leave it */ }
    try { if (r.wrappedSend && window.XMLHttpRequest.prototype.send === r.wrappedSend) window.XMLHttpRequest.prototype.send = r.nativeSend; } catch { /* leave it */ }
  };
  // 'watch <the form's origin>' from a step's own submit; 'unwatch' when that step is read.
  document.addEventListener('foxl-step-requests', (e) => {
    const detail = String(e.detail || '');
    if (detail.startsWith('watch')) { formOrigin = detail.slice(6); watch(); } else if (detail === 'unwatch') { formOrigin = ''; unwatch(); }
  });
})();
