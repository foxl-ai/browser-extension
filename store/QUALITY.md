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

Run through the shared Mac queue:

```sh
/Users/sanghwa/.claude/shared/heavy.sh /bin/zsh -c 'node scripts/audit.mjs && node --test scripts/*.test.mjs && node scripts/build.mjs'
```

The permission audit passed with seven permissions. All 15 node tests passed.
The release build uses its existing deterministic allowlist and no new runtime
dependencies. A final rebuild and archive comparison is recorded with the release
artifacts. No production data directory is used by the automated checks.
