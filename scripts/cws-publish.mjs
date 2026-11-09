#!/usr/bin/env node
/**
 * Chrome Web Store upload, submit and status, as a SERVICE ACCOUNT, with no dependency.
 *
 *   node scripts/cws-publish.mjs status
 *   node scripts/cws-publish.mjs upload <zip> <expected-version>
 *   node scripts/cws-publish.mjs publish
 *
 * Environment (the release workflow's `chrome-web-store` environment):
 *   CWS_SERVICE_ACCOUNT_JSON  the service account's JSON key (a secret; never printed)
 *   CWS_PUBLISHER_ID          the publisher's ID (Developer Dashboard > Settings > "Publisher ID")
 *   CWS_EXTENSION_ID          the item's ID
 *
 * WHY A SERVICE ACCOUNT. The store API "supports authentication using Google Cloud Service Accounts"
 * once the account's email is added in the Developer Dashboard's Account section (one per publisher):
 * https://developer.chrome.com/docs/webstore/service-accounts . A refresh token instead needs a
 * person to consent in a browser, and an OAuth app left in "testing" expires it after a week.
 * The account is foxl-cws-publisher@foxl-489707.iam.gserviceaccount.com and holds NO project role;
 * its only power is this publisher's items, which is exactly what a leaked key would give away, so
 * the key lives only in the environment secret.
 *
 * THE WIRE, each constant from the v2 reference (all fetched 2026-11-09):
 *   token     POST https://oauth2.googleapis.com/token, grant urn:ietf:params:oauth:grant-type:jwt-bearer,
 *             scope https://www.googleapis.com/auth/chromewebstore (service-accounts page above)
 *   upload    POST https://chromewebstore.googleapis.com/upload/v2/{name=publishers/* /items/*}:upload
 *             -> { name, itemId, crxVersion, uploadState }
 *             https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload
 *   status    GET  https://chromewebstore.googleapis.com/v2/{name=publishers/* /items/*}:fetchStatus
 *             -> { publishedItemRevisionStatus, submittedItemRevisionStatus, lastAsyncUploadState,
 *                  takenDown, warned }, each revision { state, distributionChannels[{ deployPercentage, crxVersion }] }
 *             https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus
 *   publish   POST https://chromewebstore.googleapis.com/v2/{name=publishers/* /items/*}:publish
 *             body { publishType: DEFAULT_PUBLISH } -> { name, itemId, state, warningInfo }
 *             https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish
 *   UploadState  SUCCEEDED | IN_PROGRESS | FAILED | NOT_FOUND | UPLOAD_STATE_UNSPECIFIED
 *             https://developer.chrome.com/docs/webstore/api/reference/rest/v2/UploadState
 *   ItemState    PENDING_REVIEW | STAGED | PUBLISHED | PUBLISHED_TO_TESTERS | REJECTED | CANCELLED |
 *             ITEM_STATE_UNSPECIFIED  https://developer.chrome.com/docs/webstore/api/reference/rest/v2/ItemState
 *
 * EVERY UNEXPECTED ANSWER FAILS THE STEP, naming the HTTP status and the body (Google's error bodies
 * carry no secret). A release that "uploaded" into a state nobody checked is how the store listing sat
 * on 0.7.1 for weeks while every release went green.
 */
import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
export const API = 'https://chromewebstore.googleapis.com';
export const PUBLISH_OK = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** The signed JWT a service account trades for an access token (RFC 7523, RS256). */
export function jwtAssertion(sa, nowSec = Math.floor(Date.now() / 1000)) {
  if (!sa || !sa.client_email || !sa.private_key) throw new Error('the service account JSON has no client_email or private_key');
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const claims = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const unsigned = `${b64url(header)}.${b64url(claims)}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url')}`;
}

export const itemName = (publisherId, extensionId) => {
  if (!/^[\w-]+$/.test(publisherId || '') || !/^[a-p]{32}$/.test(extensionId || '')) {
    throw new Error(`CWS_PUBLISHER_ID or CWS_EXTENSION_ID is malformed ('${publisherId}', '${extensionId}')`);
  }
  return `publishers/${publisherId}/items/${extensionId}`;
};

