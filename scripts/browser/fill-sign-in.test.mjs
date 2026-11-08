/**
 * A SAVED SIGN-IN, TYPED INTO THE TAB'S OWN PAGE (0.12.1), AND WHAT COUNTS AS DRAWN.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs), against a fictional local bank, driven over the
 * desktop's own `browser_command` protocol:
 *   1. `fill_sign_in` types a username and a password into the page the sign-in was saved for, and the answer,
 *      every error and the extension's storage carry neither value;
 *   2. a page on another origin (a sign-in page that moved there by redirect) gets nothing;
 *   3. a page whose own origin is not the tab's address (a sandboxed document, origin "null") gets nothing: the
 *      page itself checks, not only the tab's address;
 *   4. an embedded frame's ref, a field of the wrong kind and an unknown origin are refused, typing nothing;
 *   5. a drawn SVG button and a link styled `display: contents` are read as shown, and a `display: none` one
 *      still as hidden.
 * Run: npm run test:browser. FOXL_EXTENSION_DIR=<0.12.0's tree> is the red run (no `fill_sign_in`, and 5 reads the
 * two drawn controls as hidden).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const USER = 'fixture-user-7f3a';
const PASS = 'Fixture-Pass-91c2-xq';

const LOGIN = `<!doctype html><html><head><title>Example Bank - Sign in</title></head><body>
<h1>Sign in to Example Bank</h1>
<form id="signin" action="/dashboard" method="post">
  <label>Username <input id="user" name="user" type="text" autocomplete="username"></label>
  <label>Password <input id="pass" name="pass" type="password" autocomplete="current-password"></label>
  <label>Remember me <input id="remember" type="checkbox"></label>
  <button type="submit">Sign in</button>
</form>
</body></html>`;

const DRAWN = `<!doctype html><html><head><title>Example Bank - Pay</title></head><body>
<h1>Pay a bill</h1>
<svg role="button" aria-label="Pay now" width="160" height="48" viewBox="0 0 160 48"><rect width="160" height="48" rx="8" fill="#1155cc"></rect></svg>
<a aria-label="Send money" href="/send" style="display:contents"><span style="display:inline-block;width:40px;height:40px;background:#2e7d5b"></span></a>
<a aria-label="Transfer money" href="/transfer" style="display:none"><span>Transfer money</span></a>
</body></html>`;

let ext;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/login': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN); },
      '/sandboxed-login': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'sandbox allow-forms allow-scripts' });
        res.end(LOGIN);
      },
      '/drawn': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(DRAWN); },
    },
  });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const lineOf = (text, needle) => text.split('\n').find((line) => line.includes(needle)) ?? '';
const refOf = (line) => /\[(ref_[^\]\s]+)\]/.exec(line)?.[1] ?? null;
/** Neither value anywhere in what the extension answered. */
const carriesNoValue = (answer, what) => {
  const text = JSON.stringify(answer);
  assert.ok(!text.includes(USER) && !text.includes(PASS), `${what} carries no value: ${text}`);
};
async function signInPage(url) {
  const page = await ext.context.newPage();
  await page.goto(url);
  const tabId = await ext.tabIdOf(page);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  // The inputs by their own lines (a label's line comes first and carries the words).
  const user = refOf(lineOf(tree.data.pageContent, 'type="text"'));
  const pass = refOf(lineOf(tree.data.pageContent, 'type="password"'));
  return { page, tabId, user, pass, tree: tree.data.pageContent };
}

test('the build announces fill-sign-in', () => {
  assert.ok((ext.announced.capabilities ?? []).includes('fill-sign-in'), JSON.stringify(ext.announced));
});

test('1. the saved username and password go into the page they were saved for, and no answer or storage keeps them', async () => {
  const { page, tabId, user, pass, tree } = await signInPage(`${ext.origin}/login`);
  assert.ok(user && pass, `CONTROL: both fields have refs: ${tree}`);
  const answer = await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: user, kind: 'username', value: USER }, { refId: pass, kind: 'password', value: PASS }] });
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.deepEqual(answer.filled, [{ refId: user, kind: 'username' }, { refId: pass, kind: 'password' }]);
  carriesNoValue(answer, 'the answer');
  assert.deepEqual(await page.evaluate(() => [document.getElementById('user').value, document.getElementById('pass').value]), [USER, PASS], 'the page holds both');
  const [worker] = ext.context.serviceWorkers();
  const stored = await worker.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]));
  assert.ok(!stored.includes(USER) && !stored.includes(PASS), `the extension's storage keeps neither: ${stored}`);
  await page.close();
});

