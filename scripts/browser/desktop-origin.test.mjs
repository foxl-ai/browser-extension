/**
 * A TAB FOXL WORKS IN NEVER OPENS FOXL DESKTOP'S OWN ADDRESS (foxl-ai/pilot #8212).
 *
 * Desktops up to v0.7.27 put their connection key into the page any `GET /` on their own port loaded, so a Foxl tab
 * steered there would hold that desktop's whole API. `navigate` and `new_tab` refuse an address on this computer on
 * Foxl Desktop's ports (13847, 3847) and on the port of the desktop this extension is connected to, by name, before a
 * tab is created or changed. A Foxl tab that a page sends there anyway (a redirect, a link Foxl clicks) is neither read
 * nor acted in, and the click's answer does not read that page. Another local port (the site's own here, and a dev
 * server's, 5173) opens as before. Every refusal is RED on 0.14.1 (56318ff); the other local ports are the controls.
 *
 * The harness serves the desktop's side and the site on two loopback ports (harness.mjs), and its desktop's `/` stands in
 * for the desktop's app. The cases that name 13847 or 3847 run only where nothing listens there: a red run against an
 * older build would open a real desktop's page otherwise. The real extension in Chromium. Run: npm run test:browser.
 * FOXL_EXTENSION_DIR=<a tree> runs it against that build.
 */
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import { launchExtension } from './harness.mjs';

const html = (title, body = '') => (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`);
};

/** Does anything accept a connection on this port of this computer? */
const listening = (port) => new Promise((resolve) => {
  const s = connect({ host: '127.0.0.1', port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(1000, () => done(false));
});

let ext;
let taskPage;
let taskTab;
let desktopAt = '';
let realDesktopHere = false;
before(async () => {
  realDesktopHere = (await listening(13847)) || (await listening(3847));
  ext = await launchExtension({
    routes: {
      '/task': html('Task page', '<input id="q" aria-label="Search">'),
      '/next': html('Next page'),
      '/bounce': (req, res) => { res.writeHead(302, { location: `${desktopAt}/` }); res.end(); },
      '/links': (req, res) => html('Links', `<a id="go" href="${desktopAt}/">Open the app</a>`)(req, res),
    },
  });
  desktopAt = ext.desktopOrigin.replace('localhost', '127.0.0.1');
  taskPage = await ext.context.newPage();
  await taskPage.goto(`${ext.origin}/task`);
  taskTab = await ext.tabIdOf(taskPage);
}, { timeout: 60_000 });
after(async () => { await ext?.close(); });

const refusedAsDesktop = (answer, what) => {
  assert.equal(answer?.success, false, `${what}: ${JSON.stringify(answer)}`);
  assert.equal(answer.nothingWasDone, true, `${what}: ${JSON.stringify(answer)}`);
  assert.equal(answer.desktopOrigin, true, `${what}: ${JSON.stringify(answer)}`);
  assert.match(String(answer.error), /Foxl Desktop's own address on this computer/, `${what}: ${JSON.stringify(answer)}`);
  assert.ok(!JSON.stringify(answer).includes('Recent chats'), `${what}: the desktop's page was read: ${JSON.stringify(answer)}`);
};
const desktopAddresses = () => [
  ext.desktopOrigin + '/',
  `${desktopAt}/settings`,
  `http://[::1]:${ext.desktopPort}/`,
  `http://foxl.localhost:${ext.desktopPort}/`,
  ...(realDesktopHere ? [] : [
    'http://localhost:13847/',
    'http://127.0.0.1:3847/',
    'http://127.1:13847/',
    'http://0.0.0.0:13847/',
    'http://LOCALHOST.:13847/',
  ]),
];
const tabCount = async () => (await ext.command('get_tabs')).tabs.length;

