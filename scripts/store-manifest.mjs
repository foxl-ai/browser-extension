/**
 * THE MANIFEST THE STORE RECEIVES: manifest.json without its `key`.
 *
 * Since 0.14.0 manifest.json carries the Chrome Web Store item's public key (`key`). Chrome derives an
 * unpacked extension's ID from that key, so a copy loaded from this repository has the store build's ID,
 * `ijlihobebaeangjiacfomjdkhlpbmlhi`, and that is the only ID Foxl Desktop's browser bridge lets in (its
 * native-messaging host manifest lists it in `allowed_origins`, which takes no wildcards). Without the key a
 * hand-loaded copy gets an ID made from its folder, Chrome refuses to start the bridge for it, and a desktop
 * that requires the bridge cannot be reached at all.
 *
 * The release zip is what `scripts/cws-publish.mjs` uploads, and the store does not need the field: it gives
 * its own build the item's ID. developer.chrome.com/docs/extensions/reference/manifest/key describes the key
 * only as the way to keep that ID while developing (copy it from the dashboard into manifest.json); neither
 * it nor the publishing pages say what an uploaded manifest carrying one does. So the zip leaves it out, and
 * the upload never depends on that.
 *
 * TEXT, NOT A RE-SERIALIZATION: exactly the one `"key": ...` line is removed, so every other byte of the file
 * the store reads is the file in this repository. Anything else (no such line, two of them, a key that is
 * not a member on its own line, or a removal that changes another member) throws, and the build stops.
 */

/** manifest.json's text, minus its `key` member. Text without a `key` is returned unchanged. */
export function storeManifest(text) {
  const source = JSON.parse(text);
  if (!Object.prototype.hasOwnProperty.call(source, 'key')) return text;
  const lines = text.split('\n');
  const keyLines = lines.flatMap((line, i) => (/^\s*"key"\s*:/.test(line) ? [i] : []));
  if (keyLines.length !== 1) {
    throw new Error(`manifest.json: expected one "key" line, found ${keyLines.length}`);
  }
  const out = lines.filter((_, i) => i !== keyLines[0]).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`manifest.json without its "key" line is not JSON (${err.message}); keep "key" a member on its own line, not the last one`);
  }
  const { key: _key, ...rest } = source;
  if (JSON.stringify(parsed) !== JSON.stringify(rest)) {
    throw new Error('manifest.json: removing the "key" line changed another member');
  }
  return out;
}
