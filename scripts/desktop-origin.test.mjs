// Foxl Desktop's own address is never a page Foxl works in (src/desktop-origin.js, foxl-ai/pilot #8212). No chrome.*
// API, so this runs under plain node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePort, isDesktopAddress, isLoopbackHost, portOf } from '../src/desktop-origin.js';

const PORTS = new Set([13847, 3847, 41234]);

test('every spelling of this computer on a desktop port is the desktop\'s address', () => {
  for (const value of [
    'http://localhost:13847/',
    'http://localhost:3847/settings?x=1#y',
    'https://localhost:13847/',
    'http://LOCALHOST:13847/',
    'http://localhost.:13847/',
    'http://foxl.localhost:13847/',
    'http://a.b.localhost.:3847/',
    'http://127.0.0.1:13847/',
    'http://127.1:13847/',
    'http://127.255.255.254:3847/',
    'http://2130706433:13847/',
    'http://0x7f000001:13847/',
    'http://0177.0.0.1:13847/',
    'http://0.0.0.0:13847/',
    'http://0:3847/',
    'http://[::1]:13847/',
    'http://[0:0:0:0:0:0:0:1]:13847/',
    'http://[::]:13847/',
    'http://[::ffff:127.0.0.1]:13847/',
    'http://[::ffff:7f00:1]:3847/',
    'http://[::ffff:0.0.0.0]:13847/',
    'http://someone:secret@localhost:13847/',
    '  http://localhost:41234/  ',
  ]) {
    assert.equal(isDesktopAddress(value, PORTS), true, JSON.stringify(value));
  }
});

test('another port on this computer, another host, another scheme or no URL at all is not', () => {
  for (const value of [
    'http://localhost:5173/',
    'http://127.0.0.1:8080/',
    'http://localhost/',
    'https://localhost/',
    'http://[::1]:5173/',
    'http://localhost.example:13847/',
    'http://localhost:13847.example/',
    'http://desktop.example:13847/',
    'http://203.0.113.5:13847/',
    'http://128.0.0.1:13847/',
    'http://10.0.0.1:13847/',
    'http://[::2]:13847/',
    'http://[::ffff:8000:1]:13847/',
    'http://[fe80::1]:13847/',
    'http://evil.example/http://localhost:13847/',
    'http://localhost:13847@desktop.example/',
    'ws://localhost:13847/extension',
    'file:///tmp/x',
    'about:blank',
    'localhost:13847',
    'not a url',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isDesktopAddress(value, PORTS), false, JSON.stringify(value));
  }
});

test('a desktop on a scheme\'s default port is found by that port', () => {
  assert.equal(isDesktopAddress('http://localhost/', new Set([80])), true);
  assert.equal(isDesktopAddress('https://127.0.0.1/', new Set([443])), true);
  assert.equal(isDesktopAddress('https://127.0.0.1/', new Set([80])), false);
});

test('the pieces: loopback hosts, ports', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost(''), false);
  assert.equal(isLoopbackHost(undefined), false);
  assert.equal(effectivePort(new URL('http://localhost:13847/')), 13847);
  assert.equal(effectivePort(new URL('http://localhost/')), 80);
  assert.equal(effectivePort(new URL('https://localhost/')), 443);
  assert.equal(effectivePort(new URL('ftp://localhost/')), null);
  assert.equal(portOf('http://localhost:3847'), 3847);
  assert.equal(portOf('not a url'), null);
  assert.equal(portOf(null), null);
});
