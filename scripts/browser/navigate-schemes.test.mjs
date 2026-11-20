/**
 * NAVIGATE AND NEW_TAB OPEN ONLY WEB PAGES (foxl-ai/pilot #7924).
 *
 * Both open only web pages or a blank tab: an http(s) page or about:blank. Anything else is refused by name before
 * a tab is created or changed. Each refusal is
 * RED on 0.14.0 (main a11298c): it opened the page, or answered with Chrome's own error after trying. Navigating a
 * Foxl tab to a web page, and a new tab, work as before.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs). Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const html = (title) => (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
};

let ext;
let taskPage;
let taskTab;
before(async () => {
  ext = await launchExtension({ routes: { '/task': html('Task page'), '/next': html('Next page'), '/opened': html('Opened page') } });
  taskPage = await ext.context.newPage();
  await taskPage.goto(`${ext.origin}/task`);
  taskTab = await ext.tabIdOf(taskPage);
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const NOT_WEB = [
  'file:///etc/hosts',
  'data:text/html,<h1>not a web page</h1>',
  'chrome://version/',
  'view-source:http://localhost/',
  'blob:http://localhost/0d6c3c53-1b4a-4d5c-9a43-3a1b0c7b1e0f',
  'next',
];
const tabCount = async () => (await ext.command('get_tabs')).tabs.length;

test('navigate refuses an address that is not a web page, by name, and the tab stays where it was', async () => {
  for (const url of NOT_WEB) {
    const answer = await ext.command('navigate', taskTab, { url });
    assert.equal(answer?.success, false, `${url}: ${JSON.stringify(answer)}`);
    assert.equal(answer.nothingWasDone, true, `${url}: ${JSON.stringify(answer)}`);
    assert.match(String(answer.error), /Foxl opens only http:\/\/ and https:\/\/ pages/, `${url}: ${JSON.stringify(answer)}`);
    assert.equal(taskPage.url(), `${ext.origin}/task`, url);
  }
});

test('new_tab refuses the same addresses and opens nothing', async () => {
  const before = await tabCount();
  for (const url of NOT_WEB) {
    const answer = await ext.command('new_tab', undefined, { url });
    assert.equal(answer?.success, false, `${url}: ${JSON.stringify(answer)}`);
    assert.match(String(answer.error), /Foxl opens only http:\/\/ and https:\/\/ pages/, `${url}: ${JSON.stringify(answer)}`);
  }
  assert.equal(await tabCount(), before, 'a tab was opened');
});

test('a Foxl tab navigates to a web page, and new_tab opens one, as before', async () => {
  const moved = await ext.command('navigate', taskTab, { url: `${ext.origin}/next` });
  assert.equal(moved?.success, true, JSON.stringify(moved));
  await taskPage.waitForURL(`${ext.origin}/next`);
  const before = await tabCount();
  const opened = await ext.command('new_tab', undefined, { url: `${ext.origin}/opened` });
  assert.equal(opened?.success, true, JSON.stringify(opened));
  assert.equal(await tabCount(), before + 1);
  const blank = await ext.command('new_tab', undefined, {});
  assert.equal(blank?.success, true, JSON.stringify(blank));
});
