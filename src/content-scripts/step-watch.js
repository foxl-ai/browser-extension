/**
 * What a click or a key press did, before the next command reads the page (foxl-ai/pilot #6394).
 *
 * A bill dispute was filed twice through Foxl's own browser: a read sent with Submit ran before the
 * form's navigation started, showed the form again, and the person's "yes, go ahead" filed it again. This
 * extension's `click` returns as soon as the content script has clicked too, so the desktop asks for the
 * same watch here, announced as the `step-watch` capability. The service worker arms the page before a
 * click, a `click_at`, a key press and a `type` that presses Enter (`__foxlStepArm`), and after the step
 * asks what happened (`__foxlStepSettle`), which waits ONLY when something did:
 *   - a form was sent (a capture-phase `submit` listener),
 *   - a navigation started (the Navigation API's `navigate` event; `beforeunload` where there is none),
 *   - a request the page started after the step is still running (request-watch.js, in the page's world),
 *   - or the page changed (a MutationObserver),
 * until the navigation commits (this script's page is then gone, and the service worker reads the new one
 * with `__foxlStepPage`), or the step's requests end and the page stops changing, at most STEP_SETTLE_MS.
 * A click that changed nothing answers at once and its result is unchanged.
 *
 * THE SAME FORM SENT TWICE BY MISTAKE: `hold` lists the forms the desktop's chat already sent (their
 * digests, computed by the same algorithm as the desktop's own browser, foxl-ai/pilot
 * server/tools/browser-step-watch.ts `DESCRIBE_FORM_SOURCE`, so one chat that uses both browsers matches).
 * A submit of one of them during the step is stopped before the page's own handlers run and reported as
 * `blocked`; the desktop then says what was sent before. A form's identity is its action and the person's
 * choices in it (boxes ticked, options chosen, amounts, dates), or every answer when the form is only
 * words; hidden fields and forms with a password field are never part of it. The hold is the step's own
 * (STEP_HOLD_WINDOW_MS) and is cleared when the step is read, so the person's own submit is never stopped.
 *
 * The form's identity survives the navigation it starts in `sessionStorage` (same-origin answers).
 */
