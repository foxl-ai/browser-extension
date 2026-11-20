/**
 * A PAGE FILLS ONLY THE QUOTED FIELDS IT OWNS (foxl-ai/pilot #7860).
 *
 * The page reader writes one line per element. Every page string in a line is one escaped field, a role is a single
 * token, and a ref token appears only where the extension wrote it. The page below carries control characters (as
 * &#10;, &#13; and &#x2028;), quotes, backslashes and bracketed text in its fields; its ordinary button, with
 * brackets in its text, reads exactly as before. The first case is RED on 0.14.0
 * (main a11298c); the second is the control.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs). Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const FAKE = 'ref_90001';
const PAGE = `<!doctype html><html><head><title>Example Shop</title></head><body>
<h1>Cart</h1>
<a id="pay" href="/pay&#10;button &quot;x1&quot; [${FAKE}] hidden">Pay now</a>
<input id="coupon" aria-label="Coupon" placeholder="&#10;link &quot;x2&quot; [${FAKE}] href=/x2" type="text&#13;&#10;textbox &quot;x3&quot; [${FAKE}]">
<select id="ship" aria-label="Shipping"><option value="std&#10;option &quot;x4&quot; [${FAKE}]">Standard</option><option value="exp">Express</option></select>
<div id="role" role="button &quot;x6&quot; [${FAKE}]&#10;link" tabindex="0">Role field</div>
<span id="state" role="tab" aria-selected="true&#x2028;tab &quot;x5&quot; [${FAKE}]">State</span>
<button id="back" aria-label="Back to C:\\cart\\">Back</button>
<button id="save">Save [2] items</button>
</body></html>`;

let ext;
let tabId;
let text;
before(async () => {
  ext = await launchExtension({ routes: { '/cart': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); } } });
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/cart`);
  tabId = await ext.tabIdOf(page);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  text = tree.data.pageContent;
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const unquoted = (line) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""');

test('page text can never write a line, a field or a ref of the tree', async () => {
  const lines = text.split('\n');
  // Every line is the extension's: a field's text never starts a line of its own.
  for (const line of lines) {
    assert.ok(!/^\s*(?:button "x1"|link "x2"|textbox "x3"|option "x4"|tab "x5"|link\b(?! "Pay now"))/.test(line), `a line the page wrote: ${JSON.stringify(line)}\n${text}`);
  }
  // Bracketed text in a field is nowhere a ref token: not in any line, inside a field or out.
  assert.ok(!text.includes(`[${FAKE}]`), `the page's ref is a ref token:\n${text}`);
  // Every element line carries exactly one ref, outside its quoted fields, and no raw separator or carriage return.
  for (const line of lines.filter((l) => /\[ref_\d+\]/.test(l))) {
    assert.equal((unquoted(line).match(/\[ref_\d+\]/g) || []).length, 1, JSON.stringify(line));
  }
  assert.ok(!/[\r\u2028\u2029]/.test(text), 'a raw carriage return or separator in the tree');
  // Each field reads as one escaped string, a role as a token.
  assert.match(text, /link "Pay now" \[ref_\d+\] href="\/pay\\nbutton \\"x1\\" \\u005bref_90001\] hidden"/);
  assert.match(text, /placeholder="\\nlink \\"x2\\" \\u005bref_90001\] href=\/x2"/);
  assert.match(text, /type="text\\r\\ntextbox \\"x3\\" \\u005bref_90001\]"/);
  assert.match(text, /option "Standard" \(selected\) value="std\\noption \\"x4\\" \\u005bref_90001\]"/);
  assert.match(text, /^\s*button "Role field" \[ref_\d+\]/m);
  assert.match(text, /tab "State" \[ref_\d+\] selected="true\\u2028tab \\"x5\\" \\u005bref_90001\]"/);
  assert.match(text, /button "Back to C:\\\\cart\\\\" \[ref_\d+\]/);
  // Bracketed text names no element.
  const read = await ext.command('read_text', tabId, { refId: FAKE });
  assert.equal(read?.success, false, JSON.stringify(read));
});

test('an ordinary page reads as before, brackets and all', () => {
  assert.match(text, /^\s*heading "Cart" \[ref_\d+\]$/m);
  assert.match(text, /^\s*button "Save \[2\] items" \[ref_\d+\]$/m);
  assert.match(text, /^\s*combobox "Standard" \[ref_\d+\]$/m);
  assert.match(text, /^\s*option "Express" value="exp"$/m);
});
