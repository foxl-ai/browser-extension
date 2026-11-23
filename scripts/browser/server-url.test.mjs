/**
 * THE EXTENSION TALKS ONLY TO FOXL DESKTOP ON THIS COMPUTER (foxl-ai/pilot #7806).
 *
 * The address must be on this computer: the options page refuses any host but localhost, 127.0.0.1 and [::1] by
 * name, a stored
 * address for another host is ignored (discovery runs, and the options page says the saved address was not used), and
 * a localhost address works as before.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs), whose browser resolves no name but localhost, so the
 * refused address (desktop.example, a reserved name) is never looked up. Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build (the red run: 0.14.0, main a11298c).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const ELSEWHERE = 'http://desktop.example:13847';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, pred, ms) {
  let v = await read();
  for (const end = Date.now() + ms; !pred(v) && Date.now() < end;) { await sleep(300); v = await read(); }
  return v;
}

let ext;
let options;
const status = () => options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' }));
const stored = () => options.evaluate(() => chrome.storage.local.get('serverUrl').then((r) => r.serverUrl ?? null));
async function openOptions() {
  await options.goto(`chrome-extension://${ext.extensionId}/options.html`);
  await options.evaluate(() => { document.getElementById('advancedConnection').open = true; });
}

before(async () => {
  ext = await launchExtension({});
  options = await ext.context.newPage();
  await openOptions();
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

test('the options page refuses an address that is not this computer, by name, and saves nothing', async () => {
  await options.locator('#serverUrl').fill(ELSEWHERE);
  await options.locator('#saveButton').click();
  const message = await options.locator('#serverUrl').evaluate((el) => el.validationMessage);
  assert.match(message, /desktop\.example:13847 is not this computer/, message);
  await sleep(500);
  assert.equal(await stored(), null, 'the refused address was saved');
});

test('a stored address for another host is ignored: discovery runs, the desktop is reached, and the options page says so', async () => {
  // As an earlier build left it.
  await options.evaluate((url) => chrome.storage.local.set({ serverUrl: url }), ELSEWHERE);
  const s = await until(status, (v) => v?.wsConnected === true && v?.serverUrl === ext.desktopOrigin, 20_000);
  assert.equal(s?.serverUrl, ext.desktopOrigin, JSON.stringify(s));
  assert.equal(s.wsConnected, true, JSON.stringify(s));
  assert.equal(s.serverUrlIgnored, true, JSON.stringify(s));
  const tabs = await ext.command('get_tabs');
  assert.ok(Array.isArray(tabs?.tabs), JSON.stringify(tabs));
  await openOptions();
  assert.match(await options.locator('#serverUrlHint').innerText(), /desktop\.example:13847\) is not on this computer, so Foxl did not use it/);
  await options.evaluate(() => chrome.storage.local.remove('serverUrl'));
});

test('a localhost address works as before', async () => {
  await openOptions();
  await options.locator('#serverUrl').fill(ext.desktopOrigin);
  await options.locator('#saveButton').click();
  assert.equal(await until(stored, (v) => v !== null, 5_000), ext.desktopOrigin);
  const s = await until(status, (v) => v?.wsConnected === true && v?.serverUrl === ext.desktopOrigin, 20_000);
  assert.equal(s?.serverUrl, ext.desktopOrigin, JSON.stringify(s));
  assert.notEqual(s.serverUrlIgnored, true);
  const tabs = await ext.command('get_tabs');
  assert.ok(Array.isArray(tabs?.tabs), JSON.stringify(tabs));
  await options.evaluate(() => chrome.storage.local.remove('serverUrl'));
});