test('2. a sign-in page on another origin (moved there by redirect) gets nothing', async () => {
  const other = ext.origin.replace('localhost', '127.0.0.1');
  assert.notEqual(other, ext.origin, 'CONTROL: two origins on one server');
  const { page, tabId, user, pass } = await signInPage(`${other}/login`);
  const answer = await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: user, kind: 'username', value: USER }, { refId: pass, kind: 'password', value: PASS }] });
  assert.equal(answer.success, false, JSON.stringify(answer));
  assert.equal(answer.refused, 'origin');
  carriesNoValue(answer, 'the refusal');
  assert.deepEqual(await page.evaluate(() => [document.getElementById('user').value, document.getElementById('pass').value]), ['', ''], 'nothing typed');
  await page.close();
});

test('3. a page whose own origin is not the tab\'s address gets nothing: the page checks too', async () => {
  const { page, tabId, user, pass, tree } = await signInPage(`${ext.origin}/sandboxed-login`);
  assert.equal(await page.evaluate(() => window.origin), 'null', 'CONTROL: the sandboxed document has an opaque origin (its address still reads as the site)');
  assert.ok(user && pass, `CONTROL: the extension reads the sandboxed page: ${tree}`);
  const answer = await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: user, kind: 'username', value: USER }] });
  assert.equal(answer.success, false, JSON.stringify(answer));
  assert.equal(answer.refused, 'origin');
  carriesNoValue(answer, 'the refusal');
  assert.equal(await page.evaluate(() => document.getElementById('user').value), '', 'nothing typed');
  await page.close();
});

test('4. a frame ref, a field of the wrong kind and a bad origin are refused, typing nothing', async () => {
  const { page, tabId, user, pass } = await signInPage(`${ext.origin}/login`);
  const frame = await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: 'ref_f7_3', kind: 'password', value: PASS }] });
  assert.deepEqual([frame.success, frame.refused], [false, 'frame'], JSON.stringify(frame));
  const wrongKind = await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: user, kind: 'password', value: PASS }] });
  assert.deepEqual([wrongKind.success, wrongKind.refused], [false, 'field'], `a password into a text field: ${JSON.stringify(wrongKind)}`);
  const plain = await ext.command('fill_sign_in', tabId, { expectedOrigin: 'http://example.com', fields: [{ refId: pass, kind: 'password', value: PASS }] });
  assert.equal(plain.success, false, `a non-loopback http origin: ${JSON.stringify(plain)}`);
  for (const [a, what] of [[frame, 'the frame refusal'], [wrongKind, 'the field refusal'], [plain, 'the origin refusal']]) carriesNoValue(a, what);
  assert.deepEqual(await page.evaluate(() => [document.getElementById('user').value, document.getElementById('pass').value]), ['', ''], 'nothing typed');
  await page.close();
});

test('5. a drawn SVG button and a display: contents link are read as shown; a display: none one is still hidden', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/drawn`);
  const tabId = await ext.tabIdOf(page);
  const all = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  const visible = (await ext.command('get_accessibility_tree', tabId, { filter: 'visible' })).data.pageContent;
  for (const name of ['Pay now', 'Send money']) {
    const line = lineOf(all, `"${name}"`);
    assert.ok(line, `CONTROL: the full read lists "${name}": ${all}`);
    assert.doesNotMatch(line, / hidden(\s|$)/, `"${name}" is drawn, so not marked hidden: ${line}`);
    assert.ok(lineOf(visible, `"${name}"`), `the visible read lists "${name}": ${visible}`);
  }
  assert.match(lineOf(all, '"Transfer money"'), / hidden(\s|$)/, 'a display: none link stays hidden');
  assert.equal(lineOf(visible, '"Transfer money"'), '', 'and out of the visible read');
  await page.close();
});
