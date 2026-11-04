/**
 * THE EXTENSION'S READS MARK WHAT THEY CUT (#6245, foxl-ai/pilot).
 *
 * Found in a sanitized household-finance case (2026-11-03): every point is a fact of 0.10.0's own
 * code, and each case here is RED on 0.10.0 (main 82afe88):
 *   1. an element's text was cut at 100 characters with no mark (a field's value at 200), so a
 *      5,000-character JSON answer read as complete; `truncated` counted dropped lines only;
 *   2. filter "all" (get_tree's default) listed hidden elements unmarked, so a hidden error
 *      template read like the page's state;
 *   3. nothing reported a download, so a site's "file ready" screen was all the agent saw;
 *   4. nothing reported a pop-up Chrome blocked, or which tab opened which.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs: an unpacked copy, Chrome's pop-up
 * blocker on), against a fictional local site, driven over the desktop's own `browser_command`
 * protocol. Run: npm run test:browser. FOXL_EXTENSION_DIR=<a release's tree> runs it against that
 * build instead (the red run). `downloads` is an optional permission: the shipped build answers
 * "not granted" (3a), and a second launch granted at load checks the receipts (3b).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

// A 150-character label, single-spaced (the mark counts with whitespace collapsed).
const LABEL = 'Monthly household budget summary for the joint checking account, including rent, utilities, groceries, insurance and the car loan due each month'.padEnd(150, '.');
assert.equal(LABEL.length, 150);
// A payroll API's answer, as an authenticated page shows it: one text node, 5,000 characters.
const JSON_5000 = (() => {
  const rows = [];
  for (let i = 0; JSON.stringify({ employer: 'Example Payroll Co', pay: rows }).length < 5000; i++) {
    rows.push({ period: `2026-${String((i % 12) + 1).padStart(2, '0')}`, gross: 4200 + i, net: 3100 + i });
  }
  return JSON.stringify({ employer: 'Example Payroll Co', pay: rows }).slice(0, 4999) + '}';
})();
const VALUE_250 = 'x'.repeat(250);
const CSV = `date,description,amount\n${Array.from({ length: 40 }, (_, i) => `2026-10-${String((i % 28) + 1).padStart(2, '0')},Coffee shop ${i},-${(i + 3) * 1.25}`).join('\n')}\n`;

const PAGE = `<!doctype html><html><head><title>Example Bank - Statements</title></head><body>
<main>
  <h1>Statements</h1>
  <p id="summary">${LABEL}</p>
  <pre id="payroll">${JSON_5000}</pre>
  <label for="memo">Memo</label><input id="memo" value="${VALUE_250}">
  <input id="pin" type="password" value="1234" aria-label="PIN">
  <select id="acct" aria-label="Account"><option value="a">${'Joint checking account ending 4821, opened 2019, statements from January to October '.padEnd(130, '.')}</option><option value="b">Savings</option></select>
  <div id="declined" role="alert" style="display:none">Your card was declined. Call your bank to continue.</div>
  <div aria-hidden="true"><span>Decorative banner for screen readers</span></div>
  <a id="download" href="/files/statement.csv" download>Download October statement</a>
  <a id="broker" href="/broker" target="_blank">Open broker account</a>
</main>
<script>
  // ?popup: the page opens the broker by itself, with no click (so no user activation).
  // Six seconds after load: a navigation leaves the new page a few seconds of user activation, in
  // which Chrome lets a pop-up through (measured: blocked in 2 of 4 runs at 200 ms, 4 of 4 at 6 s).
  if (location.search.includes('popup')) setTimeout(() => { window.__popup = window.open('/broker', 'broker', 'width=400,height=600'); }, 6000);
</script></body></html>`;

let ext;
let page;
let tabId;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/statements': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); },
      '/files/statement.csv': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="statement-2026-10.csv"', 'content-length': Buffer.byteLength(CSV) });
        res.end(CSV);
      },
      '/broker': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Broker</title><h1>Broker sign-in</h1>'); },
    },
  });
  page = await ext.context.newPage();
  await page.goto(`${ext.origin}/statements`);
  tabId = await ext.tabIdOf(page);
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const lineOf = (text, needle) => text.split('\n').find((line) => line.includes(needle)) ?? '';
const refOf = (line) => /\[(ref_[^\]\s]+)\]/.exec(line)?.[1] ?? null;

test('the build announces what it can do beyond its version', () => {
  assert.deepEqual([...(ext.announced.capabilities ?? [])].sort(), ['downloads', 'read-marks', 'read-text', 'tab-openers'],
    `extension_connected: ${JSON.stringify(ext.announced)}`);
});

test('1. a cut element text is marked, counted and listed (get_tree and snapshot)', async () => {
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  assert.equal(tree.success, true, JSON.stringify(tree));
  const text = tree.data.pageContent;
  const summary = lineOf(text, 'Monthly household budget');
  assert.match(summary, / clipped=100\/150(\s|$)/, `the 150-character text is marked: ${summary}`);
  assert.match(summary, /"Monthly household budget[^"]*…"/, `and its shown text ends on an ellipsis: ${summary}`);
  const payroll = lineOf(text, 'Example Payroll Co');
  assert.match(payroll, / clipped=100\/5000(\s|$)/, `the 5,000-character JSON is marked: ${payroll}`);
  const memo = lineOf(text, 'value="xxxx');
  assert.match(memo, / clipped_value=200\/250(\s|$)/, `a 250-character value is marked: ${memo}`);
  const option = lineOf(text, 'Joint checking account ending 4821');
  assert.match(option, / clipped=100\/130(\s|$)/, `a long option is marked: ${option}`);
  assert.equal(tree.data.readMarks, 1);
  const clipped = tree.data.clippedElements;
  assert.ok(clipped.some((c) => c.ref === refOf(payroll) && c.field === 'name' && c.chars === 100 && c.totalChars === 5000), JSON.stringify(clipped));
  assert.ok(clipped.some((c) => c.ref === refOf(memo) && c.field === 'value' && c.totalChars === 250), JSON.stringify(clipped));
  // Short text is not marked.
  assert.doesNotMatch(lineOf(text, '"Statements"'), /clipped/);

  const snap = await ext.command('get_accessibility_tree', tabId, { snapshot: true, filter: 'all' });
  assert.equal(snap.success, true, JSON.stringify(snap));
  assert.equal(snap.readMarks, 1);
  assert.ok(snap.clippedElements.some((c) => c.totalChars === 5000), JSON.stringify(snap.clippedElements));
  assert.match(lineOf(snap.pageContent, 'Example Payroll Co'), / clipped=100\/5000/);
});

test('1. read_text reads one element\'s whole text by ref, a slice at a time, exactly', async () => {
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  const ref = refOf(lineOf(tree.data.pageContent, 'Example Payroll Co'));
  let offset = 0;
  let whole = '';
  for (let i = 0; i < 10 && offset !== null; i++) {
    const part = await ext.command('read_text', tabId, { refId: ref, offset, maxChars: 2000 });
    assert.equal(part.success, true, JSON.stringify(part));
    assert.equal(part.totalChars, JSON_5000.length);
    assert.ok(part.returnedChars <= 2000);
    whole += part.text;
    offset = part.nextOffset;
  }
  assert.equal(whole, JSON_5000, 'the slices put together are the page\'s text, character for character');
  const pin = refOf(lineOf(tree.data.pageContent, '"PIN"'));
  const refused = await ext.command('read_text', tabId, { refId: pin });
  assert.equal(refused.success, false, `a password field is never read: ${JSON.stringify(refused)}`);
});

test('2. under filter "all" a hidden element is marked; "visible" leaves it out', async () => {
  const all = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  const declined = lineOf(all.data.pageContent, 'Your card was declined');
  assert.match(declined, / hidden(\s|$)/, `the hidden error template is marked: ${declined}`);
  const banner = lineOf(all.data.pageContent, 'Decorative banner');
  assert.match(banner, / aria-hidden(\s|$)/, `an aria-hidden subtree is marked: ${banner}`);
  assert.doesNotMatch(lineOf(all.data.pageContent, 'Download October statement'), / hidden/, 'a shown element is not');
  assert.ok(all.data.hiddenElements >= 2, `counted: ${all.data.hiddenElements}`);
  const visible = await ext.command('get_accessibility_tree', tabId, { filter: 'visible' });
  assert.equal(lineOf(visible.data.pageContent, 'Your card was declined'), '', 'the control: "visible" does not list it');
});

const ROUTES = () => ({
  '/statements': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); },
  '/files/statement.csv': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="statement-2026-10.csv"', 'content-length': Buffer.byteLength(CSV) });
    res.end(CSV);
  },
});

test('3a. downloads is optional: without the grant get_downloads says so, and the rest reads as before', async () => {
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'manifest.json'), 'utf8'));
  assert.ok((manifest.optional_permissions ?? []).includes('downloads') && !(manifest.permissions ?? []).includes('downloads'),
    'the shipped manifest asks for downloads only when the person allows it');
  const answer = await ext.command('get_downloads', null, { tabId });
  assert.equal(answer.success, false, JSON.stringify(answer));
  assert.equal(answer.granted, false);
  assert.match(answer.error, /options/);
  const read = await ext.command('get_accessibility_tree', tabId, { snapshot: true, filter: 'visible' });
  assert.equal(read.success, true);
  assert.equal(read.downloads, undefined, 'a read carries no downloads');
});

test('3b. granted: a download the task tab starts comes back as a receipt; one from another site does not', async (t) => {
  const granted = await launchExtension({ routes: ROUTES(), grant: ['downloads'] });
  t.after(() => granted.close());
  const page = await granted.context.newPage();
  await page.goto(`${granted.origin}/statements`);
  const tabId = await granted.tabIdOf(page);
  const ext = granted;
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' });
  const link = refOf(lineOf(tree.data.pageContent, 'Download October statement'));
  // Playwright saves a download under a name of its own; the receipt must name the file Chrome wrote.
  const saved = page.waitForEvent('download');
  const clicked = await ext.command('click', tabId, { refId: link });
  assert.equal(clicked.success, true, JSON.stringify(clicked));
  const savedName = basename(await (await saved).path());
  let receipt = null;
  for (let i = 0; i < 60 && !(receipt && receipt.state === 'complete'); i++) {
    const listed = await ext.command('get_downloads', null, { tabId });
    assert.equal(listed.success, true, JSON.stringify(listed));
    receipt = listed.downloads.find((d) => d.source?.endsWith('/files/statement.csv')) ?? null;
    if (!(receipt && receipt.state === 'complete')) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(receipt, 'the download is listed');
  assert.equal(receipt.state, 'complete', JSON.stringify(receipt));
  assert.equal(receipt.tabId, tabId);
  assert.equal(receipt.file, savedName, `the name of the file Chrome wrote, never its folder: ${JSON.stringify(receipt)}`);
  assert.doesNotMatch(receipt.file, /[\\/]/);
  assert.equal(receipt.bytesReceived, Buffer.byteLength(CSV));
  assert.equal(receipt.error, null);
  const reread = await ext.command('get_accessibility_tree', tabId, { snapshot: true, filter: 'visible' });
  assert.ok(reread.downloads?.some((d) => d.id === receipt.id && d.state === 'complete'), `the next read of the tab carries it: ${JSON.stringify(reread.downloads)}`);

  // A tab Foxl never acted in, on another site: its download is the person's, not Foxl's to report.
  const other = await ext.context.newPage();
  await other.goto(`${ext.origin.replace('localhost', '127.0.0.1')}/statements`);
  const before = (await ext.command('get_downloads', null, {})).downloads.length;
  const [download] = await Promise.all([other.waitForEvent('download'), other.click('#download')]);
  await download.path();
  await new Promise((r) => setTimeout(r, 500));
  const afterList = (await ext.command('get_downloads', null, {})).downloads;
  assert.equal(afterList.length, before, `the person's own download is not listed: ${JSON.stringify(afterList)}`);
  await other.close();
});

test('4. a pop-up Chrome blocked is reported with the page; an opened tab names its opener', async () => {
  // The page opens a pop-up with no user activation: Chrome's pop-up blocker refuses it, and the page gets null.
  await page.goto(`${ext.origin}/statements?popup`);
  await page.waitForFunction(() => '__popup' in window, null, { timeout: 15_000 });
  assert.equal(await page.evaluate(() => window.__popup), null, 'the control: Chrome blocked the pop-up');
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'visible' });
  const blocked = tree.data.blockedPopups ?? [];
  assert.ok(blocked.some((b) => b.url === `${ext.origin}/broker`), `the blocked pop-up is listed: ${JSON.stringify(blocked)}`);
  const snap = await ext.command('get_accessibility_tree', tabId, { snapshot: true, filter: 'visible' });
  assert.ok((snap.blockedPopups ?? []).some((b) => b.url === `${ext.origin}/broker`), JSON.stringify(snap.blockedPopups));

  // A person's click opens the broker in a new tab: get_tabs names the tab that opened it.
  const [popup] = await Promise.all([ext.context.waitForEvent('page'), page.click('#broker')]);
  await popup.waitForLoadState();
  const tabs = await ext.command('get_tabs');
  const broker = tabs.tabs.find((t) => t.url === `${ext.origin}/broker`);
  assert.ok(broker, JSON.stringify(tabs));
  assert.equal(broker.openerTabId, tabId, `the opened tab names its opener: ${JSON.stringify(broker)}`);
  const self = tabs.tabs.find((t) => t.id === tabId);
  assert.ok(Object.hasOwn(self, 'openerTabId'), 'every tab carries the field (null when nothing opened it)');
  await popup.close();
});
