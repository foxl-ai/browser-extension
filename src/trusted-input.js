/**
 * Trusted input through the Chrome DevTools Protocol (chrome.debugger).
 *
 * WHY: the content script can only dispatch SYNTHETIC events. `element.click()` and a
 * hand-built `KeyboardEvent` arrive with `isTrusted: false`, and setting `element.value`
 * bypasses the page's own input handling entirely. Sites that check `isTrusted`, editors
 * built on contenteditable (Gmail compose, Slack, Notion) and React's controlled inputs
 * (which read value changes through their own tracker) therefore ignored what the agent
 * did, while the extension reported success.
 *
 * Input sent through CDP is dispatched by the browser itself, exactly like a person's.
 * The methods used are all in the stable 1.3 protocol (the DevTools Protocol reference,
 * domains Input and Page): Input.dispatchMouseEvent, Input.insertText,
 * Input.dispatchKeyEvent and Page.captureScreenshot. (No URL here on purpose:
 * scripts/audit.mjs fails on any non-local URL literal in src/, comments included.)
 *
 * The `debugger` permission is OPTIONAL (manifest `optional_permissions`) and is asked for
 * from the options page. Two reasons, both about the people who already have this
 * extension: a new REQUIRED permission makes Chrome disable an installed extension on
 * update until it is re-approved, and `debugger` carries an install-time warning. Without
 * it, the service worker uses the content script's improved fallback instead (editing-engine
 * text insertion, a full pointer sequence, `requestSubmit`) and says which path it took.
 *
 * While attached, Chrome shows "Foxl started debugging this browser" above the page. The
 * session is kept for `IDLE_DETACH_MS` after the last command, so a run of commands does not
 * make that bar flicker, and is detached when the run ends (`hide_indicators`).
 */

const PROTOCOL_VERSION = '1.3';
export const IDLE_DETACH_MS = 15000;

/** tabId -> idle timer */
const attached = new Map();
let listening = false;

function listen() {
  if (listening || !chrome.debugger) return;
  listening = true;
  // The user pressed Cancel on Chrome's bar, the tab closed, or DevTools took over.
  chrome.debugger.onDetach.addListener((source) => {
    const timer = attached.get(source.tabId);
    if (timer) clearTimeout(timer);
    attached.delete(source.tabId);
  });
}

/** Has the user granted the optional `debugger` permission? */
export async function trustedInputAvailable() {
  try {
    return await chrome.permissions.contains({ permissions: ['debugger'] });
  } catch {
    return false;
  }
}

function scheduleDetach(tabId) {
  const prior = attached.get(tabId);
  if (prior) clearTimeout(prior);
  attached.set(tabId, setTimeout(() => { void detach(tabId); }, IDLE_DETACH_MS));
}

async function attach(tabId) {
  listen();
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  }
  scheduleDetach(tabId);
}

export async function detach(tabId) {
  const timer = attached.get(tabId);
  if (timer) clearTimeout(timer);
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

export async function detachAll() {
  for (const tabId of [...attached.keys()]) await detach(tabId);
}

async function send(tabId, method, params) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

/** A left click at viewport CSS pixels: move, press, release - what a mouse does. */
export async function trustedClick(tabId, x, y) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

export async function trustedHover(tabId, x, y) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

/** Text into whatever has focus, through the editing engine (an IME commit, in effect). */
export async function trustedInsertText(tabId, text) {
  await send(tabId, 'Input.insertText', { text });
}

/*
 * Named keys: `key` / `code` per the UI Events KeyboardEvent spec and the Windows virtual
 * key code Chromium's input pipeline reads for them (the same table Puppeteer ships,
 * USKeyboardLayout.ts). `text` is what a press inserts, where it inserts anything.
 */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Cmd: 4, Shift: 8 };

/**
 * "Enter", "Escape", "a", "Control+a", "Shift+Tab". Returns null for a spec it cannot
 * map, so the caller can say so instead of pressing the wrong key.
 */
export function parseKeySpec(spec) {
  const parts = String(spec || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIERS[m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()];
    if (!bit) return null;
    modifiers |= bit;
  }
  const last = parts[parts.length - 1];
  const named = KEYS[last] || KEYS[last.charAt(0).toUpperCase() + last.slice(1)];
  if (named) return { ...named, modifiers };
  if (last.length === 1) {
    const upper = last.toUpperCase();
    const isLetter = upper >= 'A' && upper <= 'Z';
    const isDigit = last >= '0' && last <= '9';
    return {
      key: last,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${last}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      // A character only inserts itself when no command modifier is held.
      text: modifiers & (1 | 2 | 4) ? undefined : last,
      modifiers,
    };
  }
  return null;
}

export async function trustedKey(tabId, spec) {
  const k = parseKeySpec(spec);
  if (!k) throw new Error(`Unknown key "${spec}". Use a key name like Enter, Tab, Escape, ArrowDown, or a character, optionally with Control+, Shift+, Alt+ or Meta+.`);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
  await send(tabId, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * A screenshot of THIS tab without bringing it to the front: captureVisibleTab only sees
 * the visible tab, which is why the old path had to switch the user's tab and back.
 */
export async function trustedScreenshot(tabId) {
  const { data } = await send(tabId, 'Page.captureScreenshot', { format: 'png' });
  return `data:image/png;base64,${data}`;
}
