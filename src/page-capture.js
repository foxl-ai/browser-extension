/**
 * Capture the named tab's renderer without selecting it.
 *
 * Only a tab in the BACKGROUND goes through the debugger. The selected tab of its window is
 * captured with chrome.tabs.captureVisibleTab, as 0.8.1 did: attaching shows Chrome's
 * "started debugging this browser" bar in every tab of every window, which shrinks the page
 * being captured while the capture runs (measured on Chrome 156: 757 -> 700 CSS px over
 * ~130 ms, so a selected-tab capture reported a 757 px viewport for a page drawn at ~730).
 * Where Chrome refuses the debugger (DevTools disabled by policy, a page embedding another
 * extension's frame, an existing session) or cannot draw a background tab (a PDF), a
 * viewport capture falls back to 0.8.1's select-capture-restore instead of failing.
 *
 * Chrome's debugger permission is required, not optional:
 * developer.chrome.com/docs/extensions/reference/api/permissions
 * It does NOT enforce the person's per-site extension access. Each capture therefore
 * checks access through scripting.executeScript, before attaching and before returning.
 * No arbitrary CDP command or page expression is accepted from the desktop.
 */
const queues = new Map();
const CAPTURE_TIMEOUT_MS = 20_000;
// A new background renderer can take more than two seconds on a busy desktop.
// This bounds withheld-access and hung-page requests without delaying ready pages.
const PAGE_READ_TIMEOUT_MS = 5_000;
// ChromeDevTools/devtools-protocol: json/browser_protocol.json, version 1.3.
const PROTOCOL_VERSION = '1.3';

/** A real scripting call checks Chrome's current host grant, including withheld sites. */
export async function readAllowedPage(tabId, reader = () => ({
  url: location.href,
  contentType: document.contentType,
  viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
}), args = []) {
  let timer;
  let page;
  try {
    [page] = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        injectImmediately: true,
        func: reader,
        args,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The page access check did not finish. Check Foxl site access and that the page is responding.')), PAGE_READ_TIMEOUT_MS);
      }),
    ]);
  } finally { clearTimeout(timer); }
  // file: too: scripting itself refuses it unless "Allow access to file URLs" is on.
  if (!page?.documentId || !page.result || !/^(https?:\/\/|file:)/.test(page.result.url)) {
    throw new Error('Foxl needs access to this web page before it can read or capture it.');
  }
  return { ...page.result, documentId: page.documentId };
}

function sameDocument(before, after) {
  if (before.documentId !== after.documentId || before.url !== after.url) {
    throw new Error('The page navigated during the screenshot. Take a new screenshot.');
  }
}

function pngDimensions(data) {
  const header = Uint8Array.from(atob(data.slice(0, 44)), (c) => c.charCodeAt(0));
  const view = new DataView(header.buffer);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(12) !== 0x49484452) {
    throw new Error('Chrome did not return a PNG screenshot.');
  }
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Hide Foxl's own overlay for a capture; true when the page confirmed it. */
function hideOverlay(tabId, deadline, timers, documentId) {
  const hideDeadline = Math.min(deadline, Date.now() + 500);
  return Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'SET_OVERLAY_HIDDEN', hidden: true, deadline: hideDeadline },
      documentId ? { documentId } : { frameId: 0 }).then((r) => r?.success === true, () => false),
    new Promise((resolve) => {
      const timer = setTimeout(() => { timers.delete(timer); resolve(false); }, 500);
      timers.add(timer);
    }),
  ]);
}

function showOverlay(tabId, documentId) {
  chrome.tabs.sendMessage(tabId, { type: 'SET_OVERLAY_HIDDEN', hidden: false },
    documentId ? { documentId } : { frameId: 0 }).catch(() => {});
}

