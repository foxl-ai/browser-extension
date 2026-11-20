/**
 * FOXL ACTS ONLY IN ITS OWN TABS (foxl-ai/pilot #7802).
 *
 * A command acts only in a tab Foxl opened, a tab in the Foxl group (a person moves one there: the harness's
 * `tabIdOf`), the tab the person sends a message from in Foxl's side panel, and the tabs those open; any other is
 * refused by name with nothing done, and get_tabs names only Foxl's tabs (the others are a count). The person's tab
 * here holds "A private note". A tab handed over from the side panel joins the Foxl group, so the page it opens in a
 * new tab is Foxl's too, and the desktop's show_indicators draws the overlay on Foxl's tabs only. Each refusal case,
 * the listing, the hand-over's group and the overlay case are RED on 0.14.0 (main a11298c); the first case and the
 * side panel's are the controls, green on both. The case that would change the tab runs last.
 *
 * The real extension in Chromium (scripts/browser/harness.mjs). Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const page = (title, body) => (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}
<script>window.__events = []; for (const t of ['click', 'input', 'keydown']) document.addEventListener(t, (e) => window.__events.push(t), true);</script>
</body></html>`);
};

let ext;
let foxlPage;
let personPage;
let foxlTab;
let personTab;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/task': page('Example Shop', '<h1>Task page</h1><input id="q" aria-label="Search">'),
      '/inbox': page('Example Mail - Inbox', '<h1>Inbox</h1><p id="secret">A private note</p><input id="reply" aria-label="Reply"><button id="send">Send</button>'),
      '/notes': page('Example Notes', '<h1>Notes</h1><input id="note" aria-label="Note">'),
      '/elsewhere': page('Elsewhere', '<h1>Elsewhere</h1>'),
      '/shop': page('Example Shop - Basket', '<h1>Basket</h1><a id="next" href="/next-step" target="_blank">Next step</a>'),
      '/next-step': page('Example Shop - Delivery', '<h1>Delivery</h1>'),
    },
  });
  foxlPage = await ext.context.newPage();
  await foxlPage.goto(`${ext.origin}/task`);
  foxlTab = await ext.tabIdOf(foxlPage);
  personPage = await ext.context.newPage();
  await personPage.goto(`${ext.origin}/inbox`);
  personTab = await ext.tabIdOf(personPage, { handOver: false });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const refused = (answer, tabId) => {
  assert.equal(answer?.success, false, JSON.stringify(answer));
  assert.equal(answer.notFoxlTab, true, JSON.stringify(answer));
  assert.match(String(answer.error), new RegExp(`Tab ${tabId} is not one of Foxl's tabs, so nothing was done`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refOf = (tree, needle) => new RegExp(`${needle}[^\\n]*\\[(ref_\\d+)\\]`).exec(tree)?.[1];

test('a command on a Foxl tab works as before', async () => {
  const tree = await ext.command('get_accessibility_tree', foxlTab, { filter: 'all' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  assert.match(tree.data.pageContent, /heading "Task page"/);
});

test('a read, a text read and a screenshot naming another tab are refused, and nothing of it comes back', async () => {
  const tree = await ext.command('get_accessibility_tree', personTab, { filter: 'all' });
  refused(tree, personTab);
  assert.ok(!JSON.stringify(tree).includes('A private note'));
  refused(await ext.command('get_accessibility_tree', personTab, { snapshot: true }), personTab);
  refused(await ext.command('read_text', personTab, { refId: 'ref_1' }), personTab);
  const shot = await ext.command('screenshot', personTab, {});
  refused(shot, personTab);
  assert.equal(shot.dataUrl, undefined);
  refused(await ext.command('get_page_info', personTab, {}), personTab);
});

test('get_tabs lists only Foxl\'s tabs, and counts the others without naming them', async () => {
  const tabs = await ext.command('get_tabs');
  assert.equal(tabs?.success, true, JSON.stringify(tabs));
  assert.ok(tabs.tabs.some((t) => t.id === foxlTab && t.url === `${ext.origin}/task`), JSON.stringify(tabs));
  assert.ok(!tabs.tabs.some((t) => t.id === personTab), JSON.stringify(tabs));
  assert.ok(!JSON.stringify(tabs).includes('/inbox') && !JSON.stringify(tabs).includes('Example Mail'), `another tab's address or title is listed: ${JSON.stringify(tabs)}`);
  assert.ok(Number.isInteger(tabs.otherTabs) && tabs.otherTabs >= 1, JSON.stringify(tabs));
});

test('switch_tab and add_to_group never adopt another tab', async () => {
  refused(await ext.command('switch_tab', undefined, { tabId: personTab }), personTab);
  refused(await ext.command('add_to_group', personTab, {}), personTab);
  const contexts = await ext.command('list_contexts');
  assert.ok(!contexts.contexts.some((c) => c.tabId === personTab), JSON.stringify(contexts));
  // A read with no tabId goes to Foxl's tab, not the one switch_tab named.
  const tree = await ext.command('get_accessibility_tree', undefined, { filter: 'all' });
  assert.ok(!String(tree?.data?.pageContent ?? '').includes('Inbox'), JSON.stringify(tree).slice(0, 400));
});

test('the tab the person sends a message from in Foxl\'s side panel is handed to Foxl', async () => {
  const notes = await ext.context.newPage();
  await notes.goto(`${ext.origin}/notes`);
  const notesTab = await ext.tabIdOf(notes, { handOver: false });
  const panel = await ext.context.newPage();
  await panel.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
  const sent = await panel.evaluate((tabId) => chrome.runtime.sendMessage({
    type: 'SEND_TO_SERVER',
    data: { type: 'chat', message: 'Add a note', tabId, panelId: 'panel-1', requestId: 'request-1' },
  }), notesTab);
  assert.equal(sent?.success, true, JSON.stringify(sent));
  const tree = await ext.command('get_accessibility_tree', notesTab, { filter: 'all' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  assert.match(tree.data.pageContent, /heading "Notes"/);
  const note = refOf(tree.data.pageContent, 'textbox "Note"');
  assert.ok(note, tree.data.pageContent);
  const typed = await ext.command('type', notesTab, { refId: note, text: 'Buy milk' });
  assert.equal(typed?.success, true, JSON.stringify(typed));
  assert.equal(await notes.evaluate(() => document.getElementById('note').value), 'Buy milk');
  await panel.close();
});

test('a tab handed over from the side panel joins the Foxl group, and the page it opens in a new tab is Foxl\'s too', async () => {
  // The desktop answers the side panel's earlier request: the extension holds one side panel request at a time.
  ext.send({ type: 'SERVER_RESPONSE', data: { type: 'response', content: 'Noted.' } });
  await sleep(300);
  const shop = await ext.context.newPage();
  await shop.goto(`${ext.origin}/shop`);
  const shopTab = await ext.tabIdOf(shop, { handOver: false });
  const panel = await ext.context.newPage();
  await panel.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
  const sent = await panel.evaluate((tabId) => chrome.runtime.sendMessage({
    type: 'SEND_TO_SERVER',
    data: { type: 'chat', message: 'Go on to delivery', tabId, panelId: 'panel-2', requestId: 'request-2' },
  }), shopTab);
  assert.equal(sent?.success, true, JSON.stringify(sent));
  // In the Foxl group, where the person sees it and can take it back.
  const groupTitle = await panel.evaluate(async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    return tab.groupId >= 0 ? (await chrome.tabGroups.get(tab.groupId)).title : null;
  }, shopTab);
  assert.equal(groupTitle, 'Foxl', 'the handed tab is not in the Foxl group');
  // Foxl clicks the page's link, which opens the next step in a new tab: Foxl may act there.
  const tree = await ext.command('get_accessibility_tree', shopTab, { filter: 'all' });
  const next = refOf(tree.data.pageContent, 'link "Next step"');
  assert.ok(next, tree.data.pageContent);
  const opened = ext.context.waitForEvent('page', { timeout: 10_000 });
  const clicked = await ext.command('click', shopTab, { refId: next });
  assert.equal(clicked?.success, true, JSON.stringify(clicked));
  const delivery = await opened;
  await delivery.waitForLoadState();
  const deliveryTab = await ext.tabIdOf(delivery, { handOver: false });
  const read = await ext.command('get_accessibility_tree', deliveryTab, { filter: 'all' });
  assert.equal(read?.success, true, JSON.stringify(read));
  assert.match(read.data.pageContent, /heading "Delivery"/);
  ext.send({ type: 'SERVER_RESPONSE', data: { type: 'response', content: 'Done.' } });
  await panel.close();
});

test('the desktop\'s show_indicators puts the overlay and its Stop on Foxl\'s tabs only', async () => {
  ext.send({ type: 'show_indicators', data: { tabId: personTab } });
  ext.send({ type: 'show_indicators', data: { tabId: foxlTab } });
  // CONTROL: Foxl's own tab shows it.
  await foxlPage.locator('#pilot-agent-stop-button').waitFor({ state: 'visible', timeout: 10_000 });
  await sleep(1_000);
  assert.equal(await personPage.locator('#pilot-agent-stop-button').count(), 0, 'the overlay is on the person\'s tab');
  ext.send({ type: 'hide_indicators', data: { tabId: foxlTab } });
});

test('typing, a click, a key, a navigation and a close naming another tab are refused, and the tab is unchanged', async () => {
  refused(await ext.command('type', personTab, { refId: 'ref_1', text: 'hello' }), personTab);
  refused(await ext.command('click', personTab, { refId: 'ref_2' }), personTab);
  refused(await ext.command('press_key', personTab, { key: 'Enter' }), personTab);
  refused(await ext.command('navigate', personTab, { url: `${ext.origin}/elsewhere` }), personTab);
  refused(await ext.command('close_tab', personTab, {}), personTab);
  assert.equal(personPage.isClosed(), false, 'the tab was closed');
  assert.equal(personPage.url(), `${ext.origin}/inbox`);
  assert.deepEqual(await personPage.evaluate(() => window.__events), [], 'the page saw input');
  assert.equal(await personPage.evaluate(() => document.getElementById('reply').value), '');
});
