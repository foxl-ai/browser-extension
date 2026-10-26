/**
 * Capture the named tab's renderer without selecting it.
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
  if (!page?.documentId || !page.result || !/^https?:\/\//.test(page.result.url)) {
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
    const tab = await bounded(() => chrome.tabs.get(tabId));
    if (tab.discarded) throw new Error('The target tab is discarded. Open it before taking a screenshot.');
    before = await bounded(() => readAllowedPage(tabId));
    await bounded(async () => {
      await chrome.debugger.attach(target, PROTOCOL_VERSION);
      // An attach that finishes after a timeout must not leave a debugging session behind.
      if (finished) { await chrome.debugger.detach(target); return; }
      attached = true;
    });
    const current = await bounded(() => readAllowedPage(tabId));
    sameDocument(before, current);
    // Page.getLayoutMetrics / Page.captureScreenshot:
    // chromedevtools.github.io/devtools-protocol/tot/Page/
    const metrics = await bounded(() => chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics'));
    const viewport = metrics.cssVisualViewport;
    if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight)) {
      throw new Error('Chrome did not report the screenshot viewport.');
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
    const hideDeadline = Math.min(deadline, Date.now() + 500);
    hidden = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'SET_OVERLAY_HIDDEN', hidden: true, deadline: hideDeadline },
        { documentId: current.documentId }).then((r) => r?.success === true, () => false),
      new Promise((resolve) => {
        const timer = setTimeout(() => { timers.delete(timer); resolve(false); }, 500);
        timers.add(timer);
      }),
    ]);
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
    if (hidden) {
      chrome.tabs.sendMessage(tabId, { type: 'SET_OVERLAY_HIDDEN', hidden: false },
        { documentId: before.documentId }).catch(() => {});
    }
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
