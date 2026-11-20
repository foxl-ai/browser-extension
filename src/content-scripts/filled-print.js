/**
 * THE FINGERPRINT OF WHAT A SAVED SIGN-IN TYPED (foxl-ai/pilot #7859).
 *
 * `fill_sign_in` types a saved username, password or one-time code, and no read may give it back. The mark on the
 * element (`__foxlFilledFields`) is lost when the page draws the field again as a new element, so the service worker
 * also keeps, per tab and origin and for a while, a salted fingerprint of each value it sent, never the value, and
 * hands the fingerprints to every read; the page reader masks any field whose value has one. Two FNV-1a lanes over
 * the salt and the value: not a secret, and not meant to be one (the page holds the value in its own field), only a
 * way to recognise it without keeping it.
 *
 * One file for both sides, so the two can never compute it differently: loaded before accessibility-tree.js as a
 * content script (the extension's isolated world, which no page reaches), and imported by the service worker. It
 * defines one function on the global object and nothing else.
 */
(function (scope) {
  const lane = (text, seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  scope.__foxlFilledPrint = function filledPrint(salt, value) {
    const text = `${salt}:${value}`;
    return lane(text, 2166136261) + lane(text, 3735928559);
  };
})(globalThis);
