/**
 * What a click or a key press sent, before the next command reads the page (foxl-ai/pilot #6394).
 *
 * A bill dispute was filed twice through Foxl's own browser: a read sent with Submit ran before the
 * form's navigation started, showed the form again, and the person's "yes, go ahead" filed it again. This
 * extension's `click` returns as soon as the content script has clicked too, and here a read sent while a
 * page load is under way reaches the OLD page, so the desktop asks for the same watch, announced as the
 * `step-watch` capability. The design is the desktop's own (foxl-ai/pilot server/tools/browser-step-watch.ts,
 * reworked after the train AL review of 768952472b):
 *   - `__foxlStepArm` before a click, a `click_at`, a key press and a `type` that presses Enter: a capture-phase
 *     `submit` listener for the step's own submits, a Navigation API listener and a change observer;
 *   - `__foxlStepLook` right after it, at once: a step that sent no form is done, with no wait for a view, a
 *     request or a quiet page; a form that went out is reported now, before any waiting;
 *   - `__foxlStepSettle` for a form: waits in the page until its answer STARTS (a page load, which the
 *     service worker then waits out and reads with `__foxlStepPage`), or, for a form the page sends with
 *     `fetch` / XHR, until those requests are answered and the page has drawn them (request-watch.js counts
 *     them, only from the step's own submit until this look ends).
 * A submit counts as sent when the page let it go, a page load started, or a request with a body went to the page's
 * or the form's own origin, whenever in the step it starts (a payment sent by `fetch` after an `await` counts; an
 * analytics hit to another host does not). One the page took over with nothing Foxl can see after it is
 * `unconfirmed`, never "not sent": its own check may have stopped it, or a payment provider's frame may have sent
 * it. It is not recorded, so the corrected submit is not held (foxl-ai/pilot #6426's train AL re-review).
 *
 * THE SAME FORM SENT TWICE BY MISTAKE: `hold` lists the forms the desktop's chat already sent (their digests,
 * computed by the same algorithm as the desktop's own browser, `DESCRIBE_FORM_SOURCE`, so one chat that uses
 * both browsers matches). A form's identity is its action, the page it is on, the person's choices in it
 * (boxes ticked, options chosen, amounts, dates) or every answer when it is only words, its stable hidden
 * fields (a product id; per-load tokens and long state blobs are left out), the submit button's own name and
 * value, and its place among the page's POST forms to the same action; a form with a password field is never
 * described. A submit of a held form during the step is stopped before the page's own
 * handlers run and reported as `blocked`. Only a submit during Foxl's own step is looked at, so a form the
 * person sends is never described or stopped.
 *
 * A step whose answer was never read (the desktop gave up on it) leaves its form in `sessionStorage` (this
 * chat only, same origin, half an hour): the next arm on that site returns it as `leftover` and holds it.
 */