test('navigate refuses Foxl Desktop\'s own address, by name, and the tab stays where it was', async () => {
  if (realDesktopHere) console.log('# a Foxl Desktop listens on 13847 or 3847 here: the cases naming those ports are left out');
  for (const url of desktopAddresses()) {
    refusedAsDesktop(await ext.command('navigate', taskTab, { url }), url);
    assert.equal(taskPage.url(), `${ext.origin}/task`, url);
  }
});

test('new_tab refuses the same addresses and opens nothing', async () => {
  const before = await tabCount();
  for (const url of desktopAddresses()) refusedAsDesktop(await ext.command('new_tab', undefined, { url }), url);
  assert.equal(await tabCount(), before, 'a tab was opened');
});

test('another local port opens as before: a site on this computer, and a dev server\'s port', async () => {
  const moved = await ext.command('navigate', taskTab, { url: `${ext.origin}/next` });
  assert.equal(moved?.success, true, JSON.stringify(moved));
  await taskPage.waitForURL(`${ext.origin}/next`);
  const dev = await ext.command('new_tab', undefined, { url: 'http://localhost:5173/' });
  assert.equal(dev?.success, true, JSON.stringify(dev));
  assert.notEqual(dev.desktopOrigin, true, JSON.stringify(dev));
  await ext.command('close_tab', dev.tabId, {});
  const back = await ext.command('navigate', taskTab, { url: `${ext.origin}/task` });
  assert.equal(back?.success, true, JSON.stringify(back));
  await taskPage.waitForURL(`${ext.origin}/task`);
});

test('a Foxl tab a page sends to the desktop\'s address is not read or acted in, and can be sent elsewhere', async () => {
  const went = await ext.command('navigate', taskTab, { url: `${ext.origin}/bounce` });
  assert.equal(went?.success, true, JSON.stringify(went));
  await taskPage.waitForURL(`${desktopAt}/`);
  // CONTROL: the tab shows the desktop's page.
  assert.equal(await taskPage.title(), 'Foxl Desktop');
  refusedAsDesktop(await ext.command('get_accessibility_tree', taskTab, { filter: 'all' }), 'a read');
  refusedAsDesktop(await ext.command('get_accessibility_tree', taskTab, { snapshot: true }), 'a snapshot');
  refusedAsDesktop(await ext.command('read_text', taskTab, { refId: 'ref_1' }), 'read_text');
  refusedAsDesktop(await ext.command('screenshot', taskTab, {}), 'a screenshot');
  refusedAsDesktop(await ext.command('click_at', taskTab, { x: 20, y: 20 }), 'click_at');
  refusedAsDesktop(await ext.command('get_page_info', taskTab, {}), 'get_page_info');
  const away = await ext.command('navigate', taskTab, { url: `${ext.origin}/task` });
  assert.equal(away?.success, true, JSON.stringify(away));
  await taskPage.waitForURL(`${ext.origin}/task`);
});

test('a click on a link to the desktop\'s address does not read the page it led to', async () => {
  const went = await ext.command('navigate', taskTab, { url: `${ext.origin}/links` });
  assert.equal(went?.success, true, JSON.stringify(went));
  const tree = await ext.command('get_accessibility_tree', taskTab, { filter: 'all' });
  const link = /link "Open the app"[^\n]*\[(ref_\d+)\]/.exec(tree?.data?.pageContent ?? '')?.[1];
  assert.ok(link, JSON.stringify(tree));
  const clicked = await ext.command('click', taskTab, { refId: link });
  await taskPage.waitForURL(`${desktopAt}/`);
  assert.ok(!JSON.stringify(clicked).includes('Recent chats') && !JSON.stringify(clicked).includes('Foxl Desktop app'), `the click's answer read the desktop's page: ${JSON.stringify(clicked)}`);
  refusedAsDesktop(await ext.command('get_accessibility_tree', taskTab, { filter: 'all' }), 'the read after');
  const away = await ext.command('navigate', taskTab, { url: `${ext.origin}/task` });
  assert.equal(away?.success, true, JSON.stringify(away));
});
