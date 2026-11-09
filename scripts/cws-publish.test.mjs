// The Chrome Web Store publisher's own decisions: the JWT it signs, and what it accepts from the
// store's answers (scripts/cws-publish.mjs). No network: the HTTP layer is exercised by the
// `cws-status` workflow against the real store, read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { jwtAssertion, decideUpload, decidePublish, itemName, summarizeStatus, SCOPE, TOKEN_URL } from './cws-publish.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  client_email: 'foxl-cws-publisher@foxl-489707.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  private_key_id: 'k1',
};
const part = (jwt, i) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url').toString());

test('the JWT names the account, the store scope and the token endpoint, for one hour', () => {
  const jwt = jwtAssertion(sa, 1_000_000);
  assert.deepEqual(part(jwt, 0), { alg: 'RS256', typ: 'JWT', kid: 'k1' });
  assert.deepEqual(part(jwt, 1), { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: 1_000_000, exp: 1_003_600 });
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/chromewebstore');
  assert.equal(TOKEN_URL, 'https://oauth2.googleapis.com/token');
});

test('the JWT signature verifies with the account public key, and fails for a changed claim', () => {
  const jwt = jwtAssertion(sa, 1_000_000);
  const [h, c, s] = jwt.split('.');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), true);
  const forged = Buffer.from(JSON.stringify({ ...part(jwt, 1), scope: 'https://www.googleapis.com/auth/cloud-platform' })).toString('base64url');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${h}.${forged}`), publicKey, Buffer.from(s, 'base64url')), false);
});

test('a key without an email or private key is refused before any request', () => {
  assert.throws(() => jwtAssertion({ client_email: 'x@y' }), /no client_email or private_key/);
  assert.throws(() => jwtAssertion(null), /no client_email or private_key/);
});

test('the item name is checked: a publisher id and a 32-letter a-p extension id', () => {
  assert.equal(itemName('7f495d31-8252-4f2a-96ba-5a08df939921', 'ijlihobebaeangjiacfomjdkhlpbmlhi'),
    'publishers/7f495d31-8252-4f2a-96ba-5a08df939921/items/ijlihobebaeangjiacfomjdkhlpbmlhi');
  assert.throws(() => itemName('', 'ijlihobebaeangjiacfomjdkhlpbmlhi'), /malformed/);
  assert.throws(() => itemName('p', 'not-an-id'), /malformed/);
  assert.throws(() => itemName('p/../x', 'ijlihobebaeangjiacfomjdkhlpbmlhi'), /malformed/);
});

test('an upload is done only on SUCCEEDED with the version the release built', () => {
  assert.deepEqual(decideUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.12.2' }, '0.12.2'), { ok: true, done: true });
  assert.equal(decideUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.12.1' }, '0.12.2').ok, false);
  assert.deepEqual(decideUpload({ uploadState: 'IN_PROGRESS' }, '0.12.2'), { ok: true, done: false });
  for (const s of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', undefined]) {
    assert.equal(decideUpload({ uploadState: s }, '0.12.2').ok, false, String(s));
  }
});

test('a submit passes only for a state that is, or leads to, a published item', () => {
  for (const s of ['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']) assert.equal(decidePublish({ state: s }).ok, true, s);
  for (const s of ['REJECTED', 'CANCELLED', 'ITEM_STATE_UNSPECIFIED', undefined]) assert.equal(decidePublish({ state: s }).ok, false, String(s));
});

test('the status summary names both revisions and their versions', () => {
  const lines = summarizeStatus({
    publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ deployPercentage: 100, crxVersion: '0.12.0' }] },
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.12.1' }] },
    lastAsyncUploadState: 'SUCCEEDED',
  });
  assert.deepEqual(lines, [
    'published: PUBLISHED 0.12.0@100%',
    'submitted: PENDING_REVIEW 0.12.1@?%',
    'last async upload: SUCCEEDED',
    'taken down: false, warned: false',
  ]);
});
