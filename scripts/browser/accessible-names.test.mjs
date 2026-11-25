/**
 * A FIELD IS NAMED BY THE LABEL A PERSON SEES (foxl-ai/pilot #7394).
 *
 * Until this fix the page reader named a field by its `aria-label`, `placeholder`, `title`, `alt` or a `for=` label
 * found by its id, and by nothing else. So `<label>Full name <input></label>`, the most common way a form is written,
 * and a field named by `aria-labelledby` (a design system's form row, a table's column header) reached the model as
 * a bare `textbox`, and the model had to guess which field was which. The first three cases below are RED on 0.14.2
 * (main 4dfced7); the `for=` label, the aria-label over a label and the unlabelled field are the controls, the same
 * on both. The last case asks Chrome itself (its accessibility tree over CDP) for every field's name and finds the
 * same name in the read, so it is RED on 0.14.2 too.
 *
 * What names a field now, in Chrome's order: `aria-labelledby` (each id in order, looked up in the field's own root,
 * then the document), then `aria-label` as before, then the field's labels (`element.labels`: a wrapping label and a
 * `for=` one, in an open shadow root too). Text that is only whitespace names nothing, and the next source is read.
 * A label's text never carries a field's value: a password typed into the field inside a label is never part of any
 * line.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs), driven over the desktop's own `browser_command`
 * protocol. Run: npm run test:browser. FOXL_EXTENSION_DIR=<a tree> runs it against that build (the red run).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const PASSWORD = 'correct-horse-battery-7394';
const PAGE = `<!doctype html><html><head><title>Example Shop - Checkout</title></head><body>
<main>
  <h1>Checkout</h1>
  <form id="details">
    <label>Full name <input name="name" autocomplete="name"></label>
    <label>Account password <input name="password" type="password" value="${PASSWORD}"></label>
    <label><input type="checkbox" name="updates" value="yes"> Email me order updates</label>
    <label>Coupon <input name="coupon" aria-label="Discount coupon"></label>
  </form>
  <div role="group" aria-labelledby="ship-heading">
    <span id="ship-heading">Shipping address</span>
    <span id="zip-word">ZIP code</span>
    <input name="zip" type="text" aria-labelledby="ship-heading zip-word">
    <span id="blank-word">   </span>
    <input name="promo" aria-labelledby="blank-word" aria-label="Promo code">
  </div>
  <label for="email">Email for receipts</label>
  <input id="email" name="email" type="email">
  <label for="gift">Gift note</label>
  <input id="gift" name="gift" aria-label="Message on the gift card">
  <pay-card>
    <template shadowrootmode="open">
      <label>Card number <input name="card" inputmode="numeric"></label>
      <span id="cvc-word">Security code</span>
      <input name="cvc" aria-labelledby="cvc-word">
    </template>
  </pay-card>
  <input name="nickname" type="url">
</main>
</body></html>`;

let ext;
let page;
let text;
before(async () => {
  ext = await launchExtension({ routes: { '/checkout': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); } } });
  page = await ext.context.newPage();
  await page.goto(`${ext.origin}/checkout`);
  const tabId = await ext.tabIdOf(page);
  const tree = await ext.command('get_accessibility_tree', tabId, { filter: 'all' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  text = tree.data.pageContent;
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

test('a field inside its <label> is named by that label, and a password field never by its value', () => {
  assert.match(text, /^\s*textbox "Full name" \[ref_\d+\]/m, text);
  assert.match(text, /^\s*textbox "Account password" \[ref_\d+\] type="password"$/m, text);
  assert.ok(!text.includes(PASSWORD), `the password is part of the read:\n${text}`);
  // A checkbox was named by its value ("yes") through 0.14.2: it is the label the person ticks.
  assert.match(text, /^\s*checkbox "Email me order updates" \[ref_\d+\] type="checkbox" checked=false$/m, text);
});

test('aria-labelledby names a field by each id in order; one that names nothing falls through', () => {
  assert.match(text, /^\s*textbox "Shipping address ZIP code" \[ref_\d+\] type="text"/m, text);
  assert.match(text, /^\s*textbox "Promo code" \[ref_\d+\]/m, text);
});

test('a field in an open shadow root is named by a label in that root', () => {
  assert.match(text, /^\s*textbox "Card number" \[ref_\d+\]/m, text);
  assert.match(text, /^\s*textbox "Security code" \[ref_\d+\]/m, text);
});

test('a for= label still names its field (control)', () => {
  assert.match(text, /^\s*textbox "Email for receipts" \[ref_\d+\] type="email"/m, text);
});

test('a field nothing names stays unnamed (control)', () => {
  assert.match(text, /^\s*textbox \[ref_\d+\] type="url" value=""$/m, text);
});

test('a field with an aria-label keeps it over its label, as 0.14.2 read it (control)', () => {
  assert.match(text, /^\s*textbox "Discount coupon" \[ref_\d+\]/m, text);
  assert.match(text, /^\s*textbox "Message on the gift card" \[ref_\d+\]/m, text);
});

/** Chrome's own name for a field: its accessibility tree over CDP (Accessibility.getPartialAXTree on the element). */
async function chromeName(cdp, selector, host) {
  const expression = host
    ? `document.querySelector(${JSON.stringify(host)}).shadowRoot.querySelector(${JSON.stringify(selector)})`
    : `document.querySelector(${JSON.stringify(selector)})`;
  const { result } = await cdp.send('Runtime.evaluate', { expression });
  assert.ok(result?.objectId, `${selector} is on the page`);
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
  return nodes[0]?.name?.value ?? '';
}
const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('every field reads with the name Chrome itself gives it', async () => {
  const cdp = await ext.context.newCDPSession(page);
  try {
    const fields = [
      ['textbox', 'input[name="name"]'], ['textbox', 'input[name="password"]'], ['checkbox', 'input[name="updates"]'],
      ['textbox', 'input[name="coupon"]'], ['textbox', 'input[name="zip"]'], ['textbox', 'input[name="promo"]'],
      ['textbox', 'input[name="email"]'], ['textbox', 'input[name="gift"]'],
      ['textbox', 'input[name="card"]', 'pay-card'], ['textbox', 'input[name="cvc"]', 'pay-card'],
    ];
    for (const [role, selector, host] of fields) {
      const name = await chromeName(cdp, selector, host);
      console.log(`Chrome names ${host ? `${host} ` : ''}${selector}: ${JSON.stringify(name)}`);
      assert.ok(name.trim(), `Chrome gives ${selector} a name`);
      assert.match(text, new RegExp(`^\\s*${role} ${escaped(JSON.stringify(name))} \\[ref_\\d+\\]`, 'm'), `${selector}: Chrome names it ${JSON.stringify(name)}\n${text}`);
    }
    assert.equal(await chromeName(cdp, 'input[name="nickname"]'), '', 'Chrome gives the unlabelled field no name either');
  } finally {
    await cdp.detach();
  }
});
