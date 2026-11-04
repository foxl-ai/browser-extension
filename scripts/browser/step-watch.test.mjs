/**
 * A CLICK OR A KEY PRESS WAITS FOR WHAT IT STARTED (0.12.0, foxl-ai/pilot #6394).
 *
 * One bill dispute was filed twice: a read sent with Submit ran before the form's navigation started,
 * showed the form again, and the person's "yes, go ahead" filed it again. Each case here is RED on 0.11.0
 * (main 6c0f26f): its `click` answers the moment the content script has clicked, with no `step`.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs), against a fictional billing site that
 * does what real ones do: it checks a dispute before sending it (a 300 ms request, then the form is
 * sent) and answers the submit after 1.5 s. Driven over the desktop's own `browser_command` protocol.
 * Run: npm run test:browser. FOXL_EXTENSION_DIR=<a release's tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const CHECK_MS = 300;
const ANSWER_MS = 1500;
const ORDER_MS = 600;
let filed = 0;
let signins = 0;
let searches = 0;
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const FORM_PAGE = () => `<!doctype html><html><head><title>Peakwave Mobile - Dispute</title></head><body>
<h1>Dispute a charge</h1>
<form method="post" action="/dispute">
  <label><input type="checkbox" name="line" value="L1"> L1: Promotional credit (ended)</label>
  <label for="amount">Amount you are disputing</label><input id="amount" name="amount">
  <label for="why">Explain what is wrong</label><textarea id="why" name="why"></textarea>
  <input type="hidden" name="token" value="${Math.random()}">
  <button type="submit">Submit dispute</button>
</form>
<script>
  // The site checks the dispute before it sends it, as billing sites do.
  document.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    fetch('/dispute/check', { method: 'POST' }).then(() => e.target.submit());
  });
</script></body></html>`;

let ext;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/dispute': (req, res) => {
        if (req.method !== 'POST') return html(res, FORM_PAGE());
        req.resume();
        filed += 1;
        const conf = `DS-${3009 + filed}`;
        setTimeout(() => html(res, `<!doctype html><title>Submitted</title><h1>Dispute submitted</h1><p>${conf}: $109.22 on L1.</p>`), ANSWER_MS);
      },
      '/dispute/check': (req, res) => { req.resume(); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, CHECK_MS); },
      '/options': (req, res) => html(res, '<!doctype html><title>Options</title><h1>Options</h1><label><input type="checkbox" id="paper" aria-label="Paperless billing"> Paperless billing</label>'),
      // A single-page app moving to another view: history.pushState, then the view drawn at once...
      '/spa': (req, res) => html(res, `<!doctype html><title>Orders</title><h1>Orders</h1><button id="b">Show order 42</button><div id="view"></div>
<script>document.getElementById('b').onclick = () => { history.pushState({}, '', '/orders/42'); document.getElementById('view').innerHTML = '<h2>Order 42</h2>'; };</script>`),
      // ...or after the view's data comes back (ORDER_MS)...
      '/spa-fetch': (req, res) => html(res, `<!doctype html><title>Orders</title><h1>Orders</h1><button id="b">Show order 43</button><div id="view"></div>
<script>document.getElementById('b').onclick = async () => { history.pushState({}, '', '/orders/43'); const r = await fetch('/order-data'); document.getElementById('view').innerHTML = '<h2>' + await r.text() + '</h2>'; };</script>`),
      // A sign-in (a password field: never described, never held) and a GET search.
      '/signin': (req, res) => html(res, '<!doctype html><title>Sign in</title><h1>Sign in</h1><form method="post" action="/session"><label for="u">Email</label><input id="u" name="email" type="email"><label for="p">Password</label><input id="p" name="password" type="password"><button type="submit">Sign in</button></form>'),
      '/session': (req, res) => { req.resume(); signins += 1; setTimeout(() => html(res, '<!doctype html><title>Account</title><h1>Signed in</h1>'), CHECK_MS); },
      '/search': (req, res) => html(res, '<!doctype html><title>Search</title><h1>Search</h1><form method="get" action="/find"><label for="q">Query</label><input id="q" name="q"><button type="submit">Search</button></form>'),
      '/find': (req, res) => { searches += 1; html(res, '<!doctype html><title>Results</title><h1>Results</h1><p>2 results</p>'); },
      '/order-data': (req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Order 43: $109.22'); }, ORDER_MS); },
      // ...or a link the app intercepts with the Navigation API, drawn when its handler ends.
      '/intercept': (req, res) => html(res, `<!doctype html><title>Orders</title><h1>Orders</h1><a href="/orders/7">Order 7</a><div id="view"></div>
<script>navigation.addEventListener('navigate', (e) => { if (e.canIntercept && new URL(e.destination.url).pathname === '/orders/7') e.intercept({ handler: () => new Promise((r) => setTimeout(() => { document.getElementById('view').innerHTML = '<h2>Order 7 details</h2>'; r(); }, 500)) }); });</script>`),
    },
  });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const lineOf = (text, needle) => text.split('\n').find((line) => line.includes(needle)) ?? '';
const refOf = (line) => /\[(ref_[^\]\s]+)\]/.exec(line)?.[1] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh dispute form in its own tab, filled with the same choices each time. Returns the submit's ref. */
async function filledForm() {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/dispute?form=${++forms}`);
  const tabId = await ext.tabIdOf(page);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' });
  const text = tree.data.pageContent;
  const box = await ext.command('click', tabId, { refId: refOf(lineOf(text, 'checkbox "L1"')) });
  assert.equal(box.success, true, JSON.stringify(box));
  assert.equal(box.step, undefined, `ticking a box changes nothing a step waits for, and its answer is as before: ${JSON.stringify(box)}`);
  await ext.command('type', tabId, { refId: refOf(lineOf(text, 'Amount you are disputing')), text: '109.22' });
  await ext.command('type', tabId, { refId: refOf(lineOf(text, 'Explain what is wrong')), text: `Promo credit missing (${Math.random()})` });
  return { page, tabId, submit: refOf(lineOf(text, 'Submit dispute')) };
}

let firstDigest = null;
let forms = 0;

test('the build announces step-watch', () => {
  assert.ok((ext.announced.capabilities ?? []).includes('step-watch'), `extension_connected: ${JSON.stringify(ext.announced)}`);
});

test('a click that sends a form waits for the site\'s answer and reports it; a read right after shows it (RED on 0.11.0)', async () => {
  const { tabId, submit } = await filledForm();
  const started = Date.now();
  const clicked = await ext.command('click', tabId, { refId: submit });
  assert.equal(clicked.success, true, JSON.stringify(clicked));
  assert.equal(filed, 1, 'sent once');
  const step = clicked.step;
  assert.ok(step, `the click reports what it started: ${JSON.stringify(clicked)}`);
  assert.equal(step.settled, 'answered', JSON.stringify(step));
  assert.equal(step.navigated, true);
  assert.equal(step.page?.heading, 'Dispute submitted', JSON.stringify(step.page));
  assert.match(step.page.text, /DS-3010/);
  assert.equal(step.submitted?.label, 'Submit dispute', JSON.stringify(step.submitted));
  assert.deepEqual(step.submitted.summary, ['amount: 109.22', 'line: L1'], 'the choices are the form\'s identity, not the explanation');
  assert.ok(Date.now() - started >= CHECK_MS + ANSWER_MS - 100, 'it waited for the answer');
  firstDigest = step.submitted.digest;
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  assert.match(tree.data.pageContent, /Dispute submitted/, `the read sent after it shows the answer: ${tree.data.pageContent.slice(0, 200)}`);
});

test('the same form with the same choices, held by the desktop, is not sent during the step (RED on 0.11.0)', async () => {
  assert.ok(firstDigest, 'the first submit was described');
  const { page, tabId, submit } = await filledForm();
  const clicked = await ext.command('click', tabId, { refId: submit, hold: [firstDigest] });
  assert.equal(clicked.success, true, JSON.stringify(clicked));
  assert.equal(clicked.step?.settled, 'blocked', JSON.stringify(clicked));
  assert.equal(clicked.step.blocked?.digest, firstDigest);
  await sleep(CHECK_MS + ANSWER_MS + 500);
  assert.equal(filed, 1, 'nothing reached the site');
  // The hold was the step's own: the person's own click afterwards sends the form.
  await page.click('button[type=submit]');
  for (let i = 0; i < 40 && filed < 2; i++) await sleep(100);
  assert.equal(filed, 2, 'the person\'s own submit after the step goes through');
});

test('a click on a page with nothing to answer returns at once, its answer unchanged', async (t) => {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/options`);
  const tabId = await ext.tabIdOf(page);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' });
  const started = Date.now();
  const clicked = await ext.command('click', tabId, { refId: refOf(lineOf(tree.data.pageContent, 'Paperless billing')) });
  const tookMs = Date.now() - started;
  t.diagnostic(`a click that changes nothing answered in ${tookMs} ms`);
  assert.equal(clicked.success, true, JSON.stringify(clicked));
  assert.equal(clicked.step, undefined, JSON.stringify(clicked));
  assert.ok(tookMs < 1500, `no wait: ${tookMs} ms`);
});

