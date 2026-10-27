# Foxl 0.10.0 release review

Date: October 27, 2026. Real app: Foxl Desktop 0.9.3, Chrome development extension 0.10.0.

## Functional evidence

| Check | Evidence |
| --- | --- |
| Real connection | Panel and settings reported the connected Desktop version; Check connection succeeded. |
| Read a page | Submitted the built-in summary prompt on NASA’s Cosmic Cliffs page; received a real three-bullet answer. |
| Current page | Context showed the selected NASA page, followed actual navigation to Europa Clipper, and disappeared for Chrome’s extension settings page. |
| Exclude page | Toggled page context off, then asked to simplify the second bullet; the response correctly used the previous conversation. |
| Follow-up | Asked for the two Europa Clipper facts in one sentence; received the launch date and destination from the preceding answer. |
| Browser input and navigation | Foxl submitted NASA’s search box for Europa Clipper, reached its public mission page in the same tab, and returned the requested facts. |
| Input | Paste, editable suggestion, Shift+Enter without submission, and Enter to submit worked in the loaded panel. |
| New chat | The transcript cleared and the connected welcome state returned. |
| Appearance | Light/Dark changes applied to both settings and the open panel; Light persisted after reload. Dark captures are excluded from the gallery at the owner’s request. |
| Lost connection and ownership | Source handles socket closure explicitly and routes responses to their originating panel/request; current-window, IME, history, and input deadline regressions are covered by the node suite. |

Desktop 0.9.3 returns these panel answers on completion. The panel truthfully shows
waiting feedback while the real request runs; this gallery makes no speed or
streaming claim. The gallery does not advertise Stop as a side-panel capability.

## Visual acceptance

- All upload images use actual native product pixels and real responses.
- All gallery images use Light appearance.
- Conversation and composer use 16px Geist; panel crops retain normal display size.
- The large welcome logo and inner header mark were removed. Chrome supplies the
  side-panel brand mark; the settings page keeps one brand mark.
- The composer uses Foxl’s 26px radius and a 36px circular send control.
- Marketing headings remain outside the captured UI. No ratings, usage counts,
  testimonials, provider promises, invented answers, or artificial UI states.
- Each PNG is opaque RGB and matches its Chrome Web Store upload dimensions.
- Public page credits, URLs, raw captures, crop rectangles, and hashes are retained.

## Automated checks

Final release checks:

```sh
node scripts/audit.mjs
node --test --test-concurrency=1 scripts/*.test.mjs
node scripts/build.mjs
```

The source audit passed for 11 source files, seven permissions, and ten Chrome
namespaces. All 15 node tests passed with zero failures. The release build uses
its existing deterministic allowlist and adds no runtime dependencies. No
production data directory was used by the automated checks.

Two consecutive builds produced byte-identical packages. The versioned and
`latest` ZIP files also match each other. Archive integrity passed, the manifest
reports version 0.10.0, and all 27 packaged files match the release source bytes.

| Artifact | Final result |
| --- | --- |
| Package | `foxl-browser-extension-0.10.0.zip` |
| Size | 225,409 bytes |
| Entries | 27 files |
| SHA-256 | `481d521c29e45fa60a01e6e078327e43d588e60bf9547cde7e111bc20bbdff8f` |
| Reproducibility | Two builds and both ZIP filenames have the same digest. |
| Gallery provenance | All 21 source hashes in the render manifest match the release source. |
| README captures | Both RGB images exactly match their recorded native-capture crop pixels. |

Local release artifacts include `SHA256SUMS.txt`, `RELEASE-NOTES.md`, and
`VALIDATION.json`. Chrome Web Store submission status is recorded separately
from the local Git release; preparing the package does not imply store approval.
