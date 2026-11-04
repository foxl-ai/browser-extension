/**
 * A pop-up Chrome blocked, said (#6245).
 *
 * A `window.open` that Chrome's pop-up blocker refuses returns `null` in the page and leaves no
 * other trace an extension can read: no tab, no event, no API. In the case behind #6245 a portal's
 * account button opened a broker in a pop-up Chrome blocked, and the agent, seeing only the
 * portal, asked the person for a password they did not need. So this script runs in the page's
 * OWN world (manifest `"world": "MAIN"`, the only place `window.open` can be watched) and, when a
 * call returns `null`, tells the extension's content script (accessibility-tree.js, which lists
 * the last ten with the page's tree as `blockedPopups`).
 *
 * It changes nothing a page can rely on: the call, its arguments and its return value are the
 * page's own. A call that asks for `noopener` or `noreferrer` returns `null` even when the window
 * opened, so it is never reported. The page can dispatch the same event itself; the content
 * script treats an entry as what the page reports, not as a fact or a place to go.
 */
(() => {
  if (window.__foxlPopupWatch) return;
  Object.defineProperty(window, '__foxlPopupWatch', { value: true });
  const nativeOpen = window.open;
  if (typeof nativeOpen !== 'function') return;
  window.open = function open(...args) {
    const opened = Reflect.apply(nativeOpen, this, args);
    if (opened === null && !/\bno(opener|referrer)\b/i.test(String(args[2] ?? ''))) {
      let url = '';
      try {
        url = args[0] == null || args[0] === '' ? '' : new URL(String(args[0]), location.href).href;
      } catch {
        url = String(args[0]);
      }
      document.dispatchEvent(new CustomEvent('foxl-window-open-blocked', {
        detail: JSON.stringify({ url: url.slice(0, 2048), at: Date.now() }),
      }));
    }
    return opened;
  };
})();
