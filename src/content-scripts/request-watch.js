/**
 * The page's own requests, counted (foxl-ai/pilot #6394).
 *
 * After a click that sends a form, the step's answer can be a navigation (the tab loads a new page) or a
 * `fetch` the page sends, whose answer it then draws. The content script that waits for that answer
 * (step-watch.js) runs in the extension's isolated world and cannot see the page's `fetch` or
 * `XMLHttpRequest`: only a script in the page's OWN world (manifest `"world": "MAIN"`) can. So this one
 * tells it when a request starts and ends, with a `foxl-request` event on the document ('+<id>' and '-<id>').
 *
 * It changes nothing a page can rely on: each call, its arguments, its return value and its errors are
 * the page's own. The page can dispatch the same event itself; at worst that makes a step wait longer,
 * up to step-watch.js's bound, never shorter.
 */
(() => {
  if (window.__foxlRequestWatch) return;
  Object.defineProperty(window, '__foxlRequestWatch', { value: true });
  let next = 0;
  const tell = (sign, id) => {
    try { document.dispatchEvent(new CustomEvent('foxl-request', { detail: sign + id })); } catch { /* no document yet */ }
  };
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function fetch(...args) {
      const id = ++next;
      tell('+', id);
      let pending;
      try {
        pending = Reflect.apply(nativeFetch, this, args);
      } catch (err) {
        tell('-', id);
        throw err;
      }
      Promise.resolve(pending).then(() => tell('-', id), () => tell('-', id));
      return pending;
    };
  }
  const xhr = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhr && typeof xhr.send === 'function') {
    const nativeSend = xhr.send;
    xhr.send = function send(...args) {
      const id = ++next;
      tell('+', id);
      this.addEventListener('loadend', () => tell('-', id), { once: true });
      try {
        return Reflect.apply(nativeSend, this, args);
      } catch (err) {
        tell('-', id);
        throw err;
      }
    };
  }
})();
