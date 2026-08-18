#!/usr/bin/env node
/**
 * Check that the two claims the README makes about this extension are still true.
 *
 * Run: node scripts/audit.mjs
 *
 * The README documents every permission with the API calls that need it, and
 * states that the extension talks to nothing but a local server. Both are the
 * reason someone would trust an unpacked install, and both are the kind of claim
 * that silently stops being true - a permission added "for later", a debug
 * endpoint left in - while the prose that promises otherwise stays put. So they
 * are asserted here rather than only written down.
 *
 * Zero dependencies, like scripts/build.mjs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (msg) => failures.push(msg);

/** Every source file the extension actually loads. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

const sourceFiles = walk(join(root, 'src')).filter((f) => extname(f) === '.js');
const sources = sourceFiles.map((f) => ({ path: relative(root, f), text: readFileSync(f, 'utf8') }));
const allSource = sources.map((s) => s.text).join('\n');

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. manifest hygiene
// ---------------------------------------------------------------------------

if (manifest.manifest_version !== 3) fail(`manifest_version must be 3, got ${manifest.manifest_version}`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) {
  fail(`version must be X.Y.Z, got ${JSON.stringify(manifest.version)}`);
}

/*
 * Files the manifest points at must exist. Chrome fails an unpacked load with a
 * generic error for a missing path, which is a bad first experience for exactly
 * the audience this repo is public for.
 */
const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  ...(manifest.web_accessible_resources ?? []).flatMap((war) => war.resources ?? []),
].filter(Boolean);

for (const ref of new Set(referenced)) {
  try {
    statSync(join(root, ref));
  } catch {
    fail(`manifest references a missing file: ${ref}`);
  }
}

// ---------------------------------------------------------------------------
// 2. every declared permission is used, and every used API is declared
// ---------------------------------------------------------------------------

/*
 * A permission whose API is never called is not harmless. Chrome turns several
 * of them into an install-time warning, so it scares people off for a capability
 * the code does not have - which is what `notifications` did here until 0.3.0.
 */
const PERMISSION_API = {
  sidePanel: 'sidePanel',
  storage: 'storage',
  scripting: 'scripting',
  tabs: 'tabs',
  tabGroups: 'tabGroups',
  alarms: 'alarms',
  notifications: 'notifications',
  webNavigation: 'webNavigation',
  cookies: 'cookies',
  webRequest: 'webRequest',
  downloads: 'downloads',
  bookmarks: 'bookmarks',
  history: 'history',
  management: 'management',
  debugger: 'debugger',
};

/*
 * Some permissions grant no callable API surface - they widen what other APIs may
 * touch (e.g. activeTab widens the tabs and captureVisibleTab APIs on a user
 * gesture). If one is ever added back, list it here with a reason so it is not
 * flagged as an unused permission. Empty today: activeTab was declared in the
 * monorepo build and removed before the split, because the extension holds
 * <all_urls> and never needed the narrower grant.
 */
const NO_API_SURFACE = new Set();

const declared = new Set(manifest.permissions ?? []);

for (const perm of declared) {
  if (NO_API_SURFACE.has(perm)) continue;
  const api = PERMISSION_API[perm];
  if (!api) {
    fail(`permission "${perm}" is declared but this audit has no rule for it - add it to PERMISSION_API or NO_API_SURFACE with a reason`);
    continue;
  }
  if (!allSource.includes(`chrome.${api}.`)) {
    fail(`permission "${perm}" is declared but chrome.${api} is never called - drop it from the manifest or use it`);
  }
}

/* Reverse direction: an API called without its permission fails at runtime. */
const usedNamespaces = new Set([...allSource.matchAll(/chrome\.([a-zA-Z]+)\./g)].map((m) => m[1]));
const NEEDS_NO_PERMISSION = new Set(['runtime', 'commands', 'i18n', 'extension']);