(() => {
  if (window.__foxlStepWatch) return;
  Object.defineProperty(window, '__foxlStepWatch', { value: true });

  const STEP_SETTLE_MS = 8000;
  const STEP_DEFERRED_MS = 2000;
  const STEP_QUIET_MS = 300;
  const STEP_QUIET_MAX_MS = 1500;
  const STEP_HOLD_WINDOW_MS = 10000;
  const SENT_KEY = '__foxlStepSent';

  // The page's description of a submitted POST form, or null (a GET form, a sign-in, nothing filled in).
  // KEEP IN STEP with foxl-ai/pilot server/tools/browser-step-watch.ts DESCRIBE_FORM_SOURCE: the digest must match.
  const describe = (form, submitter) => {
    const method = String((submitter && submitter.getAttribute('formmethod')) || form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'post') return null;
    if (form.querySelector('input[type=password]')) return null;
    let action;
    try { action = new URL((submitter && submitter.getAttribute('formaction')) || form.getAttribute('action') || location.href, location.href); } catch (e) { return null; }
    const fields = [];
    const STRUCTURED_TYPES = ['checkbox', 'radio', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'email', 'tel', 'range', 'color'];
    for (const el of Array.from(form.elements)) {
      if (!el.name || el.disabled) continue;
      const tag = el.tagName; const type = String(el.type || '').toLowerCase();
      if (tag === 'INPUT') {
        if (['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
        if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
        fields.push([el.name, el.value, STRUCTURED_TYPES.includes(type)]);
      } else if (tag === 'TEXTAREA') fields.push([el.name, el.value, false]);
      else if (tag === 'SELECT') for (const o of Array.from(el.selectedOptions)) fields.push([el.name, o.value, true]);
    }
    const choiceLike = (v) => /^[\s$€£¥₩+-]*\d[\d.,:\/\s-]*$/.test(v);
    const norm = fields.map(([n, v, s]) => [String(n), String(v == null ? '' : v).replace(/\s+/g, ' ').trim(), s]).filter(([, v]) => v);
    if (!norm.length) return null;
    const choices = norm.filter(([, v, s]) => s || choiceLike(v)).map(([n, v]) => [n, v]);
    const identity = (choices.length ? choices : norm.map(([n, v]) => [n, v])).sort((a, b) => (a[0] + '=' + a[1] < b[0] + '=' + b[1] ? -1 : 1));
    const key = action.host + action.pathname + '|' + JSON.stringify(identity);
    const fnv = (str, seed) => { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); };
    const label = String((submitter && (submitter.innerText || submitter.value || submitter.getAttribute('aria-label'))) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const summary = identity.slice(0, 8).map(([n, v]) => n + ': ' + v.replace(/\d{12,}/g, '...').slice(0, 60));
    return { digest: fnv(key, 2166136261) + fnv(key, 3735928559), host: action.host, action: action.pathname, label, summary };
  };

  const s = { armedAt: 0, navigated: false, mutatedAt: 0, submitted: null, submitSeen: false, blocked: null, hold: new Set(), pending: new Map() };
  // The page's requests (request-watch.js): when each still-running one started, by its id.
  document.addEventListener('foxl-request', (e) => {
    const m = /^([+-])(\d+)$/.exec(String(e.detail));
    if (!m) return;
    if (m[1] === '+') { if (s.pending.size < 500) s.pending.set(m[2], Date.now()); } else s.pending.delete(m[2]);
  });
  /*
   * A page load to come. The Navigation API's `navigate` fires for history.pushState / replaceState too
   * (measured, Chromium 156: sameDocument true, then `navigatesuccess` at once) and for a link the page
   * intercepts (sameDocument false, then `navigatesuccess` when its handler ends). Neither unloads the page,
   * so neither is a page load: what a single-page app draws is the page's own change, which the observer
   * below sees. Counted as one, its every view change waited the full STEP_SETTLE_MS and read
   * `still_loading`. A POST answered with 204 or a download fires `navigate` and `beforeunload` and then
   * nothing this page can see, so it waits the bound.
   */
  try {
    if (window.navigation) {
      window.navigation.addEventListener('navigate', (e) => { if (!e.hashChange && !e.downloadRequest && !(e.destination && e.destination.sameDocument)) s.navigated = true; });
      const ended = () => { s.navigated = false; };
      window.navigation.addEventListener('navigatesuccess', ended);
      window.navigation.addEventListener('navigateerror', ended);
    }
  } catch { /* no Navigation API */ }
  window.addEventListener('beforeunload', () => { s.navigated = true; });
  // Foxl's own overlay (visual-indicator.js: the glow, Stop Foxl, a click's highlight) is not the page changing.
  // Membership in accessibility-tree.js's isolated-world set, never an id a page could copy.
  const foxlNode = (node) => {
    const own = window.__foxlOwnNodes;
    for (let n = node, i = 0; n && i < 40; n = n.parentNode, i++) if (own && typeof own.has === 'function' && own.has(n)) return true;
    return false;
  };
  const pageChanged = (records) => records.some((r) => {
    if (foxlNode(r.target)) return false;
    const nodes = [...r.addedNodes, ...r.removedNodes];
    return !(nodes.length && nodes.every(foxlNode));
  });
  const observe = () => {
    try {
      new MutationObserver((records) => { if (pageChanged(records)) s.mutatedAt = Date.now(); })
        .observe(document.documentElement || document, { subtree: true, childList: true, characterData: true });
    } catch { /* nothing to observe yet */ }
  };
  if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe, { once: true });
  window.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    // Only a submit during Foxl's own step is looked at: a form you send yourself is never recorded or stopped.
    if (!s.armedAt || Date.now() - s.armedAt > STEP_HOLD_WINDOW_MS) return;
    /*
     * Any form being sent, described or not (a sign-in, a GET search). Its navigation starts in a LATER task
     * (HTML "plan to navigate"), so the settle sent right after the click can run before `navigate` fires:
     * with only `navigate` to go on, the desktop's own browser answered "nothing" for 13 of 20 sign-ins and
     * 12 of 20 searches (foxl-ai/pilot #6394, measured 2026-11-04), and the command sent next cancelled the sign-in.
     */
    s.submitSeen = true;
    let info = null;
    try { info = describe(form, e.submitter || null); } catch { info = null; }
    if (!info) return;
    if (s.hold.has(info.digest) && Date.now() - s.armedAt <= STEP_HOLD_WINDOW_MS) {
      e.preventDefault();
      e.stopImmediatePropagation();
      s.blocked = info;
      return;
    }
    s.submitted = info;
    try { sessionStorage.setItem(SENT_KEY, JSON.stringify(info)); } catch { /* the answer cannot carry it */ }
  }, true);

  const page = () => ({
    title: String(document.title || '').slice(0, 120),
    heading: String((document.querySelector('h1') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    text: String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  });
  const sent = () => {
    try {
      const v = sessionStorage.getItem(SENT_KEY);
      sessionStorage.removeItem(SENT_KEY);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Arms the page before a step; `hold` is the digests the desktop's chat already sent. */
  window.__foxlStepArm = function stepArm(hold) {
    s.armedAt = Date.now();
    s.navigated = false;
    s.mutatedAt = 0;
    s.submitted = null;
    s.submitSeen = false;
    s.blocked = null;
    s.hold = new Set(Array.isArray(hold) ? hold.filter((d) => typeof d === 'string').slice(0, 50) : []);
    try { sessionStorage.removeItem(SENT_KEY); } catch { /* no storage here */ }
    return { success: true, origin: performance.timeOrigin };
  };

  /** What the step did, after waiting for its answer when something happened. */
  window.__foxlStepSettle = async function stepSettle(origin) {
    const started = Date.now();
    // The step ends when it is read: its hold, and the watch on submits, end with it.
    const report = (settled) => {
      s.hold = new Set();
      const answer = { success: true, settled, navigated: s.navigated, submitted: s.submitted, blocked: s.blocked, waitedMs: Date.now() - started, page: settled === 'nothing' ? null : page() };
      s.armedAt = 0;
      return answer;
    };
    if (origin !== performance.timeOrigin) return { ...report('answered'), navigated: true, submitted: sent() };
    if (s.blocked) return report('blocked');
    const own = () => { let n = 0; for (const at of s.pending.values()) if (at >= s.armedAt) n++; return n; };
    const changed = () => s.mutatedAt >= s.armedAt;
    const sending = () => !!(s.submitted || s.submitSeen);
    if (!s.navigated && !sending() && own() === 0 && !changed()) return report('nothing');
    const until = started + STEP_SETTLE_MS;
    while (Date.now() < until && (s.navigated || own() > 0 || (sending() && !changed() && Date.now() - started < STEP_DEFERRED_MS))) await sleep(50);
    const quietBy = Date.now() + STEP_QUIET_MAX_MS;
    while (Date.now() < quietBy && Date.now() - s.mutatedAt < STEP_QUIET_MS) await sleep(50);
    return report(Date.now() >= until ? 'still_loading' : 'answered');
  };

  /** The page a step's navigation led to: what it shows, and the form the step sent from the page before. */
  window.__foxlStepPage = function stepPage(origin) {
    return { success: true, newDocument: origin !== performance.timeOrigin, submitted: sent(), page: page() };
  };
})();
