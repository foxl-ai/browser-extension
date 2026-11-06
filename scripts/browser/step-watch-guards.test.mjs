/**
 * WHAT THE STEP WATCH MUST NEVER DO (0.12.0 review of foxl-ai/browser-extension#15). Each case is RED on f5dd34c.
 *
 *   1. A sign-in step the PERSON typed (or Chrome's password manager filled): an email-first page, a one-time code.
 *      Never described, so the address or the code is never in `step` (what the desktop records, and quotes back to the
 *      model in NOT_SENT_AGAIN), and a retry of that step in the same chat is never held back as a second filing. The
 *      rule is the desktop's own (foxl-ai/pilot #6550, DESCRIBE_FORM_SOURCE in 0.10.4-beta.1).
 *   2. After a Foxl click that FAILED (a stale ref), the person's own submit is the person's: not described into the
 *      site's sessionStorage, not reported as this chat's `leftover`, and not stopped when the chat already sent it.
 *      The page used to stay armed for the rest of its 10 s hold window.
 *   3. A page that answers a fetch-sent form with alert(): its timers stop while the dialog is open, so the step's
 *      answer used to wait for the dialog (40 s for a dialog open 40 s, past the desktop's 30 s timeout). It answers
 *      within the service worker's own bound, saying the form was sent.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs), driven over the desktop's browser_command protocol;
 * the person's own typing and clicks are Playwright's (trusted input). Run: npm run test:browser.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const count = { email: 0, otp: 0, note: 0, saved: 0 };
const EMAIL = 'dmitri.volkov@example.com';
const CODE = '482913';
const DIALOG_MS = 14000;
let ext;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/signin-email': (req, res) => html(res, '<!doctype html><title>Sign in</title><h1>Sign in</h1><form method="post" action="/signin-email/next"><label for="em">Email</label><input id="em" name="email" type="email" autocomplete="username"><button type="submit">Next</button></form>'),
      '/signin-email/next': (req, res) => { req.resume(); count.email += 1; setTimeout(() => html(res, '<!doctype html><title>Password</title><h1>Enter your password</h1>'), 300); },
      '/otp': (req, res) => html(res, `<!doctype html><title>Verify</title><h1>Enter the code we sent</h1><form method="post" action="/otp/verify"><input type="hidden" name="email" value="${EMAIL}"><label for="c">Code</label><input id="c" name="code" autocomplete="one-time-code" inputmode="numeric"><button type="submit">Verify</button></form>`),
      '/otp/verify': (req, res) => { req.resume(); count.otp += 1; setTimeout(() => html(res, '<!doctype html><title>Verified</title><h1>Verified</h1>'), 300); },
      '/note': (req, res) => html(res, '<!doctype html><title>Notes</title><h1>Notes</h1><form method="post" action="/note/save"><label for="nt">Note</label><textarea id="nt" name="note"></textarea><button type="submit">Save note</button></form>'),
      '/note/save': (req, res) => { req.resume(); count.note += 1; setTimeout(() => html(res, '<!doctype html><title>Saved</title><h1>Saved</h1><button id="more">More</button>'), 300); },
      // An old admin page: the form goes out with fetch, and the page says so with alert().
      '/settings': (req, res) => html(res, `<!doctype html><title>Settings</title><h1>Account settings</h1><form id="f" method="post" action="/save"><label for="ph">Phone</label><input id="ph" name="phone" type="tel" value="555-0100"><button type="submit">Save</button></form>
<script>document.getElementById('f').addEventListener('submit', async (e) => { e.preventDefault(); await fetch('/save', { method: 'POST', body: new URLSearchParams(new FormData(e.target)) }); alert('Saved!'); });</script>`),
      '/save': (req, res) => { req.resume(); count.saved += 1; setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }, 200); },
    },
  });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const lineOf = (text, needle) => text.split('\n').find((line) => line.includes(needle)) ?? '';
const refOf = (line) => /\[(ref_[^\]\s]+)\]/.exec(line)?.[1] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs = 0;
/** A page in its own tab (a fragment tells same-path tabs apart; it is not part of a form's identity). */
async function openTab(path) {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}${path}#g${++tabs}`);
  const tabId = await ext.tabIdOf(page);
  const text = (await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' })).data.pageContent;
  return { page, tabId, ref: (needle) => refOf(lineOf(text, needle)) };
}
const carries = (value, what) => JSON.stringify(what ?? null).includes(value);

test('1. a sign-in step the person typed is never described, and its retry in the same chat is not held back (RED on f5dd34c)', async () => {
  const first = await openTab('/signin-email');
  await first.page.fill('#em', EMAIL);
  const next1 = await ext.command('click', first.tabId, { refId: first.ref('button "Next"'), hold: [], chat: 'chat-1' });
  assert.equal(count.email, 1, 'the site had the first Next');
  assert.equal(next1.step?.settled, 'answered', `still watched, so the click answers with the page it led to: ${JSON.stringify(next1.step)}`);
  const second = await openTab('/signin-email');
  await second.page.fill('#em', EMAIL);
  // What a desktop would hold: the first step's digest, if it reported one.
  const digest = next1.step?.submitted?.digest;
  const next2 = await ext.command('click', second.tabId, { refId: second.ref('button "Next"'), hold: digest ? [digest] : [], chat: 'chat-1' });
  for (let i = 0; i < 20 && count.email < 2; i++) await sleep(100);
  assert.equal(carries(EMAIL, next1), false, `the step carries the address the person typed: ${JSON.stringify(next1.step?.submitted)}`);
  assert.notEqual(next2.step?.settled, 'blocked', `a sign-in retry is held back as a second filing: ${JSON.stringify(next2.step)}`);
  assert.equal(count.email, 2, 'the retry reached the site');
  await first.page.close(); await second.page.close();
});

