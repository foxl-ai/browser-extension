# Shared Chrome: live evidence

Measured November 13, 2026 with the actual unpacked extension (0.12.2 source),
Playwright Chromium 156 and agent-browser 0.41.2, using a disposable profile and a
fictional local account. No personal browser or login was used.

The desktop companion's `scripts/probe-shared-chrome.mjs` ran the real internal browser,
extension commands and take-over runtime together. The Chrome and CDP implementations
were real; the local website supplied only the fictional account and controls.

- The internal browser read an HttpOnly authenticated page and localStorage established
  in the already running Chrome.
- The extension edited the same tab; the internal tool read its full value and the
  original page saw the internal tool's document marker.
- Concurrent CDP clients remained separate. Page-origin access, unregistered tabs,
  bulk cookie export, closing an existing tab and quitting Chrome were refused.
- The take-over stream displayed that tab, and its input changed the original page to
  **Clicks: 1**. Extension input was refused during take-over. The internal tool resumed
  on the unchanged document.
- Disconnect and reconnect preserved Chrome, its other tabs and its login state.

Evidence: [results](results.json), [assertion output](probe-output.txt),
[streamed frame before the tap](shared-screen.jpg), [same tab after the tap](same-tab.png).
The text field is visually clipped; the probe asserts its full value,
`Edited through the extension`.

The probe uses the viewer's actual protocol directly; this is not a screenshot of the
full Electron window. Chromium ran headless for reproducibility. It proves shared
identity and page control, not acceptance by a particular site's bot protection.

From the companion desktop checkout's `foxl/` directory:

```sh
FOXL_SHARED_EXTENSION_DIR=/path/to/this/checkout \
  node --import tsx scripts/probe-shared-chrome.mjs
```

Use the shared `heavy.sh` wrapper on the shared development Mac. The script prints a
temporary evidence directory and exits nonzero on failure. The standard JS desktop
and this extension change must ship together; experimental Rust standalone is excluded.
See the main README and privacy policy for the expanded debugger scope and its limits.
