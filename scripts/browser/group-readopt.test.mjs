/**
 * FOXL'S OWN TAB GROUP STAYS FOXL'S AFTER THE EXTENSION UPDATES, KNOWN BY ITS TABS, NEVER BY ITS TITLE (foxl-ai/pilot #8219).
 *
 * 0.14.1 knows its groups by the ids it records in chrome.storage.session, which an update or a browser restart
 * clears, so Foxl's group from before then counted as the person's and a new one piled up each time. At every change
 * of its group Foxl now writes a salted fingerprint of the group's ordered tab addresses to chrome.storage.local, and
 * after an update or a restart a group is Foxl's again only when its tabs give exactly that fingerprint and no other
 * open group gives the same one. Nothing is written into the title.
 *
 * Here an update is played the harness's way (`simulateUpdate`: session storage cleared, the worker stopped and started
 * again with nothing in memory, the tabs and groups kept; checked as a control). After it: Foxl's group is Foxl's, and
 * its next tab joins it (RED on 0.14.1, 56318ff), while the person's own groups named "Foxl" and "Pilot" and a group
 * with Foxl's title and colour copied and other tabs are refused (the controls, green on 0.14.1). Then a second group
 * with exactly Foxl's tabs is made, and after the next update neither group is adopted: Foxl starts a new one. A real
 * update (a new build) and a browser restart cannot be played in this harness; a restart gives a restored group a new
 * id, which the fingerprint does not depend on, but that path is not measured here.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, pred, ms) {
  let v = await read();
  for (const end = Date.now() + ms; !pred(v) && Date.now() < end;) { await sleep(250); v = await read(); }
  return v;
}

let ext;
before(async () => {
  ext = await launchExtension({
    routes: {
      '/flights': html('Example Air - Flights'),
      '/seats': html('Example Air - Seats'),
      '/hotel': html('Example Hotel'),
      '/recipes': html('Recipes'),
      '/news': html('News'),
      '/x': html('Other one'),
      '/y': html('Other two'),
    },
  });
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const refused = (answer, tabId) => {
  assert.equal(answer?.success, false, JSON.stringify(answer));
  assert.equal(answer.notFoxlTab, true, JSON.stringify(answer));
  assert.match(String(answer.error), new RegExp(`Tab ${tabId} is not one of Foxl's tabs`));
};
const worker = () => ext.extensionWorker();

/** Tabs at these paths, opened by "the person or another extension", grouped together under a title (and colour). */
async function groupOf(paths, title, color = null) {
  const allIds = async () => (await worker()).evaluate(() => chrome.tabs.query({}).then((tabs) => tabs.map((t) => t.id)));
  const ids = [];
  for (const path of paths) {
    // By the tab it adds, not by its address: a copy of Foxl's tabs has the same addresses as Foxl's.
    const before = new Set(await allIds());
    const p = await ext.context.newPage();
    await p.goto(`${ext.origin}${path}`);
    const added = (await allIds()).filter((id) => !before.has(id));
    assert.equal(added.length, 1, `opening ${path} added ${JSON.stringify(added)}`);
    ids.push(added[0]);
  }
  const groupId = await (await worker()).evaluate(async ({ ids, title, color }) => {
    const t = await chrome.tabs.get(ids[0]);
    const g = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: t.windowId } });
    await chrome.tabGroups.update(g, color ? { title, color } : { title });
    return g;
  }, { ids, title, color });
  return { groupId, ids };
}

/** The ordered addresses of a group's tabs, as Chrome's tab strip has them. */
const groupUrls = async (groupId) => (await worker()).evaluate(async (g) => (await chrome.tabs.query({ groupId: g })).sort((a, b) => a.index - b.index).map((t) => t.url), groupId);

/** After the last change to Foxl's group, its fingerprint is written (on a build that writes one). */
async function settle() {
  await until(async () => (await (await worker()).evaluate(() => chrome.storage.local.get('foxlGroupPrints'))).foxlGroupPrints?.length ?? 0, (n) => n > 0, 3_000);
  await sleep(1_500);
}

