/**
 * WHAT FOXL REMEMBERS ABOUT ITS OWN STEP LIVES WHERE THE PAGE CANNOT REACH IT (foxl-ai/pilot #7925).
 *
 * Every described submit leaves a record (the form, and the desktop chat's key) so the next arm on that site can hold
 * and report a form a stopped step sent (`leftover`). The record lives in the extension's storage, keyed by tab and
 * origin. The first two cases are RED on 0.14.0 (main a11298c); the hold and the
 * leftover of a real step are the controls and work as before.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs), a fictional shop. Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const CHAT = 'chat-key-41c7-fixture';
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const SHOP = `<!doctype html><title>Example Shop</title><h1>Example Shop</h1>
<form method="post" action="/order"><input type="hidden" name="item" value="sku-1"><label for="q">Quantity</label><input id="q" name="qty" type="number" value="1"><button type="submit">Place order</button></form>`;
let orders = 0;

let ext;
let tabs = 0;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/shop': (req, res) => html(res, SHOP),
      '/order': (req, res) => { req.resume(); orders += 1; setTimeout(() => html(res, '<!doctype html><title>Order placed</title><h1>Order placed</h1><button id="again" type="button">Back to the shop</button>'), 200); },
    },
  });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const lineOf = (text, needle) => text.split('\n').find((line) => line.includes(needle)) ?? '';
const refOf = (line) => /\[(ref_[^\]\s]+)\]/.exec(line)?.[1] ?? null;
async function openShop() {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/shop#t${++tabs}`);
  const tabId = await ext.tabIdOf(page);
  return { page, tabId, ref: async (needle) => refOf(lineOf((await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' })).data.pageContent, needle)) };
}
const pageStorage = (page) => page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));

let ordered = null;

test('after a step sends a form, the page holds no record and can read no chat key', async () => {
  const shop = await openShop();
  const clicked = await ext.command('click', shop.tabId, { refId: await shop.ref('Place order'), hold: [], chat: CHAT });
  assert.equal(clicked.success, true, JSON.stringify(clicked));
  assert.equal(clicked.step?.submitted?.label, 'Place order', JSON.stringify(clicked.step));
  ordered = { ...shop, digest: clicked.step.submitted.digest };
  await shop.page.waitForSelector('#again');
  const stored = await pageStorage(shop.page);
  assert.ok(!stored.includes(CHAT), `the page can read the chat key: ${stored}`);
  assert.ok(!stored.includes('__foxlStepSent'), `the page holds the step's record: ${stored}`);
});

test('a record the page writes under the old key changes nothing Foxl does', async () => {
  const shop = await openShop();
  await shop.page.evaluate((chat) => sessionStorage.setItem('__foxlStepSent', JSON.stringify({
    info: { digest: '0123456789abcdef', host: location.host, action: '/order', label: 'Place order', summary: ['item: written by the page'] },
    chat, at: Date.now(), counted: true,
  })), 'chat-the-page-chose');
  const before = orders;
  const clicked = await ext.command('click', shop.tabId, { refId: await shop.ref('Place order'), hold: [], chat: 'chat-the-page-chose' });
  assert.equal(clicked.success, true, JSON.stringify(clicked));
  assert.equal(clicked.leftover, undefined, `the page's record was taken as this chat's: ${JSON.stringify(clicked.leftover)}`);
  assert.notEqual(clicked.step?.settled, 'blocked', JSON.stringify(clicked.step));
  assert.deepEqual(clicked.step?.submitted?.summary, ['qty: 1', 'item: sku-1'], JSON.stringify(clicked.step));
  await shop.page.waitForSelector('#again');
  assert.equal(orders, before + 1, 'the order reached the site');
});

test('a held submit still holds as before', async () => {
  assert.ok(ordered?.digest, 'the first step described its form');
  const shop = await openShop();
  const before = orders;
  const clicked = await ext.command('click', shop.tabId, { refId: await shop.ref('Place order'), hold: [ordered.digest], chat: CHAT });
  assert.equal(clicked.step?.settled, 'blocked', JSON.stringify(clicked.step));
  await shop.page.waitForTimeout(800);
  assert.equal(orders, before, 'a held form reached the site');
});

test('the next step on that site in that tab reports the form this chat sent, as before', async () => {
  assert.ok(ordered, 'the first step ran');
  const tree = (await ext.command('get_accessibility_tree', ordered.tabId, { filter: 'interactive' })).data.pageContent;
  const clicked = await ext.command('click', ordered.tabId, { refId: refOf(lineOf(tree, 'Back to the shop')), hold: [], chat: CHAT });
  assert.equal(clicked.success, true, JSON.stringify(clicked));
  assert.equal(clicked.leftover?.digest, ordered.digest, JSON.stringify(clicked));
  assert.equal(clicked.leftover.label, 'Place order');
});