/** A discarded tab is reloaded in the background (0.8.1 reloaded it by selecting it). */
async function reloadDiscarded(tabId) {
  const loaded = new Promise((resolve) => {
    const listener = (id, change) => {
      if (id === tabId && change.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  await chrome.tabs.reload(tabId);
  await loaded;
  return chrome.tabs.get(tabId);
}

/**
 * The pixels of the selected tab of `tab.windowId`, the way 0.8.1 took them. captureVisibleTab
 * enforces the site-access grant itself. `select` first selects the tab and restores the
 * previous one afterwards (0.8.1's withActiveTab), only for the fallbacks named above.
 */
async function captureVisible(tab, timers, deadline, select) {
  let previous = null;
  if (select) {
    [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }
  let hidden = false;
  try {
    hidden = await hideOverlay(tab.id, deadline, timers);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const now = await chrome.tabs.get(tab.id);
    if (!now.active || now.windowId !== tab.windowId) {
      throw new Error('Another tab was selected during the screenshot. Take a new screenshot.');
    }
    const page = await readAllowedPage(tab.id);
    const viewport = { width: page.viewport.width, height: page.viewport.height };
    return {
      success: true, tabId: tab.id, documentId: page.documentId,
      captureMethod: select ? 'select-tab' : 'visible-tab',
      viewport, captureRect: { x: 0, y: 0, ...viewport },
      image: pngDimensions(dataUrl.slice(dataUrl.indexOf(',') + 1)), fullPage: false, dataUrl,
    };
  } finally {
    if (hidden) showOverlay(tab.id);
    if (previous?.id && previous.id !== tab.id) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

async function capture(tabId, options, deadline) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('A target tab is required for a screenshot.');
  const target = { tabId };
  let before;
  let attached = false;
  let finished = false;
  let hidden = false;
  const timers = new Set();
  const bounded = async (operation) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('The screenshot timed out without changing the active tab.');
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The screenshot timed out without changing the active tab.')), remaining);
          timers.add(timer);
        }),
      ]);
    } finally { clearTimeout(timer); timers.delete(timer); }
  };
  try {
    let tab = await bounded(() => chrome.tabs.get(tabId));
    // Chrome draws nothing in a minimized window: the debugger capture failed ("image
    // readback failed") or waited out the whole deadline, and 0.8.1 never answered (measured
    // on Chrome 156). Say so at once; restoring the person's window is not ours to do.
    const win = await bounded(() => chrome.windows.get(tab.windowId));
    if (win.state === 'minimized') {
      throw new Error("The tab's window is minimized, and Chrome draws nothing in a minimized window. Restore the window to take a screenshot.");
    }
    if (tab.discarded) tab = await bounded(() => reloadDiscarded(tabId));
    const viewportOnly = !options.clip && !options.fullPage;
    if (tab.active && viewportOnly) return await bounded(() => captureVisible(tab, timers, deadline, false));
    before = await bounded(() => readAllowedPage(tabId));
    // Chrome draws no PDF in a background tab: the debugger returns the viewer's empty grey.
    if (before.contentType === 'application/pdf' && viewportOnly) {
      return await bounded(() => captureVisible(tab, timers, deadline, true));
    }
    let refused = null;
    await bounded(async () => {
      try { await chrome.debugger.attach(target, PROTOCOL_VERSION); } catch (err) { refused = err; return; }
      // An attach that finishes after a timeout must not leave a debugging session behind.
      if (finished) { await chrome.debugger.detach(target); return; }
      attached = true;
    });
    if (refused) {
      if (!viewportOnly) throw refused;
      return await bounded(() => captureVisible(tab, timers, deadline, true));
    }
    const current = await bounded(() => readAllowedPage(tabId));
    sameDocument(before, current);
    // Page.getLayoutMetrics / Page.captureScreenshot:
    // chromedevtools.github.io/devtools-protocol/tot/Page/
    const metrics = await bounded(() => chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics'));
    const viewport = metrics.cssVisualViewport;
    if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight)) {
      throw new Error('Chrome did not report the screenshot viewport.');
    }
    // A tab reloaded in the background (a discarded one) has no size until it is drawn:
    // Page.getLayoutMetrics reports a 0x0 viewport, and the default clip used to fail as
    // "clip must be a positive rectangle". A viewport capture takes 0.8.1's path instead,
    // which draws and sizes the tab; a clip or full page has nothing to measure yet.
    if (viewport.clientWidth < 1 || viewport.clientHeight < 1) {
      if (!viewportOnly) {
        throw new Error('The tab has not been drawn since it reloaded in the background, so it has no size yet. Take a plain screenshot first, then the clip or full page.');
      }
      await chrome.debugger.detach(target).catch(() => {});
      attached = false;
      return await bounded(() => captureVisible(tab, timers, deadline, true));
    }
    if (options.fullPage && options.clip) throw new Error('Choose fullPage or clip, not both.');
    const clip = options.clip ?? { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight };
    if (!options.fullPage && (
      ![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)
      || clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0
      || clip.x + clip.width > viewport.clientWidth || clip.y + clip.height > viewport.clientHeight
    )) throw new Error('clip must be a positive rectangle inside the viewport, in CSS pixels.');
    const rect = options.fullPage
      ? { x: -viewport.pageX, y: -viewport.pageY, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height }
      : clip;
    if (rect.width > 16_384 || rect.height > 16_384 || rect.width * rect.height > 32_000_000) {
      throw new Error('The screenshot is too large. Capture the viewport or a smaller clip.');
    }
    // Hide only the overlay belonging to this extension in this document. Its own
    // deadline and self-restore cover an unresponsive page or a service-worker restart.
    hidden = await hideOverlay(tabId, deadline, timers, current.documentId);
    const result = await bounded(() => chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: !!options.fullPage,
      // Preserve the renderer's pixels. devicePixelRatio does not determine the
      // raster scale on every debugger target. The desktop maps its preview using
      // the actual PNG dimensions and this CSS rectangle.
      clip: { x: viewport.pageX + rect.x, y: viewport.pageY + rect.y,
        width: rect.width, height: rect.height, scale: 1 },
    }));
    const after = await bounded(() => readAllowedPage(tabId));
    sameDocument(current, after);
    if (!result?.data) throw new Error('Chrome returned no screenshot.');
    return {
      success: true, tabId, documentId: current.documentId, captureMethod: 'cdp',
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
      captureRect: rect, image: pngDimensions(result.data), fullPage: !!options.fullPage,
      dataUrl: `data:image/png;base64,${result.data}`,
    };
  } finally {
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    if (hidden) showOverlay(tabId, before.documentId);
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

export function captureTabScreenshot(tabId, options = {}) {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  const previous = queues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => capture(tabId, options, deadline));
  queues.set(tabId, next);
  const clear = () => { if (queues.get(tabId) === next) queues.delete(tabId); };
  next.then(clear, clear);
  return next;
}
