/**
 * WHAT A SAVED SIGN-IN TYPED IS NEVER READ BACK AS TEXT, WHEREVER THE PAGE PUTS IT (foxl-ai/pilot #7859).
 *
 * A field `fill_sign_in` typed into reads `value="filled-by-foxl"`, and the mask follows the value as well as the
 * element: a field the page draws again (a framework's re-render; here, a clone holding the same value) reads masked
 * in the tree, a snapshot and read_text, and a typing's read-back (READ_VALUE) asks the same check, which knows the
 * values a saved sign-in typed in that tab and origin, by salted fingerprint. The masked cases are RED on 0.14.0 (main
 * a11298c); an ordinary field is the control and reads as before. No page handler answers the two messages an older
 * service worker sent (CLICK_ELEMENT, TYPE_IN_ELEMENT): the second typed and read the value back without the check.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs), a fictional local bank. Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const USER = 'fixture-user-8d41';
const MEMO = 'memo-fixture-91af';
const PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
<h1>Sign in to Example Bank</h1>
<div id="box"><label for="u">User ID</label><input id="u" name="userid" type="text" autocomplete="off"></div>
<label for="m">Memo</label><input id="m" name="memo" type="text" value="${MEMO}">
<script>
  // The page's own framework: draws the user field again as a new element holding the same value.
  window.redraw = () => { const old = document.getElementById('u'); const fresh = old.cloneNode(true); fresh.value = old.value; old.replaceWith(fresh); };
  // A field that keeps what was in it: any typing is put back to the value it held.
  window.lock = () => { const el = document.getElementById('u'); const kept = el.value; el.addEventListener('input', () => { el.value = kept; }); };
</script></body></html>`;

let ext;
let pages = 0;
const refOf = (tree, label) => new RegExp(`textbox "${label}" \\[(ref_\\d+)\\]`).exec(tree)?.[1] ?? null;
async function signedInPage() {
  const page = await ext.context.newPage();
  // A fragment tells the tabs apart: the harness finds a page's tab by its address.
  await page.goto(`${ext.origin}/sign-in#p${++pages}`);
  const tabId = await ext.tabIdOf(page);
  const tree = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  const user = refOf(tree, 'User ID');
  assert.ok(user, tree);
  const filled = await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: user, kind: 'username', value: USER }] });
  assert.equal(filled?.success, true, JSON.stringify(filled));
  assert.equal(await page.evaluate(() => document.getElementById('u').value), USER, 'the fill typed the username');
  return { page, tabId };
}

before(async () => {
  ext = await launchExtension({ routes: { '/sign-in': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); } } });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

test('after the page draws the filled field again, the tree, a snapshot and read_text still mask it', async () => {
  const { page, tabId } = await signedInPage();
  await page.evaluate(() => window.redraw());
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  assert.ok(!JSON.stringify(tree).includes(USER), `the tree shows the username:\n${tree.data.pageContent}`);
  assert.match(tree.data.pageContent, /textbox "User ID" \[ref_\d+\] type="text" value="filled-by-foxl"/);
  const snap = await ext.command('get_accessibility_tree', tabId, { snapshot: true, filter: 'all' });
  assert.equal(snap?.success, true, JSON.stringify(snap));
  assert.ok(!JSON.stringify(snap).includes(USER), `the snapshot shows the username:\n${snap.pageContent}`);
  const ref = refOf(tree.data.pageContent, 'User ID');
  const text = await ext.command('read_text', tabId, { refId: ref });
  assert.equal(text?.text, 'filled-by-foxl', JSON.stringify(text));
  assert.ok(!JSON.stringify(text).includes(USER));
  await page.close();
});

test('a typing\'s read-back never quotes the filled value, on the same field or one drawn again', async () => {
  const { page, tabId } = await signedInPage();
  await page.evaluate(() => window.lock());
  const tree = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  const same = await ext.command('type', tabId, { refId: refOf(tree, 'User ID'), text: 'someone-else' });
  assert.equal(same?.success, false, JSON.stringify(same));
  assert.ok(!JSON.stringify(same).includes(USER), `the read-back quotes the username: ${JSON.stringify(same)}`);
  await page.evaluate(() => { window.redraw(); window.lock(); });
  const again = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  const redrawn = await ext.command('type', tabId, { refId: refOf(again, 'User ID'), text: 'someone-else' });
  assert.equal(redrawn?.success, false, JSON.stringify(redrawn));
  assert.ok(!JSON.stringify(redrawn).includes(USER), `the read-back quotes the username: ${JSON.stringify(redrawn)}`);
  await page.close();
});

test('no page handler answers an older service worker\'s TYPE_IN_ELEMENT or CLICK_ELEMENT, so neither quotes the value', async () => {
  const { page, tabId } = await signedInPage();
  await page.evaluate(() => { window.redraw(); window.lock(); });
  const tree = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  const ref = refOf(tree, 'User ID');
  assert.ok(ref, tree);
  const worker = ext.context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${ext.extensionId}/`));
  assert.ok(worker, 'the extension\'s service worker');
  // What an older service worker sent the page: typing with a read-back, and a click. No current build sends them.
  // The typed text is in no part of USER: the old read-back compared it with what the locked field still holds, so a
  // text USER contains ('x', in "fixture") passed that compare and the error that quoted the field never ran.
  assert.ok(!USER.includes('q'));
  const answers = await worker.evaluate(async ({ id, refId }) => {
    const ask = (message) => Promise.race([
      chrome.tabs.sendMessage(id, message, { frameId: 0 }).catch((err) => ({ error: String(err?.message || err) })),
      new Promise((r) => setTimeout(() => r({ noAnswer: true }), 1500)),
    ]);
    return [await ask({ type: 'TYPE_IN_ELEMENT', refId, text: 'q' }), await ask({ type: 'CLICK_ELEMENT', refId })];
  }, { id: tabId, refId: ref });
  assert.ok(!JSON.stringify(answers).includes(USER), `a page handler quoted the filled value: ${JSON.stringify(answers)}`);
  for (const answer of answers) assert.equal(answer?.success === true, false, `a page handler acted: ${JSON.stringify(answers)}`);
  await page.close();
});

test('an ordinary field reads as before', async () => {
  const { page, tabId } = await signedInPage();
  const tree = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  assert.match(tree, new RegExp(`textbox "Memo" \\[ref_\\d+\\] type="text" value="${MEMO}"`));
  const memo = refOf(tree, 'Memo');
  assert.equal((await ext.command('read_text', tabId, { refId: memo }))?.text, MEMO);
  const typed = await ext.command('type', tabId, { refId: memo, text: 'pay rent' });
  assert.equal(typed?.success, true, JSON.stringify(typed));
  assert.equal(await page.evaluate(() => document.getElementById('m').value), 'pay rent');
  await page.close();
});
