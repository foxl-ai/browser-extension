// Where the extension may connect: Foxl Desktop on this computer, nowhere else (src/server-url.js,
// foxl-ai/pilot #7806). No chrome.* API, so this runs under plain node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopbackServerUrl, serverUrlHost } from '../src/server-url.js';

test('a loopback address on any port is accepted, as its origin', () => {
  assert.equal(loopbackServerUrl('http://localhost:13847'), 'http://localhost:13847');
  assert.equal(loopbackServerUrl('  http://localhost:3847/  '), 'http://localhost:3847');
  assert.equal(loopbackServerUrl('http://127.0.0.1:13847/api'), 'http://127.0.0.1:13847');
  assert.equal(loopbackServerUrl('http://[::1]:13847'), 'http://[::1]:13847');
  assert.equal(loopbackServerUrl('https://localhost:8443'), 'https://localhost:8443');
  assert.equal(loopbackServerUrl('HTTP://LOCALHOST:13847'), 'http://localhost:13847');
  // A user name in the setting never reaches a request.
  assert.equal(loopbackServerUrl('http://someone@localhost:13847'), 'http://localhost:13847');
});

test('any other host, scheme or shape is refused', () => {
  for (const value of [
    'http://desktop.example:13847',
    'https://desktop.example',
    'http://203.0.113.5:13847',
    'http://localhost.example:13847',
    'http://localhost:13847@desktop.example',
    'http://localhost.:13847',
    'http://foxl.localhost:13847',
    'http://127.0.0.2:13847',
    'http://[::ffff:127.0.0.1]:13847',
    'ws://localhost:13847',
    'file:///tmp/x',
    'localhost:13847',
    'not a url',
    '',
    '   ',
    null,
    undefined,
    42,
  ]) {
    assert.equal(loopbackServerUrl(value), null, JSON.stringify(value));
  }
});

test('a refused address is named by its host', () => {
  assert.equal(serverUrlHost('http://desktop.example:13847/x'), 'desktop.example:13847');
  assert.equal(serverUrlHost('not a url'), null);
});
