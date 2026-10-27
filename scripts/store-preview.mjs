#!/usr/bin/env node
// Local artwork preview. No desktop, credentials, installed extension or
// service worker is involved. Production UI assets are read without edits.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = resolve(root, 'store');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};
const jsonScript = (data) => JSON.stringify(data).replaceAll('<', '\\u003c');

const server = createServer(async (req, res) => {
  try {
    const [fixtures, copy] = await Promise.all(
      ['fixtures.json', 'gallery.en.json'].map(async (file) =>
        JSON.parse(await readFile(resolve(store, file), 'utf8'))),
    );
    const url = new URL(req.url, 'http://127.0.0.1');
    const scene = url.searchParams.get('scene') ?? 'research';
    if (!(scene in fixtures)) throw new Error('Unknown scene');
    let path = decodeURIComponent(url.pathname);
    let body;
    let type = 'text/html; charset=utf-8';
    if (path === '/') {
      body = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Foxl store artwork</title>
        <style>body{font:18px system-ui;max-width:850px;margin:60px auto;color:#121212}a{color:#2e67b8}li{margin:16px 0}p{line-height:1.6}</style>
        <h1>Foxl Chrome Web Store artwork</h1><p>Shipping extension 0.9.0. Real UI source, illustrative workflows.</p>
        <ol>${copy.slides.map((s) => `<li><a href="/artwork?slide=${s.id}">${s.headline.join(' ')}</a> <small>1280 × 800</small></li>`).join('')}</ol>
        <p><a href="/artwork?slide=small">Small promotional tile</a> · <a href="/artwork?slide=marquee">Marquee</a></p>
        <p><a href="/raw?scene=research">Inspect the real side panel</a> · <a href="/raw?scene=setup">Inspect the first-run state</a></p></html>`;
    } else if (path === '/raw') {
      body = (await readFile(resolve(root, 'sidepanel.html'), 'utf8')).replace(
        '<head>',
        `<head><base href="/extension/"><script>window.captureFixture=${jsonScript(fixtures[scene])}</script><script src="/store/source/runtime-fixture.js"></script>`,
      );
    } else if (path === '/page') {
      body = (await readFile(resolve(store, 'source/demo-page.html'), 'utf8')).replace(
        '<head>',
        `<head><script>window.captureFixture=${jsonScript(fixtures[scene])}</script><script src="/store/source/runtime-fixture.js"></script>`,
      );
    } else if (path === '/artwork') {
      const slideId = url.searchParams.get('slide') ?? copy.slides[0].id;
      const slide = copy.slides.find((s) => s.id === slideId) ?? { id: slideId };
      if (!copy.slides.includes(slide) && !['small', 'marquee'].includes(slideId)) throw new Error('Unknown slide');
      body = (await readFile(resolve(store, 'source/artwork.html'), 'utf8')).replace(
        '<head>',
        `<head><script>window.artwork=${jsonScript({ slide, copy })}</script>`,
      );
    } else {
      let allowedRoot = root;
      if (path.startsWith('/extension/')) {
        path = path.slice('/extension/'.length);
        if (!/^(styles\/[\w.-]+|src\/sidepanel\.js|src\/content-scripts\/visual-indicator\.js|icons\/[\w.-]+)$/.test(path)) {
          throw new Error('Not a capture asset');
        }
      } else if (path.startsWith('/store/')) {
        path = path.slice(1);
        allowedRoot = store;
      } else throw new Error('Not found');
      const file = await realpath(resolve(root, path));
      if (!file.startsWith(allowedRoot + sep)) throw new Error('Outside capture assets');
      body = await readFile(file);
      type = types[extname(file)] ?? 'application/octet-stream';
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(`Foxl artwork preview: http://127.0.0.1:${server.address().port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
