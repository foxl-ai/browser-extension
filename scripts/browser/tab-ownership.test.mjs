/**
 * FOXL ACTS ONLY IN ITS OWN TABS (foxl-ai/pilot #7802).
 *
 * A command acts only in a tab Foxl opened, a tab in the Foxl group (a person moves one there: the harness's
 * `tabIdOf`), the tab the person sends a message from in Foxl's side panel, and the tabs those open; any other is
 * refused by name with nothing done, and get_tabs names only Foxl's tabs (the others are a count). The person's tab
 * here holds "A private note". Each refusal case,
 * and the listing, is RED on 0.14.0 (main a11298c); the first case and the side
 * panel's are the controls, green on both. The case that would change the tab runs last.
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
