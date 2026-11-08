/**
 * WHAT A `display: contents` ELEMENT DRAWS, ON EVERY PAGE (0.12.1 review of the drawn-box change).
 *
 * 0.12.1 measures a `display: contents` element by the boxes of what it contains. Three things that measure had to hold
 * on ordinary pages, each RED on d16a9a0:
 *   1. a page whose content sits in one `<div style="display: contents">` (SvelteKit's default app.html) reads, however
 *      long: the wrapper's measure spread every text run of the page into Math.min, and 135,000 of them (a 45,000-row
 *      table) threw "Maximum call stack size exceeded", which failed the whole visible and interactive read;
 *   2. a click on such a link sends the pointer events at what it draws, and a hover reaches it: the read lists it as
 *      shown, while the click aimed at its own (empty) box, fell back to `el.click()`, and the hover answered "takes
 *      no space on the page (it is hidden). Take a new snapshot.";
 *   3. one whose only content is `visibility: hidden` draws nothing, so it reads as hidden.
 * The real extension in Chromium (scripts/browser/harness.mjs), local fixture pages. Run: npm run test:browser.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const ROWS = 45_000;
const rows = Array.from({ length: ROWS }, (_, i) => `<tr><td>2026-10-${String((i % 28) + 1).padStart(2, '0')}</td><td>MERCHANT ${i}</td><td><a href="#r${i}">Details</a></td></tr>`).join('');
const ACTIVITY = (wrapped) => `<!doctype html><title>Activity</title><body>${wrapped ? '<div style="display: contents">' : ''}<h1>Activity</h1>
<button type="button">Download account activity</button><table aria-label="Activity"><tbody>${rows}</tbody></table>${wrapped ? '</div>' : ''}</body>`;
const LINKS = `<!doctype html><title>Pay</title><body><h1>Pay a bill</h1>
<a id="send" href="#send" aria-label="Send money" style="display:contents"><span id="send-icon" style="display:inline-block;width:40px;height:40px;background:#2e7d5b"></span></a>
<a id="ghost" href="#ghost" aria-label="Ghost link" style="display:contents"><span style="visibility:hidden;display:inline-block;width:30px;height:30px">x</span></a>
<script>window.seen = [];
for (const type of ['pointerdown', 'mouseover', 'click']) document.addEventListener(type, (e) => window.seen.push(type + ':' + (e.target.id || e.target.tagName.toLowerCase()) + '@' + e.clientX + ',' + e.clientY), true);</script></body>`;

let ext;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/plain': (req, res) => html(res, ACTIVITY(false)),
      '/wrapped': (req, res) => html(res, ACTIVITY(true)),
      '/links': (req, res) => html(res, LINKS),
    },
  });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const lineOf = (text, needle) => text.split('\n').find((line) => line.includes(needle)) ?? '';
const refOf = (line) => /\[(ref_\d+)\]/.exec(line)?.[1] ?? null;

test('1. a long page inside a display: contents wrapper reads, as the same page without it does', async () => {
  for (const path of ['/plain', '/wrapped']) {
    const page = await ext.context.newPage();
    await page.goto(`${ext.origin}${path}`);
    const tabId = await ext.tabIdOf(page);
    for (const filter of ['visible', 'interactive']) {
      const read = await ext.command('get_accessibility_tree', tabId, { filter });
      assert.equal(read.success, true, `${path} ${filter}: ${JSON.stringify(read).slice(0, 300)}`);
      assert.ok(lineOf(read.data.pageContent, '"Download account activity"'), `${path} ${filter} lists the button`);
    }
    await page.close();
  }
});

test('2. a click on a display: contents link aims at what it draws, and a hover reaches it', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/links`);
  const tabId = await ext.tabIdOf(page);
  const box = await page.evaluate(() => { const r = document.getElementById('send-icon').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
  const ref = refOf(lineOf((await ext.command('get_accessibility_tree', tabId, { filter: 'visible' })).data.pageContent, '"Send money"'));
  assert.ok(ref, 'CONTROL: the visible read lists the link as shown');
  const click = await ext.command('click', tabId, { refId: ref });
  assert.equal(click.success, true, JSON.stringify(click));
  assert.equal(click.note, undefined, `the click had a box to aim at: ${JSON.stringify(click)}`);
  const down = (await page.evaluate(() => window.seen.slice())).find((s) => s.startsWith('pointerdown:send@'));
  assert.ok(down, `a pointerdown reached the link: ${JSON.stringify(await page.evaluate(() => window.seen))}`);
  const [x, y] = down.split('@')[1].split(',').map(Number);
  assert.ok(x >= box.left && x <= box.right && y >= box.top && y <= box.bottom, `at the box it draws (${x}, ${y} in ${JSON.stringify(box)})`);
  const hover = await ext.command('hover', tabId, { refId: ref });
  assert.equal(hover.success, true, `the hover reached it: ${JSON.stringify(hover)}`);
  await page.close();
});

test('3. a display: contents link whose content is hidden reads as hidden', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${ext.origin}/links`);
  const tabId = await ext.tabIdOf(page);
  const all = (await ext.command('get_accessibility_tree', tabId, { filter: 'all' })).data.pageContent;
  const visible = (await ext.command('get_accessibility_tree', tabId, { filter: 'visible' })).data.pageContent;
  assert.match(lineOf(all, '"Ghost link"'), / hidden(\s|$)/, `nothing of it is drawn: ${lineOf(all, '"Ghost link"')}`);
  assert.equal(lineOf(visible, '"Ghost link"'), '', 'and it is out of the visible read');
  assert.ok(lineOf(visible, '"Send money"'), 'CONTROL: the drawn one is in it');
  await page.close();
});
