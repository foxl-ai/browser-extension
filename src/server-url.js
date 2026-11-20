/**
 * WHERE THE EXTENSION MAY CONNECT: Foxl Desktop on this computer, nowhere else (foxl-ai/pilot #7806).
 *
 * Foxl Desktop always listens on this
 * computer, so the only addresses accepted are the loopback names: `localhost`, `127.0.0.1` and `[::1]`, on any
 * port. The options page refuses any other host by name, and the service worker ignores a stored one (saved by
 * an earlier build) and finds the desktop on its own ports instead.
 *
 * No chrome.* API here, so scripts/server-url.test.mjs runs it under plain node.
 */

/** The hosts Foxl Desktop is reached on, as `URL.hostname` spells them. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The origin to connect to (`http://localhost:13847`), or null when `value` is not an http(s) address on this
 * computer. Only the origin is kept: a path, a query or a user name in the setting never reaches a request.
 */
export function loopbackServerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!LOOPBACK_HOSTS.includes(url.hostname)) return null;
  return url.origin;
}

/** The host of a refused address, for the sentence that names it (null when it is not a URL at all). */
export function serverUrlHost(value) {
  try { return new URL(String(value).trim()).host || null; } catch { return null; }
}
