// The store upload is confirmed only as the version the release built, and an upload the store finishes
// asynchronously is never submitted (foxl-ai/pilot #7923). The answers are the store's own shapes: the two
// synchronous ones are the 0.12.2 and 0.14.0 release logs' `upload: uploadState=SUCCEEDED crxVersion=...`.
// No network, like cws-publish.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cws from './cws-publish.mjs';

test('an upload is confirmed only when the store names the version the release built', () => {
  // The answers the store gave the 0.12.2 and 0.14.0 releases.
  assert.deepEqual(cws.decideUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.12.2' }, '0.12.2'), { ok: true, done: true });
  assert.deepEqual(cws.decideUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.14.0' }, '0.14.0'), { ok: true, done: true });
  // A SUCCEEDED that names no version, or with no version to hold it to, confirms nothing.
  assert.equal(cws.decideUpload({ uploadState: 'SUCCEEDED' }, '0.14.1').ok, false);
  assert.equal(cws.decideUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.14.1' }, null).ok, false);
  assert.equal(cws.decideUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.14.1' }, '').ok, false);
  // Another version, whatever the state, fails at once.
  assert.equal(cws.decideUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.14.0' }, '0.14.1').ok, false);
  assert.equal(cws.decideUpload({ uploadState: 'IN_PROGRESS', crxVersion: '0.14.0' }, '0.14.1').ok, false);
});

test('an upload the store finishes asynchronously is never confirmed, so it is never submitted', () => {
  assert.equal(typeof cws.decideAsyncUpload, 'function', 'the poll has a decision of its own');
  assert.deepEqual(cws.decideAsyncUpload({ lastAsyncUploadState: 'IN_PROGRESS' }), { ok: true, done: false });
  // The item's last asynchronous upload, which an earlier upload's SUCCEEDED reads the same as this one's.
  const finished = cws.decideAsyncUpload({ lastAsyncUploadState: 'SUCCEEDED' });
  assert.equal(finished.ok, false);
  assert.match(finished.why, /not submitted/);
  for (const s of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', undefined]) {
    assert.equal(cws.decideAsyncUpload({ lastAsyncUploadState: s }).ok, false, String(s));
  }
  // What the old poll did with the same status: decideUpload with no version.
  assert.equal(cws.decideUpload({ uploadState: 'SUCCEEDED' }, null).ok, false);
});
