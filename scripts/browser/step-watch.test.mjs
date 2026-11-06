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
let charged = 0;
let asyncCharged = 0;
const carted = [];
function cartForm(id) {
  return `<form method="post" action="/cart/add"><input type="hidden" name="id" value="${id}"><input type="hidden" name="authenticity_token" value="${Math.random()}"><label for="q${id}">Quantity</label><input id="q${id}" type="number" name="quantity" value="1"><button type="submit">Add to cart</button></form>`;
}
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
      // A shop: the product is a HIDDEN field (Shopify, Amazon), a token beside it changes per load; or the button carries it.
      '/product/a': (req, res) => html(res, `<!doctype html><title>Shirt A</title><h1>Shirt A</h1>${cartForm('40001')}`),
      '/product/b': (req, res) => html(res, `<!doctype html><title>Shirt B</title><h1>Shirt B</h1>${cartForm('40002')}`),
      '/multi': (req, res) => html(res, '<!doctype html><title>Shop</title><h1>Shop</h1><form method="post" action="/cart/add"><label for="mq">Quantity</label><input id="mq" type="number" name="quantity" value="1"><button type="submit" name="id" value="40001">Add Shirt A</button><button type="submit" name="id" value="40002">Add Shirt B</button></form>'),
      '/cart/add': (req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { const id = new URLSearchParams(body).get('id'); carted.push(id); setTimeout(() => html(res, `<!doctype html><title>Cart</title><h1>Added to cart</h1><p>Item ${id}</p>`), CHECK_MS); });
      },
      // A payment the page itself refuses (its own script stops an empty name): nothing is sent.
      '/pay': (req, res) => html(res, `<!doctype html><title>Payment</title><h1>Payment</h1><form id="f" method="post" action="/charge"><label for="n">Name on card</label><input id="n" name="name"><label for="amt">Amount</label><input id="amt" name="amount" value="42.00"><button type="submit">Pay</button></form><p id="err"></p>
<script>document.getElementById('f').addEventListener('submit', (e) => { if (!document.getElementById('n').value.trim()) { e.preventDefault(); document.getElementById('err').textContent = 'Enter the name on the card.'; } });</script>`),
      '/charge': (req, res) => { req.resume(); charged += 1; setTimeout(() => html(res, '<!doctype html><title>Paid</title><h1>Payment received</h1>'), CHECK_MS); },
      // A payment the page sends with fetch after an await (async validation, a token step): it reaches the site.
      '/pay-async': (req, res) => html(res, `<!doctype html><title>Payment</title><h1>Payment</h1><form id="f" method="post" action="/charge-async"><label for="pn">Name on card</label><input id="pn" name="name" value="Dmitri Volkov"><label for="pa">Amount</label><input id="pa" name="amount" value="19.99"><button type="submit">Pay now</button></form><p id="out"></p>
<script>document.getElementById('f').addEventListener('submit', async (e) => { e.preventDefault(); await new Promise((r) => setTimeout(r, 300)); const r = await fetch('/charge-async', { method: 'POST', body: new URLSearchParams(new FormData(e.target)) }); document.getElementById('out').textContent = await r.text(); });</script>`),
      '/charge-async': (req, res) => { req.resume(); asyncCharged += 1; setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`Payment received: PAY-${asyncCharged}`); }, ORDER_MS); },
      // Answers that never become a page: a statement download, a POST that downloads, a POST answered 204.
      '/statement': (req, res) => html(res, '<!doctype html><title>Statements</title><h1>Statements</h1><a href="/statement.csv">Download statement</a><form method="post" action="/export"><input type="hidden" name="format" value="csv"><button type="submit">Export</button></form><form method="post" action="/note"><label for="nt">Note</label><input id="nt" name="note" value="Call the bank on Monday"><button type="submit">Save note</button></form>'),
      '/statement.csv': (req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="statement.csv"' }); res.end('date,amount\n2026-10-01,12.00\n'); }, 500); },
      '/export': (req, res) => { req.resume(); setTimeout(() => { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' }); res.end('date,amount\n'); }, 500); },
      '/note': (req, res) => { req.resume(); setTimeout(() => { res.writeHead(204); res.end(); }, CHECK_MS); },
      // The page's own fetch, saved by the page before any step and compared after.
      '/own-fetch': (req, res) => html(res, `<!doctype html><title>Own fetch</title><h1>Own fetch</h1><button id="b">Toggle</button><p id="out"></p>
<script>window.__pagesOwnFetch = window.fetch; window.__pagesOwnSend = XMLHttpRequest.prototype.send; document.getElementById('b').onclick = () => { document.getElementById('out').textContent = 'toggled'; };</script>`),
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
  // A fragment tells the tabs apart: the page's path and query are part of a form's identity, a fragment is not.
  await page.goto(`${ext.origin}/dispute#f${++forms}`);
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

/** A page in its own tab, its interactive tree, and a ref finder. */
async function openTab(path) {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}${path}`);
  const tabId = await ext.tabIdOf(page);
  const text = (await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' })).data.pageContent;
  return { page, tabId, text, ref: (needle) => refOf(lineOf(text, needle)) };
}

/*
 * A CLICK THAT SENDS NO FORM WAITS FOR NOTHING (foxl-ai/pilot #6426's train AL review, 5). A single-page app's view
 * change and a link the app intercepts never unload the page; the race this is about is a FORM's answer, so these
 * answer at once, with no step, as on 0.11.0.
 */
test('a click that sends no form waits for nothing: an SPA view, an intercepted link', async (t) => {
  for (const [path, name] of [['/spa', 'button "Show order 42"'], ['/spa-fetch', 'button "Show order 43"'], ['/intercept', 'link "Order 7"']]) {
    const tab = await openTab(path);
    const started = Date.now();
    const clicked = await ext.command('click', tab.tabId, { refId: tab.ref(name) });
    const tookMs = Date.now() - started;
    t.diagnostic(`${path}: the click answered in ${tookMs} ms, step ${clicked.step?.settled ?? '(none)'}`);
    assert.equal(clicked.success, true, `${path}: ${JSON.stringify(clicked)}`);
    assert.equal(clicked.step, undefined, `${path}: no step: ${JSON.stringify(clicked.step)}`);
    assert.ok(tookMs < 300, `${path}: answered at once: ${tookMs} ms`);
    await tab.page.close();
  }
});

/*
 * A DIFFERENT PURCHASE IS A DIFFERENT FORM (review, 1). The product is a hidden field (Shopify, Amazon), or the button
 * carries it: Shirt B after Shirt A is another form, and the same shirt again is the one that is held.
 */
test('a second, different purchase is a different form; the same one again is held (RED on 0.11.0)', async () => {
  carted.length = 0;
  const a = await openTab('/product/a');
  const first = await ext.command('click', a.tabId, { refId: a.ref('button "Add to cart"') });
  assert.equal(first.step?.settled, 'answered', JSON.stringify(first));
  const digestA = first.step.submitted?.digest;
  const b = await openTab('/product/b');
  const second = await ext.command('click', b.tabId, { refId: b.ref('button "Add to cart"'), hold: [digestA] });
  assert.equal(second.step?.settled, 'answered', `Shirt B is not held as Shirt A: ${JSON.stringify(second.step)}`);
  assert.notEqual(second.step.submitted?.digest, digestA);
  const multi = await openTab('/multi');
  const viaA = await ext.command('click', multi.tabId, { refId: multi.ref('button "Add Shirt A"') });
  const multi2 = await openTab('/multi');
  const viaB = await ext.command('click', multi2.tabId, { refId: multi2.ref('button "Add Shirt B"'), hold: [viaA.step?.submitted?.digest] });
  assert.equal(viaB.step?.settled, 'answered', `the button's product makes it another form: ${JSON.stringify(viaB.step)}`);
  assert.deepEqual(carted, ['40001', '40002', '40001', '40002']);
  const again = await openTab('/product/a');
  const held = await ext.command('click', again.tabId, { refId: again.ref('button "Add to cart"'), hold: [digestA] });
  assert.equal(held.step?.settled, 'blocked', `the same shirt again is held: ${JSON.stringify(held.step)}`);
  await sleep(CHECK_MS + 300);
  assert.equal(carted.length, 4);
});

/*
 * A PAYMENT THE PAGE REFUSED IS NOT CALLED SENT, AND ONE SENT AFTER AN AWAIT IS (review, 2, and its re-review). A submit
 * the page took over with nothing after it is `unconfirmed`, never "not sent"; a request with a body to the page's own
 * origin counts the submit as sent whenever in the step it starts.
 */
test('a refused payment reads unconfirmed; a payment sent by fetch after an await reads sent (RED on 0.11.0)', async () => {
  charged = 0;
  const pay = await openTab('/pay');
  const refused = await ext.command('click', pay.tabId, { refId: pay.ref('button "Pay"') });
  assert.equal(refused.step?.settled, 'unconfirmed', JSON.stringify(refused.step));
  assert.equal(refused.step.submitted, null, 'an unconfirmed form is not reported as sent');
  assert.equal(charged, 0);
  asyncCharged = 0;
  const later = await openTab('/pay-async');
  const paid = await ext.command('click', later.tabId, { refId: later.ref('button "Pay now"') });
  assert.equal(paid.step?.settled, 'answered', JSON.stringify(paid.step));
  assert.equal(asyncCharged, 1, 'it reached the site');
  assert.match(paid.step.page?.text ?? '', /Payment received: PAY-1/, `the answer the page drew: ${JSON.stringify(paid.step.page)}`);
  assert.ok(paid.step.submitted?.digest, 'it is reported sent, so the same payment again is held');
});

/*
 * AN ANSWER THAT IS NO PAGE IS NOT WAITED OUT (review, 3). A statement download, a POST that downloads and a POST
 * answered 204: the click answers when the site does, and never says "still loading".
 */
test('a download and a 204 answer as soon as the site answers', async (t) => {
  for (const [needle, formSent] of [['link "Download statement"', false], ['button "Export"', true], ['button "Save note"', true]]) {
    const tab = await openTab('/statement');
    const started = Date.now();
    const clicked = await ext.command('click', tab.tabId, { refId: tab.ref(needle) });
    const tookMs = Date.now() - started;
    t.diagnostic(`${needle}: answered in ${tookMs} ms, step ${clicked.step?.settled ?? '(none)'}`);
    assert.equal(clicked.success, true, JSON.stringify(clicked));
    assert.notEqual(clicked.step?.settled, 'still_loading', `${needle}: ${JSON.stringify(clicked.step)}`);
    assert.ok(tookMs < 3000, `${needle}: ${tookMs} ms, not the 8 s bound`);
    if (formSent) assert.equal(clicked.step?.settled, 'no_page', `${needle}: ${JSON.stringify(clicked.step)}`);
    await tab.page.close();
  }
});

/* THE PAGE'S OWN fetch AND XHR ARE ITS OWN (review, 6): wrapped only from a step's own submit until it is read. */
test('a step leaves the page\'s own fetch and XMLHttpRequest as they were', async () => {
  const tab = await openTab('/own-fetch');
  const clicked = await ext.command('click', tab.tabId, { refId: tab.ref('button "Toggle"') });
  assert.equal(clicked.success, true);
  assert.equal(await tab.page.evaluate(() => window.fetch === window.__pagesOwnFetch && XMLHttpRequest.prototype.send === window.__pagesOwnSend), true, 'after a click');
  const later = await openTab('/pay-async');
  await ext.command('click', later.tabId, { refId: later.ref('button "Pay now"') });
  assert.equal(await later.page.evaluate(() => /\[native code\]/.test(Function.prototype.toString.call(window.fetch)) && /\[native code\]/.test(Function.prototype.toString.call(XMLHttpRequest.prototype.send))), true,
    'after a fetch submit\'s answer, fetch and send are native again');
});