test('1b. a one-time code the person typed is never described (RED on f5dd34c)', async () => {
  const tab = await openTab('/otp');
  await tab.page.fill('#c', CODE);
  const verify = await ext.command('click', tab.tabId, { refId: tab.ref('button "Verify"'), hold: [], chat: 'chat-1b' });
  assert.equal(count.otp, 1);
  assert.equal(verify.step?.settled, 'answered', JSON.stringify(verify.step));
  assert.equal(carries(CODE, verify), false, `the step carries the code: ${JSON.stringify(verify.step?.submitted)}`);
  assert.equal(carries(EMAIL, verify), false, `the step carries the form's hidden address: ${JSON.stringify(verify.step?.submitted)}`);
  await tab.page.close();
});

test('2. after a Foxl click that failed, the person\'s own submit is not described, nor reported as this chat\'s (RED on f5dd34c)', async () => {
  const tab = await openTab('/note');
  const failed = await ext.command('click', tab.tabId, { refId: 'ref_stale_999', hold: [], chat: 'chat-2' });
  assert.equal(failed.success, false, 'a stale ref fails');
  await sleep(1500);
  const before = count.note;
  await tab.page.fill('#nt', 'My own note: call Dr. Petrova about the results');
  await tab.page.click('button[type=submit]');
  await tab.page.waitForURL(/\/note\/save/);
  await tab.page.waitForSelector('h1');
  assert.equal(count.note - before, 1, 'the person\'s note reached the site');
  const record = await tab.page.evaluate(() => sessionStorage.getItem('__foxlStepSent'));
  assert.equal(record, null, `the person's own form was described into the site's sessionStorage: ${record}`);
  const next = await ext.command('click', tab.tabId, { refId: (await openRef(tab.tabId, 'button "More"')), hold: [], chat: 'chat-2' });
  assert.equal(next.leftover, undefined, `the person's own form was reported to the desktop as this chat's: ${JSON.stringify(next.leftover)}`);
  await tab.page.close();
});

async function openRef(tabId, needle) {
  const text = (await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' })).data.pageContent;
  return refOf(lineOf(text, needle));
}

test('2b. after a Foxl click that failed, the person\'s own submit of a form the chat already sent is not stopped (RED on f5dd34c)', async () => {
  const a = await openTab('/note');
  await ext.command('type', a.tabId, { refId: a.ref('"Note"'), text: 'Remind me on Friday' });
  const sent = await ext.command('click', a.tabId, { refId: a.ref('button "Save note"'), hold: [], chat: 'chat-2b' });
  const digest = sent.step?.submitted?.digest;
  assert.ok(digest, `Foxl's save is described: ${JSON.stringify(sent.step)}`);
  const b = await openTab('/note');
  await ext.command('type', b.tabId, { refId: b.ref('"Note"'), text: 'Remind me on Friday' });
  const failed = await ext.command('click', b.tabId, { refId: 'ref_stale_998', hold: [digest], chat: 'chat-2b' });
  assert.equal(failed.success, false);
  await sleep(1000);
  const before = count.note;
  await b.page.click('button[type=submit]');
  for (let i = 0; i < 30 && count.note === before; i++) await sleep(100);
  assert.equal(count.note - before, 1, 'the person\'s own submit was stopped');
  await a.page.close(); await b.page.close();
});

test('3. a page that answers with a dialog: the click answers within its bound and says the form was sent (RED on f5dd34c)', async (t) => {
  const tab = await openTab('/settings');
  let dismissed = null;
  // The person has not looked at the tab yet: the dialog stays open DIALOG_MS.
  tab.page.on('dialog', (d) => { dismissed = sleep(DIALOG_MS).then(() => d.dismiss()).catch(() => {}); });
  const started = Date.now();
  let clicked;
  try { clicked = await ext.command('click', tab.tabId, { refId: tab.ref('button "Save"'), hold: [], chat: 'chat-3' }); } catch (err) { clicked = { error: String(err) }; }
  const tookMs = Date.now() - started;
  t.diagnostic(`answered in ${tookMs} ms: ${JSON.stringify(clicked.step ?? clicked)}`);
  assert.equal(count.saved, 1);
  assert.ok(tookMs < 12000, `the answer waited for the dialog: ${tookMs} ms`);
  assert.equal(clicked.step?.settled, 'still_loading', JSON.stringify(clicked));
  assert.ok(clicked.step.submitted?.digest, 'and the form is reported sent, so the same save again is held');
  await dismissed;
  await tab.page.close();
});