for (const ns of usedNamespaces) {
  if (NEEDS_NO_PERMISSION.has(ns)) continue;
  const perm = Object.entries(PERMISSION_API).find(([, api]) => api === ns)?.[0];
  if (!perm) {
    fail(`chrome.${ns} is used but this audit has no permission mapping for it - add it to PERMISSION_API or NEEDS_NO_PERMISSION`);
    continue;
  }
  if (!declared.has(perm)) fail(`chrome.${ns} is used but permission "${perm}" is not declared in the manifest`);
}

// ---------------------------------------------------------------------------
// 3. nothing talks to a remote host
// ---------------------------------------------------------------------------

/*
 * The README says every network call targets the local Foxl app, and gives a
 * grep so a reader can confirm it. This is that grep, as a gate.
 *
 * Allowed: a bare scheme (the code rewrites http:// to ws:// by string replace),
 * a loopback host, and chrome:// internal pages. Anything else is a remote
 * endpoint compiled into an extension that claims to have none.
 */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOWED_SCHEMES = new Set(['chrome', 'chrome-extension', 'about', 'moz-extension']);

for (const { path, text } of sources) {
  for (const match of text.matchAll(/([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\s"'`)]*)/g)) {
    const [literal, scheme, rest] = match;
    if (ALLOWED_SCHEMES.has(scheme)) continue;
    if (rest === '') continue; // bare scheme fragment, e.g. 'http://' in a replace()
    const host = rest.split(/[/:?#]/)[0];
    if (ALLOWED_HOSTS.has(host)) continue;
    fail(`${path} contains a non-local URL literal: ${literal}`);
  }
}

/*
 * Remotely hosted code is forbidden by Manifest V3 and by this extension's own
 * SECURITY.md. Catch the ways it sneaks back in.
 */
const CODE_LOADERS = [
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/\bimportScripts\s*\(/, 'importScripts()'],
  [/document\.write\s*\(/, 'document.write()'],
];

for (const { path, text } of sources) {
  for (const [re, label] of CODE_LOADERS) {
    if (re.test(text)) fail(`${path} uses ${label}`);
  }
}

/*
 * innerHTML assigned a STATIC string is fine and the code uses it for a spinner
 * and a stop button. innerHTML assigned a variable or an interpolated template
 * is the DOM-XSS shape: markup built from page or server data, injected into a
 * page the extension has privileged access to. So the assignment is allowed only
 * when its right-hand side is a literal with no `${...}` in it - which forces a
 * human to look at any dynamic case rather than the check waving it through.
 */
for (const { path, text } of sources) {
  const re = /\.innerHTML\s*=\s*/g;
  let m;
  while ((m = re.exec(text))) {
    const rhsStart = m.index + m[0].length;
    const ch = text[rhsStart];
    if (ch === "'" || ch === '"') continue; // quoted literal: no interpolation possible
    if (ch === '`') {
      const end = text.indexOf('`', rhsStart + 1);
      const body = end === -1 ? text.slice(rhsStart + 1) : text.slice(rhsStart + 1, end);
      if (!body.includes('${')) continue; // static template literal
      fail(`${path} assigns an interpolated template literal to innerHTML - build the node with textContent/createElement instead`);
      continue;
    }
    const near = text.slice(m.index, rhsStart + 24).replace(/\s+/g, ' ');
    fail(`${path} assigns a dynamic value to innerHTML ("${near}...") - build the node with textContent/createElement instead`);
  }
}

// ---------------------------------------------------------------------------

const checked = [
  `${sources.length} source files`,
  `${declared.size} permissions`,
  `${usedNamespaces.size} chrome API namespaces`,
];

if (failures.length) {
  console.error(`audit FAILED (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`audit ok: ${checked.join(', ')}`);
console.log(`  permissions: ${[...declared].sort().join(', ')}`);
console.log(`  chrome APIs: ${[...usedNamespaces].sort().join(', ')}`);