/*
 * A form the watch does not describe (a sign-in, a GET search) is still a form being sent. Its navigation starts in
 * a LATER task (HTML "plan to navigate"), so a settle that went on `navigate` alone could answer before it started;
 * the desktop's own browser did so for 13 of 20 sign-ins and 12 of 20 searches. The submit event runs during the
 * click. On 0.11.0 the click answers at once, before the site has the request.
 */
test('a sign-in and a search are never held back, and the click answers once the site has their request (RED on 0.11.0)', async () => {
  for (const [path, fills, count, button, answer] of [
    ['/signin', [['Email', 'dmitri@example.com'], ['Password', 'pw-123456']], () => signins, 'button "Sign in"', /Signed in/],
    ['/search', [['Query', 'march bill']], () => searches, 'button "Search"', /2 results/],
  ]) {
    for (let i = 0; i < 2; i++) {
      const page = await ext.context.newPage();
      await page.goto(`${ext.origin}${path}`);
      const tabId = await ext.tabIdOf(page);
      const text = (await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' })).data.pageContent;
      for (const [name, value] of fills) await ext.command('type', tabId, { refId: refOf(lineOf(text, `"${name}"`)), text: value });
      const before = count();
      const clicked = await ext.command('click', tabId, { refId: refOf(lineOf(text, button)), hold: [] });
      assert.equal(clicked.success, true, `${path} #${i + 1}: ${JSON.stringify(clicked)}`);
      assert.equal(count() - before, 1, `${path} #${i + 1}: the site had the request when the click answered: ${JSON.stringify(clicked)}`);
      assert.notEqual(clicked.step?.settled, 'blocked', `${path} #${i + 1}: never held back`);
      const read = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
      assert.match(read.data.pageContent, answer, `${path} #${i + 1}: a read right after shows the answer: ${read.data.pageContent.slice(0, 200)}`);
      await page.close();
    }
  }
});

/*
 * A single-page app's own navigation never unloads the page. Chromium fires the Navigation API's `navigate` for
 * history.pushState too (measured, Chromium 156: sameDocument true, then `navigatesuccess` at once; an intercepted
 * link: sameDocument false, then `navigatesuccess` when its handler ends). Counted as a page load, every such click
 * waited out STEP_SETTLE_MS and read `still_loading`. On 0.11.0 the click answers at once and a read right after
 * can miss a view that waits for its data.
 */
test('a click that moves a single-page app to another view waits only for that view (RED on 0.11.0: the read misses a view that waits for its data)', async (t) => {
  for (const [path, name, shows] of [['/spa', 'Show order 42', /Order 42/], ['/spa-fetch', 'Show order 43', /Order 43: \$109\.22/], ['/intercept', 'Order 7', /Order 7 details/]]) {
    const page = await ext.context.newPage();
    await page.goto(`${ext.origin}${path}`);
    const tabId = await ext.tabIdOf(page);
    const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' });
    const ref = refOf(lineOf(tree.data.pageContent, `"${name}"`));
    assert.ok(ref, `${path}: a control named "${name}": ${tree.data.pageContent.slice(0, 300)}`);
    const started = Date.now();
    const clicked = await ext.command('click', tabId, { refId: ref });
    const tookMs = Date.now() - started;
    t.diagnostic(`${path}: the click answered in ${tookMs} ms, step ${clicked.step?.settled ?? '(none)'}`);
    assert.equal(clicked.success, true, `${path}: ${JSON.stringify(clicked)}`);
    assert.notEqual(clicked.step?.settled, 'still_loading', `${path}: a view the app drew is not "still loading": ${JSON.stringify(clicked.step)}`);
    assert.ok(tookMs < 4000, `${path}: the click waited for the view, not out the 8 s bound: ${tookMs} ms`);
    const read = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
    assert.match(read.data.pageContent, shows, `${path}: the read right after shows the view: ${read.data.pageContent.slice(0, 300)}`);
    await page.close();
  }
});
