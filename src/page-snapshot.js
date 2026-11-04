/**
 * Explicit snapshot baselines: a caller supplies the id it actually saw. A new
 * document, another tab, an expired baseline, or a changed filter returns a full
 * snapshot. No implicit baseline survives a model's context compaction.
 */
import { readAllowedPage } from './page-capture.js';

const snapshots = new Map();
const MAX_BASELINES = 32;
const BASELINE_TTL_MS = 5 * 60_000;

export async function getPageSnapshot(tabId, options = {}) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('A target tab is required for a snapshot.');
  const filter = options.filter || 'visible';
  const depth = options.depth ?? 15;
  const maxChars = options.maxChars ?? 12_000;
  const maxLines = options.maxLines ?? 200;
  if (!['visible', 'interactive', 'all'].includes(filter)
    || !Number.isInteger(depth) || depth < 1 || depth > 50
    || !Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 60_000
    || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > 1000) {
    throw new Error('Invalid snapshot filter, depth, maxChars (1000-60000), or maxLines (1-1000).');
  }
  // Bound the actual tree read too: Chrome can leave a scripting request pending
  // while site access is withheld, even on a previously injected page.
  const page = await readAllowedPage(tabId, ({ filter, depth }) => {
      if (!window.__generateAccessibilityTree) throw new Error('The page reader is not ready. Reload the page.');
      const tree = window.__generateAccessibilityTree(filter, depth);
      if (tree.error) throw new Error(tree.error);
      return { ...tree, url: location.href, title: document.title };
    }, [{ filter, depth }]);
  if (typeof page.pageContent !== 'string') {
    throw new Error('Chrome returned no page snapshot.');
  }
  const allLines = page.pageContent.split('\n').filter((line) => line.trim());
  const lines = [];
  let chars = 0;
  for (const line of allLines) {
    if (lines.length >= maxLines || chars + line.length + 1 > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const now = Date.now();
  /*
   * WHAT THE KEPT LINES CUT AND HIDE (#6245). `truncated` counts dropped LINES only; each line now
   * marks its own cut text (`clipped=`, `clipped_value=`) and, under filter "all", what is not
   * shown (`hidden`, `aria-hidden`), and these totals cover the lines this answer keeps. A page
   * whose reader predates 0.11.0 (a tab opened before the update, until it reloads) reports no
   * `readMarks`, and then none of these fields is claimed.
   */
  const keptRefs = new Set(lines.map((line) => /\[(ref_[^\]\s]+)\]/.exec(line)?.[1]).filter(Boolean));
  const marks = page.readMarks ? {
    readMarks: page.readMarks,
    clippedElements: (Array.isArray(page.clippedElements) ? page.clippedElements : []).filter((c) => keptRefs.has(c.ref)),
    hiddenElements: lines.filter((line) => /(?:^|\s)(?:aria-)?hidden(?=\s|$)/.test(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'))).length,
  } : {};
  const blocked = Array.isArray(page.blockedPopups) && page.blockedPopups.length ? { blockedPopups: page.blockedPopups } : {};
  for (const [id, saved] of snapshots) if (now - saved.at > BASELINE_TTL_MS) snapshots.delete(id);
  const key = JSON.stringify({ tabId, documentId: page.documentId, url: page.url, filter, depth, maxChars, maxLines });
  const previous = options.since ? snapshots.get(options.since) : null;
  const fullText = lines.join('\n') || '(no matching elements)';
  let text = fullText;
  let mode = 'full';
  if (previous?.key === key) {
    let prefix = 0;
    while (prefix < lines.length && prefix < previous.lines.length && lines[prefix] === previous.lines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < lines.length - prefix && suffix < previous.lines.length - prefix
      && lines[lines.length - 1 - suffix] === previous.lines[previous.lines.length - 1 - suffix]) suffix++;
    const removed = previous.lines.slice(prefix, previous.lines.length - suffix);
    const added = lines.slice(prefix, lines.length - suffix);
    const diff = removed.length || added.length
      ? [`@@ line ${prefix + 1}, remove ${removed.length}, add ${added.length} @@`,
        ...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].join('\n')
      : '(no changes)';
    if (diff.length < fullText.length) { text = diff; mode = 'diff'; }
  }
  const snapshotId = crypto.randomUUID();
  snapshots.set(snapshotId, { key, lines, at: now });
  while (snapshots.size > MAX_BASELINES) snapshots.delete(snapshots.keys().next().value);
  return {
    success: true, tabId, snapshotId, mode, ...(mode === 'diff' ? { baseSnapshotId: options.since } : {}),
    url: page.url, title: page.title, viewport: page.viewport,
    pageContent: text, truncated: lines.length < allLines.length,
    returnedLines: lines.length, totalLines: allLines.length,
    ...marks, ...blocked,
  };
}

export function clearPageSnapshots(tabId) {
  if (tabId === undefined) { snapshots.clear(); return; }
  for (const [id, entry] of snapshots) {
    if (JSON.parse(entry.key).tabId === tabId) snapshots.delete(id);
  }
}
