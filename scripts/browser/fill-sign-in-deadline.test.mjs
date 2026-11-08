/**
 * A SAVED SIGN-IN THAT REACHES A STUCK PAGE TOO LATE IS NOT TYPED (0.12.1 review).
 *
 * Every input action has a deadline (src/input-queue.js, 25 s), and the page refuses a message that arrives after it
 * (visual-indicator.js): by then Foxl Desktop has told the model the action failed (foxl-ai/pilot login-fill-chrome.ts
 * waits 20 s for `fill_sign_in`, then answers "nothing was typed"). `fill_sign_in` sent no deadline, so a fill that
 * waited behind a hung script was typed when the page freed up. Measured the same way, `type` is refused there.
 * The real extension in Chromium (scripts/browser/harness.mjs), a fictional local bank whose page runs a 27 s script.
 * About 30 s. Run: npm run test:browser. Red on d16a9a0.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const USER = 'fixture-user-9d40';
const HUNG_MS = 27_000;

let ext;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/login': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Sign in</title><h1>Sign in to Example Bank</h1><form onsubmit="return false"><label for="u">Username</label><input id="u" type="text"></form>');
      },
    },
  });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

test('a fill that reaches the page after its deadline types nothing', { timeout: 90_000 }, async () => {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/login`);
  const tabId = await ext.tabIdOf(page);
  const tree = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  const field = /\[(ref_\d+)\]/.exec(tree.split('\n').find((l) => /^\s*textbox/.test(l)))[1];
  // The page's own script holds the tab past the action's deadline.
  await page.evaluate((ms) => { setTimeout(() => { const t = Date.now(); while (Date.now() - t < ms) { /* hung */ } }, 20); }, HUNG_MS);
  await new Promise((r) => setTimeout(r, 200));
  const answer = await ext.command('fill_sign_in', tabId, { expectedOrigin: ext.origin, fields: [{ refId: field, kind: 'username', value: USER }] })
    .then((a) => a, (e) => ({ gaveUp: String(e.message || e) }));
  assert.ok(answer.gaveUp || answer.success === false, `CONTROL: no fill while the page is stuck: ${JSON.stringify(answer)}`);
  // Once the page is free again (its script ended), and the late message had its turn.
  await page.waitForFunction(() => true, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.getElementById('u').value), '', 'nothing was typed after the deadline');
  await page.close();
});