(() => {
  if (window.__foxlStepWatch) return;
  Object.defineProperty(window, '__foxlStepWatch', { value: true });

  const STEP_SETTLE_MS = 8000;
  const STEP_DEFERRED_MS = 2000;
  const STEP_QUIET_MS = 300;
  const STEP_QUIET_MAX_MS = 1500;
  const STEP_HOLD_WINDOW_MS = 10000;
  const STEP_LEFTOVER_MS = 30 * 60000;
  const SENT_KEY = '__foxlStepSent';

  // The page's description of a submitted POST form, or null (a GET form, a sign-in, nothing in it).
  // KEEP IN STEP with foxl-ai/pilot server/tools/browser-step-watch.ts DESCRIBE_FORM_SOURCE: the digest must match.
  const describe = (form, submitter) => {
    const method = String((submitter && submitter.getAttribute('formmethod')) || form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'post') return null;
    if (form.querySelector('input[type=password]')) return null;
    let action;
    try { action = new URL((submitter && submitter.getAttribute('formaction')) || form.getAttribute('action') || location.href, location.href); } catch (e) { return null; }
    const fields = [];
    const hidden = [];
    const STRUCTURED_TYPES = ['checkbox', 'radio', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'email', 'tel', 'range', 'color'];
    // A hidden field is the form's own data (a product, an order, a line) unless it is a per-load token or state.
    const TOKEN_NAME = /token|csrf|xsrf|nonce|authenticity|verif|captcha|signature|hmac|session|timestamp|state$|^_|^utf8$|^ts$|^t$/i;
    for (const el of Array.from(form.elements)) {
      if (!el.name || el.disabled) continue;
      const tag = el.tagName; const type = String(el.type || '').toLowerCase();
      if (tag === 'INPUT') {
        if (type === 'hidden') { const v = String(el.value == null ? '' : el.value); if (v && v.length <= 64 && !TOKEN_NAME.test(el.name)) hidden.push([String(el.name), v]); continue; }
        if (['password', 'file', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
        if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
        fields.push([el.name, el.value, STRUCTURED_TYPES.includes(type)]);
      } else if (tag === 'TEXTAREA') fields.push([el.name, el.value, false]);
      else if (tag === 'SELECT') for (const o of Array.from(el.selectedOptions)) fields.push([el.name, o.value, true]);
    }
    const choiceLike = (v) => /^[\s$€£¥₩+-]*\d[\d.,:\/\s-]*$/.test(v);
    const norm = fields.map(([n, v, s]) => [String(n), String(v == null ? '' : v).replace(/\s+/g, ' ').trim(), s]).filter(([, v]) => v);
    if (!norm.length && !hidden.length) return null;
    const choices = norm.filter(([, v, s]) => s || choiceLike(v)).map(([n, v]) => [n, v]);
    const byName = (a, b) => (a[0] + '=' + a[1] < b[0] + '=' + b[1] ? -1 : 1);
    // The submit button's own name and value are sent with the form: one form whose buttons carry the product.
    const own = submitter && submitter.name && !submitter.disabled ? [[String(submitter.name), String(submitter.value == null ? '' : submitter.value)]] : [];
    const identity = [...(choices.length ? choices : norm.map(([n, v]) => [n, v])).sort(byName), ...hidden.sort(byName), ...own];
    let onPage = location.pathname;
    try { const u = new URL(location.href); for (const k of Array.from(u.searchParams.keys())) if (/^(utm_|mc_)|^(gclid|fbclid|msclkid|_ga|ref)$/i.test(k)) u.searchParams.delete(k); onPage = u.pathname + u.search; } catch (e) { /* the path alone */ }
    // Which of the page's POST forms to this action it is, when it has several (a list of products or classes).
    let which = '';
    try {
      const root = form.getRootNode && form.getRootNode();
      const actionOf = (f) => String(f.getAttribute('action') || '');
      const peers = Array.from((root && root.querySelectorAll ? root : document).querySelectorAll('form'))
        .filter((f) => String(f.getAttribute('method') || 'get').toLowerCase() === 'post' && actionOf(f) === actionOf(form));
      if (peers.length > 1) which = '#' + peers.indexOf(form);
    } catch (e) { /* one form */ }
    const key = action.host + action.pathname + action.search + '|' + onPage + which + '|' + JSON.stringify(identity);
    const fnv = (str, seed) => { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); };
    const label = String((submitter && (submitter.innerText || submitter.value || submitter.getAttribute('aria-label'))) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const summary = identity.slice(0, 8).map(([n, v]) => n + ': ' + v.replace(/\d{12,}/g, '...').slice(0, 60));
    return { digest: fnv(key, 2166136261) + fnv(key, 3735928559), host: action.host, action: action.pathname, label, summary };
  };

  const s = { armedAt: 0, chat: '', navigated: false, mutatedAt: 0, doneAt: 0, submit: null, blocked: null, hold: new Set(), pending: new Map(), next: 0, watching: false };

  // The page's requests (request-watch.js, in the page's own world), counted only while a step's submit is out.
  // A request that SENDS ('+<id>!': a body, to the page's or the form's own origin) counts the submit as sent,
  // whenever in the step it starts: a page that awaits something first sends its fetch after the submit's first task.
  document.addEventListener('foxl-request', (e) => {
    if (!s.watching) return;
    const m = /^([+-])(\d+)(!?)$/.exec(String(e.detail));
    if (!m) return;
    if (m[1] === '+') {
      s.next += 1;
      if (s.pending.size < 500) s.pending.set(m[2], Date.now());
      if (m[3] === '!' && s.submit && s.armedAt) markCounted(s.submit);
    } else { s.pending.delete(m[2]); s.doneAt = Date.now(); }
  });
  const watchRequests = (on, formOrigin = '') => {
    if (s.watching === on) return;
    s.watching = on;
    if (!on) s.pending.clear();
    try { document.dispatchEvent(new CustomEvent('foxl-step-requests', { detail: on ? `watch ${formOrigin}` : 'unwatch' })); } catch { /* no document */ }
  };

  const writeSent = (o) => { try { sessionStorage.setItem(SENT_KEY, JSON.stringify(o)); } catch { /* the answer cannot carry it */ } };
  // Read, never taken: the next arm takes the record (and the desktop records it only when it has none).
  const peekSent = () => { try { const v = sessionStorage.getItem(SENT_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
  const markCounted = (sub) => { if (!sub || sub.counted) return; sub.counted = true; if (sub.info) writeSent({ info: sub.info, chat: sub.chat, at: sub.at, counted: true }); };

  // A page load to come. A same-document navigation (history.pushState, a single-page app's view) never unloads the page.
  try {
    if (window.navigation) {
      window.navigation.addEventListener('navigate', (e) => {
        if (!s.armedAt || e.hashChange || e.downloadRequest || (e.destination && e.destination.sameDocument)) return;
        s.navigated = true;
        markCounted(s.submit);
      });
      // A link the page intercepts ends HERE, in this document, when its handler does: no page load comes.
      const ended = () => { s.navigated = false; };
      window.navigation.addEventListener('navigatesuccess', ended);
      window.navigation.addEventListener('navigateerror', ended);
    }
  } catch { /* no Navigation API */ }
  window.addEventListener('beforeunload', () => { if (s.armedAt) { s.navigated = true; markCounted(s.submit); } });

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
    // Only a submit during Foxl's own step: a form you send yourself is never described or stopped.
    if (!s.armedAt || Date.now() - s.armedAt > STEP_HOLD_WINDOW_MS || !(form instanceof HTMLFormElement)) return;
    let info = null;
    try { info = describe(form, e.submitter || null); } catch { info = null; }
    if (info && s.hold.has(info.digest)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      s.blocked = info;
      return;
    }
    let origin = location.origin;
    try { origin = new URL((e.submitter && e.submitter.getAttribute('formaction')) || form.getAttribute('action') || location.href, location.href).origin; } catch { /* the page's */ }
    const sub = { info, chat: s.chat, at: Date.now(), seq: s.next, judged: false, prevented: false, during: 0, counted: false, origin };
    s.submit = sub;
    // Its requests are counted from here: the page's handlers run after this listener.
    watchRequests(true, origin);
    if (info) writeSent({ info, chat: s.chat, at: sub.at, counted: false });
    // After the page's own handlers: did it let the form go? A request it sent counted it already (above); any
    // request in this first task, an analytics hit too, does not count by itself.
    setTimeout(() => {
      sub.prevented = e.defaultPrevented;
      sub.during = s.next - sub.seq;
      sub.judged = true;
      if (!sub.prevented) markCounted(sub);
    }, 0);
  }, true);

  const page = () => ({
    title: String(document.title || '').slice(0, 120),
    heading: String((document.querySelector('h1') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    text: String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The step ends when it is read: its hold, the watch on submits and the request count end with it.
  const end = () => { s.armedAt = 0; s.hold = new Set(); watchRequests(false); };
  const answered = (chat) => {
    const o = peekSent();
    return { success: true, phase: 'done', settled: 'answered', navigated: true, newDocument: true, submitted: o && o.chat === chat ? o.info : null, page: page() };
  };

  /** Arms the page before a step; `hold` is the digests the desktop's chat already sent, `chat` its key. */
  window.__foxlStepArm = function stepArm(hold, chat) {
    const key = String(chat || '');
    let leftover = null;
    try {
      const v = sessionStorage.getItem(SENT_KEY);
      sessionStorage.removeItem(SENT_KEY);
      const o = v ? JSON.parse(v) : null;
      if (o && key && o.chat === key && o.counted && o.info && Date.now() - o.at >= 0 && Date.now() - o.at < STEP_LEFTOVER_MS) leftover = o.info;
    } catch { /* no storage here */ }
    watchRequests(false);
    s.armedAt = Date.now();
    s.chat = key;
    s.navigated = false;
    s.mutatedAt = 0;
    s.doneAt = 0;
    s.submit = null;
    s.blocked = null;
    s.hold = new Set(Array.isArray(hold) ? hold.filter((d) => typeof d === 'string').slice(0, 50) : []);
    // A form a stopped step of this chat sent here is held too, and reported for the desktop to record.
    if (leftover) s.hold.add(leftover.digest);
    return { success: true, origin: performance.timeOrigin, leftover };
  };

  /** What the step did, at once. A step that sent no form is done; a form is reported before any waiting. */
  window.__foxlStepLook = function stepLook(origin, chat) {
    if (origin !== performance.timeOrigin) return answered(chat);
    if (s.blocked) { const blocked = s.blocked; end(); return { success: true, phase: 'done', settled: 'blocked', blocked }; }
    const sub = s.submit;
    // A link the page intercepts (a transition in this document) is the page's own change, not a page load.
    const loading = s.navigated && !(window.navigation && window.navigation.transition);
    if (!sub) { end(); return { success: true, phase: 'done', settled: 'nothing', navigated: loading }; }
    return { success: true, phase: 'submitting', submitted: sub.info, judged: sub.judged, counted: sub.counted, navigated: loading };
  };

  /** For a form being sent: waits until its answer starts (a page load), or the page's own requests are answered and drawn. */
  window.__foxlStepSettle = async function stepSettle(origin, chat) {
    if (origin !== performance.timeOrigin) return answered(chat);
    const sub = s.submit;
    if (!sub) return { success: true, settled: 'nothing' };
    const started = Date.now();
    const until = started + STEP_SETTLE_MS;
    const deferred = started + STEP_DEFERRED_MS;
    const transitioning = () => !!(window.navigation && window.navigation.transition);
    const requested = () => s.next > sub.seq;
    const loading = () => s.navigated && !transitioning();
    const finish = (settled) => {
      const out = { success: true, settled, navigated: s.navigated, counted: sub.counted, submitted: sub.counted ? sub.info : null, waitedMs: Date.now() - started, page: settled === 'navigating' ? null : page() };
      end();
      return out;
    };
    while (Date.now() < until) {
      if (loading()) return finish('navigating');
      if (!sub.judged) { await sleep(5); continue; }
      if (s.pending.size > 0 || transitioning()) { await sleep(50); continue; }
      if (requested()) break;
      // A form the page let go: its page load starts in a later task. One it took over: it may still send it.
      if (!sub.prevented || Date.now() < deferred) { await sleep(50); continue; }
      break;
    }
    if (loading()) return finish('navigating');
    if (Date.now() >= until) return finish('still_loading');
    if (requested()) {
      // A form the page sent itself: its answer is drawn after the response comes, so the page's first change after
      // the last answer is waited for (up to STEP_QUIET_MS), then a quiet page (read at once, it was sometimes the form).
      const quietBy = Date.now() + STEP_QUIET_MAX_MS;
      const answeredAt = s.doneAt || Date.now();
      const drawing = () => (s.mutatedAt < answeredAt ? Date.now() - answeredAt < STEP_QUIET_MS : Date.now() - s.mutatedAt < STEP_QUIET_MS);
      while (Date.now() < quietBy && drawing() && !loading()) await sleep(50);
      if (loading()) return finish('navigating');
    }
    // Never "not sent": the page took it over and nothing followed that Foxl can see (its own check, or a payment
    // provider's own frame that sent it).
    return finish(sub.counted ? 'answered' : 'unconfirmed');
  };

  /** The page a step's page load led to: a new document, or the same one (a download, a 204). */
  window.__foxlStepPage = function stepPage(origin) {
    return { success: true, newDocument: origin !== performance.timeOrigin, page: page() };
  };
})();
