/**
 * NO WEB PAGE CAN LOAD THE EXTENSION'S FILES (foxl-ai/pilot #7928).
 *
 * No file of the extension is web-accessible: the content scripts are injected by the manifest itself, so nothing
 * needs such an entry. Here a page on the test site tries to load those
 * files (and the manifest) by the extension's id, and every attempt fails; the page reader still answers, which is
 * the content script the manifest injects.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs). Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build (the red run: 0.14.0, main a11298c).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const PAGE = '<!doctype html><html><head><title>Example Shop</title></head><body><h1>Example Shop</h1><button id="buy">Add to cart</button></body></html>';
const FILES = ['src/content-scripts/accessibility-tree.js', 'src/content-scripts/visual-indicator.js', 'src/service-worker.js', 'manifest.json'];

let ext;
let page;
before(async () => {
  ext = await launchExtension({
    routes: { '/shop': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); } },
  });
  page = await ext.context.newPage();
  await page.goto(`${ext.origin}/shop`);
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

test('a page cannot fetch or load the extension\'s files by its id', async () => {
  for (const file of FILES) {
    const url = `chrome-extension://${ext.extensionId}/${file}`;
    const fetched = await page.evaluate(async (u) => {
      try {
        const res = await fetch(u);
        return { status: res.status, bytes: (await res.text()).length };
      } catch (err) {
        return { refused: String(err && err.message || err) };
      }
    }, url);
    assert.ok(fetched.refused, `${file}: a page fetched it (${JSON.stringify(fetched)})`);
    const loaded = await page.evaluate((u) => new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = u;
      s.onload = () => resolve('loaded');
      s.onerror = () => resolve('refused');
      document.head.append(s);
    }), url);
    assert.equal(loaded, 'refused', `${file}: a page loaded it as a script`);
  }
});

test('the page reader the manifest injects still answers', async () => {
  const tabId = await ext.tabIdOf(page);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'interactive' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  assert.match(tree.data.pageContent, /button "Add to cart" \[ref_\d+\]/);
});
