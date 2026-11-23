/**
 * FOXL DESKTOP'S OWN ADDRESS IS NEVER A PAGE FOXL WORKS IN (foxl-ai/pilot #8212).
 *
 * Desktops up to v0.7.27 put their connection key into the page that any `GET /` on their own port loaded, and this
 * extension still supports desktops from 0.6.5. A Foxl tab steered to the desktop's own address would hold that
 * desktop's whole API, and on any desktop it would show the person's own Foxl. So a tab Foxl works in never goes
 * there (`navigate`, `new_tab`), and a Foxl tab that a page sends there is neither read nor acted in.
 *
 * "This computer" is every spelling Chrome connects to it with: `localhost` and any `*.localhost` name (with or without
 * a final dot), 127.0.0.0/8, `[::1]`, the unspecified addresses `0.0.0.0` and `[::]`, and those IPv4 addresses
 * written as IPv6. URL already normalizes the rest (`127.1`, a decimal or hex address, an upper-case name), so the
 * check reads `URL.hostname`. Only the desktop's ports are refused: a site the person serves on another local port
 * (a dev server) is a page like any other.
 *
 * No chrome.* API here, so scripts/desktop-origin.test.mjs runs it under plain node.
 */

/** Is this `URL.hostname` this computer? */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return v4[1] === '127' || host === '0.0.0.0';
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const v6 = host.slice(1, -1);
  if (v6 === '::1' || v6 === '::') return true;
  // An IPv4 address written as IPv6, as URL prints it: [::ffff:7f00:1] is 127.0.0.1, [::ffff:0:0] is 0.0.0.0.
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(v6) || v6 === '::ffff:0:0';
}

/** The port a URL reaches, its scheme's default when it names none; null for anything but http(s). */
export function effectivePort(url) {
  if (url.protocol === 'http:') return url.port ? Number(url.port) : 80;
  if (url.protocol === 'https:') return url.port ? Number(url.port) : 443;
  return null;
}

/** The port of an http(s) address, or null (no address, not a URL, another scheme). */
export function portOf(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return effectivePort(new URL(value)); } catch { return null; }
}

/**
 * Is `value` an http(s) address on this computer, on one of `ports` (Foxl Desktop's)? A string that is not a URL is
 * not one: the caller refuses it for its own reason.
 */
export function isDesktopAddress(value, ports) {
  if (typeof value !== 'string' || !value) return false;
  let url;
  try { url = new URL(value.trim()); } catch { return false; }
  const port = effectivePort(url);
  return port !== null && isLoopbackHost(url.hostname) && ports.has(port);
}