/** The extension reloads, as on an update; session storage is cleared (CONTROL: the reload is what an update does). */
async function update() {
  await (await worker()).evaluate(() => { globalThis.__harnessBeforeUpdate = true; });
  const w = await ext.simulateUpdate();
  assert.equal(await w.evaluate(() => globalThis.__harnessBeforeUpdate ?? null), null, 'the worker kept its memory through the update');
  const session = await w.evaluate(() => chrome.storage.session.get('foxlGroupIds'));
  assert.equal(session.foxlGroupIds, undefined, `the record of Foxl's groups is still there: ${JSON.stringify(session)}`);
}

let foxl;
let flights;
let seats;
test('after an update, Foxl\'s own group is Foxl\'s again, and its next tab joins it; the person\'s groups and a copied title are refused', async () => {
  flights = await ext.command('new_tab', undefined, { url: `${ext.origin}/flights` });
  seats = await ext.command('new_tab', undefined, { url: `${ext.origin}/seats` });
  assert.equal(flights?.success, true, JSON.stringify(flights));
  assert.equal(seats?.groupId, flights.groupId, JSON.stringify(seats));
  foxl = flights.groupId;
  const ownFoxl = await groupOf(['/recipes'], 'Foxl');
  const ownPilot = await groupOf(['/news'], 'Pilot');
  const copied = await groupOf(['/x', '/y'], 'Foxl', 'cyan');
  await settle();
  await update();

  // Chrome puts no new content script into a page opened before an update, so the tab is asked about first (Chrome's
  // own answer), then moved (which loads a page with them), then read.
  const info = await ext.command('get_page_info', flights.tabId, {});
  assert.equal(info?.success, true, `Foxl's own tab is refused after the update: ${JSON.stringify(info)}`);
  assert.equal(info.info.title, 'Example Air - Flights', JSON.stringify(info));
  const moved = await ext.command('navigate', flights.tabId, { url: `${ext.origin}/flights?after-update` });
  assert.equal(moved?.success, true, JSON.stringify(moved));
  const tree = await ext.command('get_accessibility_tree', flights.tabId, { filter: 'all' });
  assert.equal(tree?.success, true, JSON.stringify(tree));
  assert.match(tree.data.pageContent, /heading "Example Air - Flights"/);
  const tabs = await ext.command('get_tabs');
  const listed = new Set(tabs.tabs.map((t) => t.id));
  assert.ok(listed.has(flights.tabId) && listed.has(seats.tabId), `Foxl's tabs are not listed: ${JSON.stringify(tabs)}`);
  for (const id of [...ownFoxl.ids, ...ownPilot.ids, ...copied.ids]) {
    assert.ok(!listed.has(id), `tab ${id} of another group is listed: ${JSON.stringify(tabs)}`);
    refused(await ext.command('get_page_info', id, {}), id);
  }
  const hotel = await ext.command('new_tab', undefined, { url: `${ext.origin}/hotel` });
  assert.equal(hotel?.success, true, JSON.stringify(hotel));
  assert.equal(hotel.groupId, foxl, `Foxl started a new group instead of its own: ${JSON.stringify(hotel)}`);
});

test('a second group with exactly Foxl\'s tabs: after the next update neither is adopted, and Foxl starts a new group', async () => {
  assert.ok(Number.isInteger(foxl), 'the first case did not run');
  const urls = await groupUrls(foxl);
  assert.ok(urls.length >= 2, JSON.stringify(urls));
  const copy = await groupOf(urls.map((u) => { const at = new URL(u); return at.pathname + at.search; }), 'Foxl', 'cyan');
  assert.deepEqual(await groupUrls(copy.groupId), urls, 'CONTROL: the copy has Foxl\'s tabs in Foxl\'s order');
  await settle();
  await update();
  refused(await ext.command('get_page_info', flights.tabId, {}), flights.tabId);
  for (const id of copy.ids) refused(await ext.command('get_page_info', id, {}), id);
  const next = await ext.command('new_tab', undefined, {});
  assert.equal(next?.success, true, JSON.stringify(next));
  assert.ok(next.groupId !== foxl && next.groupId !== copy.groupId, `Foxl joined a group it could not tell from a copy: ${JSON.stringify(next)}`);
});