/** An upload's answer: done, still processing, or a failure that names why. */
export function decideUpload(body, expectedVersion) {
  const state = body && body.uploadState;
  if (state === 'SUCCEEDED') {
    if (expectedVersion && body.crxVersion && body.crxVersion !== expectedVersion) {
      return { ok: false, why: `the store read version ${body.crxVersion} from the package, expected ${expectedVersion}` };
    }
    return { ok: true, done: true };
  }
  if (state === 'IN_PROGRESS') return { ok: true, done: false };
  return { ok: false, why: `uploadState=${state === undefined ? '(missing)' : state}` };
}

/** A submit's answer. Anything but a state that leads to (or is) a published item fails the step. */
export function decidePublish(body) {
  const state = body && body.state;
  if (PUBLISH_OK.has(state)) return { ok: true, state };
  return { ok: false, why: `state=${state === undefined ? '(missing)' : state}` };
}

/** One line per revision for the job log and summary. */
export function summarizeStatus(body) {
  const rev = (r) => (r ? `${r.state || '?'} ${(r.distributionChannels || []).map((c) => `${c.crxVersion}@${c.deployPercentage ?? '?'}%`).join(', ') || '-'}` : 'none');
  return [
    `published: ${rev(body.publishedItemRevisionStatus)}`,
    `submitted: ${rev(body.submittedItemRevisionStatus)}`,
    `last async upload: ${body.lastAsyncUploadState || 'none'}`,
    `taken down: ${body.takenDown === true}, warned: ${body.warned === true}`,
  ];
}

async function call(method, url, token, body, contentType) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* reported below */ }
  if (!res.ok || json === null) throw new Error(`${method} ${url} answered HTTP ${res.status}: ${text.slice(0, 2000)}`);
  return json;
}

async function accessToken(sa) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwtAssertion(sa) }),
  });
  const text = await res.text();
  let token = '';
  try { token = JSON.parse(text).access_token || ''; } catch { /* below */ }
  // The token endpoint's error body names the reason (invalid_grant, a disabled key) and never the key.
  if (!res.ok || !token) throw new Error(`the token endpoint answered HTTP ${res.status}: ${text.slice(0, 500)}`);
  return token;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!['status', 'upload', 'publish'].includes(cmd)) throw new Error('usage: cws-publish.mjs status | upload <zip> <version> | publish');
  let sa;
  try { sa = JSON.parse(process.env.CWS_SERVICE_ACCOUNT_JSON || ''); } catch { throw new Error('CWS_SERVICE_ACCOUNT_JSON is not the JSON key of a service account'); }
  const name = itemName(process.env.CWS_PUBLISHER_ID, process.env.CWS_EXTENSION_ID);
  const token = await accessToken(sa);
  const status = () => call('GET', `${API}/v2/${name}:fetchStatus`, token);

  if (cmd === 'status') {
    for (const line of summarizeStatus(await status())) console.log(line);
    return;
  }
  if (cmd === 'upload') {
    const [zip, version] = args;
    if (!zip || !version) throw new Error('usage: cws-publish.mjs upload <zip> <expected-version>');
    const answer = await call('POST', `${API}/upload/v2/${name}:upload`, token, readFileSync(zip), 'application/zip');
    let d = decideUpload(answer, version);
    console.log(`upload: uploadState=${answer.uploadState} crxVersion=${answer.crxVersion ?? '?'}`);
    // IN_PROGRESS: poll fetchStatus's lastAsyncUploadState, as the reference says, for up to 5 minutes.
    for (let i = 0; d.ok && !d.done && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await status();
      d = decideUpload({ uploadState: s.lastAsyncUploadState }, null);
      console.log(`upload: lastAsyncUploadState=${s.lastAsyncUploadState}`);
    }
    if (!d.ok) throw new Error(`the store did not take the package: ${d.why}`);
    if (!d.done) throw new Error('the upload was still IN_PROGRESS after 5 minutes');
    console.log(`uploaded ${zip} as ${version}`);
    return;
  }
  const answer = await call('POST', `${API}/v2/${name}:publish`, token, JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }), 'application/json');
  const d = decidePublish(answer);
  if (answer.warningInfo) console.log(`publish warnings: ${JSON.stringify(answer.warningInfo).slice(0, 2000)}`);
  if (!d.ok) throw new Error(`the submit did not lead to a published item: ${d.why}`);
  console.log(`submitted: state=${d.state}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`::error::cws-publish: ${e.message}`); process.exit(1); });
}
