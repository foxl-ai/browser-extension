/**
 * WHAT A SAVED SIGN-IN TYPED STAYS OUT OF EVERY LATER ANSWER (0.12.1 review): the step that sends it and a later read.
 *
 * A sign-in on two pages (a user ID first, then the password; a one-time code alone) has no password field, and a bank
 * often turns autocomplete off, so neither of the step watch's other lines knows it is a sign-in. Since 0.12.0 the step
 * watch reads `__foxlFilledFields` (step-watch.js `describe`) to leave such a form undescribed, and `fill_sign_in` keeps
 * the fields it typed into there. Without that mark:
 *   1. the Enter the desktop presses after the fill (`press_key` on the field) and a click on Next answered with the form's
 *      description, `step.submitted.summary` "userid: <the saved username>" (and "otp: <the code>"), which the desktop
 *      records and quotes back in NOT_SENT_AGAIN; and the same step again in that chat was HELD as a second filing;
 *   2. a later read of an unlabeled field named it by what the fill typed (`textbox "<the username>"`), outside the
 *      `value="..."` that the desktop masks on the filled refs.
 * The real extension in Chromium (scripts/browser/harness.mjs), a fictional local bank. Run: npm run test:browser.
 * Red on d16a9a0 (the mark is missing).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const USER = 'fixture-user-2b7c';
const PASS = 'Fixture-Pass-5e1d-kv';
const CODE = '604917';
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const posts = { user: 0, code: 0 };

let ext;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/user-step': (req, res) => html(res, `<!doctype html><title>Sign in</title><h1>Sign in to Example Bank</h1>
<form method="post" action="/user-step/next"><label for="u">User ID</label><input id="u" name="userid" type="text" autocomplete="off"><button type="submit">Next</button></form>`),
      '/user-step/next': (req, res) => { req.resume(); posts.user += 1; setTimeout(() => html(res, '<!doctype html><title>Password</title><h1>Enter your password</h1>'), 200); },
      '/code-step': (req, res) => html(res, `<!doctype html><title>Verify</title><h1>Enter the code we sent</h1>
<form method="post" action="/code-step/verify"><label for="c">Code</label><input id="c" name="otp" type="text" inputmode="numeric"><button type="submit">Verify</button></form>`),
      '/code-step/verify': (req, res) => { req.resume(); posts.code += 1; setTimeout(() => html(res, '<!doctype html><title>Verified</title><h1>Verified</h1>'), 200); },
      '/unlabeled': (req, res) => html(res, `<!doctype html><title>Sign in</title><h1>Sign in</h1><form method="post" action="/x" onsubmit="return false">
<div>User ID <input name="user" type="text"></div><div>Password <input name="pass" type="password"></div><button type="submit">Sign in</button></form>`),
    },
  });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const refOf = (line) => /\[(ref_\d+)\]/.exec(line ?? '')?.[1] ?? null;
async function open(path) {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}${path}`);
  const tabId = await ext.tabIdOf(page);
  const tree = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  const lines = tree.split('\n');
  return { page, tabId, field: refOf(lines.find((l) => /^\s*textbox/.test(l))), button: refOf(lines.find((l) => /^\s*button/.test(l))) };
}

test('CONTROL: the same user-ID form typed by `type` is described by the step that sends it', async () => {
  const { page, tabId, field, button } = await open('/user-step');
  assert.equal((await ext.command('type', tabId, { refId: field, text: USER })).success, true);
  const click = await ext.command('click', tabId, { refId: button, chat: 'marks-control', hold: [] });
  assert.ok(click.step?.submitted?.summary?.some((l) => l.includes(USER)), `the step watch describes this form: ${JSON.stringify(click.step)}`);
  await page.close();
});

test('1. a user-ID step a saved sign-in typed: its Enter and its click carry no value, and the same step again is sent', async () => {
  const first = await open('/user-step');
  assert.equal((await ext.command('fill_sign_in', first.tabId, { expectedOrigin: ext.origin, fields: [{ refId: first.field, kind: 'username', value: USER }] })).success, true);
  // The desktop's own Enter after the fill (foxl-ai/pilot login-fill-chrome.ts chromeSubmit).
  const enter = await ext.command('press_key', first.tabId, { key: 'Enter', refId: first.field });
  assert.equal(enter.success, true, JSON.stringify(enter));
  assert.ok(!JSON.stringify(enter).includes(USER), `the Enter's answer carries no value: ${JSON.stringify(enter)}`);
  assert.equal(enter.step?.submitted ?? null, null, `the sign-in step is not described: ${JSON.stringify(enter.step)}`);
  await first.page.close();
  // A model's click on Next in its chat, then the same step again in that chat.
  const second = await open('/user-step');
  await ext.command('fill_sign_in', second.tabId, { expectedOrigin: ext.origin, fields: [{ refId: second.field, kind: 'username', value: USER }] });
  const click = await ext.command('click', second.tabId, { refId: second.button, chat: 'marks-chat', hold: [] });
  assert.ok(!JSON.stringify(click).includes(USER), `the click's answer carries no value: ${JSON.stringify(click)}`);
  const recorded = click.step?.submitted?.digest ? [click.step.submitted.digest] : [];
  await second.page.close();
  const third = await open('/user-step');
  await ext.command('fill_sign_in', third.tabId, { expectedOrigin: ext.origin, fields: [{ refId: third.field, kind: 'username', value: USER }] });
  const before = posts.user;
  const again = await ext.command('click', third.tabId, { refId: third.button, chat: 'marks-chat', hold: recorded });
  assert.notEqual(again.step?.settled, 'blocked', `the retry of the sign-in step is not held back: ${JSON.stringify(again.step)}`);
  await third.page.waitForTimeout(300);
  assert.equal(posts.user, before + 1, 'the retry reached the site');
  await third.page.close();
});

test('1b. a one-time code a saved sign-in typed: the Enter that sends it carries no code', async () => {
  const { page, tabId, field } = await open('/code-step');
  assert.equal((await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: field, kind: 'code', value: CODE }] })).success, true);
  const enter = await ext.command('press_key', tabId, { key: 'Enter', refId: field });
  assert.ok(!JSON.stringify(enter).includes(CODE), `the Enter's answer carries no code: ${JSON.stringify(enter)}`);
  assert.equal(enter.step?.submitted ?? null, null, `the code step is not described: ${JSON.stringify(enter.step)}`);
  await page.close();
});

test('2. a later read never names a filled field by what the fill typed', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/unlabeled`);
  const tabId = await ext.tabIdOf(page);
  const lines = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent.split('\n');
  const user = refOf(lines.find((l) => /^\s*textbox/.test(l) && /type="text"/.test(l)));
  const pass = refOf(lines.find((l) => /^\s*textbox/.test(l) && /type="password"/.test(l)));
  assert.equal((await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: user, kind: 'username', value: USER }, { refId: pass, kind: 'password', value: PASS }] })).success, true);
  for (const filter of ['all', 'visible', 'interactive']) {
    const text = (await ext.command('get_accessibility_tree', tabId, { filter })).data.pageContent;
    assert.ok(!text.includes(PASS), `no password in the ${filter} read`);
    // The field's value stays in `value="..."`, which the desktop shows as filled-by-foxl on the filled refs.
    const outsideValues = text.replace(/\bvalue="(?:[^"\\]|\\.)*"/g, 'value=""');
    assert.ok(!outsideValues.includes(USER), `the ${filter} read names no field by the username: ${text.split('\n').find((l) => l.includes(`[${user}]`))}`);
  }
  await page.close();
});
