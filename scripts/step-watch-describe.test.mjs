/**
 * The step watch's `describe` (src/content-scripts/step-watch.js) is Foxl Desktop's own, text for text.
 *
 * A form's digest is what lets one chat that uses both browsers hold back the same form sent twice, so this
 * extension's `describe` and foxl-ai/pilot's DESCRIBE_FORM_SOURCE (server/tools/browser-step-watch.ts) are the same
 * text, comments included, line for line but for indentation. Both repositories pin the SHA-256 of that text with
 * each line's surrounding whitespace removed (there: tests/step-watch-saved-sign-in.regression.test.mjs, whose test 5
 * also compares this file's text when FOXL_EXTENSION_SRC names a checkout), so a change to one copy is red in its own
 * repository until the other copy and both pins change with it.
 *
 * Since foxl-ai/pilot #6550 the text also says what is never described: a sign-in step, a form that sends a username,
 * a current password or a one-time code by its fields' autocomplete tokens, whoever typed it (the person, or Chrome's
 * password manager); and a form holding what a saved sign-in typed (the desktop's `fill_login` mark; this extension's
 * `fill_sign_in`, since 0.12.1, keeps each field it types into in `__foxlFilledFields`, accessibility-tree.js).
 * scripts/browser/step-watch-guards.test.mjs and scripts/browser/fill-sign-in-marks.test.mjs run it in a real page.
 *
 * Run: node --test scripts/step-watch-describe.test.mjs   (zero dependencies, like the other scripts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DESCRIBE_FORM_SHA256 = 'be6e9dae1e1d53214d956634ee3da3f203fc2ee8fea3fd7c3eea70ca6345d751';

const source = readFileSync(new URL('../src/content-scripts/step-watch.js', import.meta.url), 'utf8');

/** `describe` as step-watch.js writes it: from its arrow to the closing brace at its own indent. */
function describeText() {
  const head = 'const describe = ';
  const start = source.indexOf(`${head}(form, submitter) => {`);
  assert.ok(start >= 0, 'step-watch.js declares describe');
  const lines = source.slice(start + head.length).split('\n');
  const end = lines.findIndex((line, i) => i > 0 && line === '  };');
  assert.ok(end > 0, 'describe ends at its own indent');
  return [...lines.slice(0, end), '  }'].join('\n');
}
const canonical = (text) => text.split('\n').map((line) => line.trim()).join('\n');

test('describe is the text foxl-ai/pilot pins for DESCRIBE_FORM_SOURCE', () => {
  const text = describeText();
  assert.equal(typeof new Function(`return (${text});`)(), 'function', 'it parses as one function');
  assert.equal(createHash('sha256').update(canonical(text)).digest('hex'), DESCRIBE_FORM_SHA256,
    'describe changed: change foxl-ai/pilot server/tools/browser-step-watch.ts DESCRIBE_FORM_SOURCE to the same text, and this pin and that repository\'s together');
});

test('it never describes a sign-in step, by its autocomplete tokens or by a saved sign-in\'s mark', () => {
  const text = describeText();
  for (const rule of ['username|current-password|one-time-code', "el.hasAttribute('data-foxl-saved-sign-in')", 'savedSignIn.has(el)']) {
    assert.ok(text.includes(rule), `describe reads ${rule}`);
  }
});
