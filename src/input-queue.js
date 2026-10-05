/**
 * ONE INPUT AT A TIME, PER TAB, AND NEVER LATE.
 *
 * Clicks, typing, keys and hovers share a page's focus, as one person's keyboard and mouse
 * do. Foxl Desktop runs the tool calls a model makes in one message concurrently, and each of
 * these commands is several page messages, so on one tab they must not interleave (a click
 * landing between typing and its Enter sent the Enter to the wrong element).
 *
 * But a page can stop answering: a button whose handler calls confirm() holds its tab until
 * the dialog is closed, and so does a hung script. The first queue was one chain for the
 * whole browser with no timeout, so such a page stalled every tab's input, the desktop timed
 * out on actions that had not run, and they ran later anyway - after the model had been told
 * they failed, and possibly twice after it retried. So:
 *
 *   - the queue is keyed by TAB: a stuck tab holds only its own input;
 *   - every action has a DEADLINE (`INPUT_DEADLINE_MS` after it was queued, below the
 *     desktop's 30 s command timeout). The next action on the tab waits for this one to
 *     answer OR for its deadline, whichever is first, so a stuck action cannot hold the
 *     tab's queue forever;
 *   - an action that reaches its turn after its own deadline, or with under 2 s of it left,
 *     is REFUSED, not run, with an error that says nothing was done. The deadline also rides
 *     on every page message the action sends, and the page refuses a message that arrives
 *     after it (content script, visual-indicator.js), which covers a message that was already
 *     waiting on a blocked page;
 *   - `stop()` (the page's Stop Foxl button) answers every action still waiting at once, as
 *     not done, and none of them runs when its turn comes.
 *
 * No chrome.* API here, so scripts/input-queue.test.mjs runs it under plain node.
 */

/** Below Foxl Desktop's 30 s command timeout, so a refusal reaches the model as an answer. */
export const INPUT_DEADLINE_MS = 25000;

export function nothingWasDone(error) {
  return { success: false, error, nothingWasDone: true };
}

/**
 * @param {{ deadlineMs?: number }} [opts]
 * @returns {{ run: (key: unknown, action: (deadline: number) => Promise<unknown>) => Promise<unknown>, stop: () => void, size: () => number }}
 */
export function createInputQueue({ deadlineMs = INPUT_DEADLINE_MS } = {}) {
  /** An action is not STARTED with less than this left before its deadline (2 s at 25 s). */
  const minLeftMs = Math.min(2000, deadlineMs / 10);
  /** tab key -> a promise that settles when the tab's last queued action answered or ran out of time. */
  const tails = new Map();
  /** Actions queued and not yet started: Stop answers them at once. */
  const waiting = new Set();
  const STOPPED = 'Foxl was stopped before this action ran, so nothing was done.';

  function run(key, action) {
    const queuedAt = Date.now();
    const deadline = queuedAt + deadlineMs;
    const prev = tails.get(key) || Promise.resolve();
    const entry = { stopped: false, answer: null };
    const answeredByStop = new Promise((resolve) => { entry.answer = resolve; });
    waiting.add(entry);
    // `turn` is when this action really gets the tab, and what the NEXT action waits for -
    // even after Stop answered this one early - so the tab stays one action at a time.
    const turn = prev.then(() => {
      waiting.delete(entry);
      if (entry.stopped) return nothingWasDone(STOPPED);
      const waited = Date.now() - queuedAt;
      // Not started with too little time left: its page messages would reach the page after
      // the deadline (and be refused there), or its answer too close to the desktop's timeout.
      if (deadline - Date.now() < minLeftMs) {
        return nothingWasDone(`This action waited ${Math.round(waited / 1000)} s behind an earlier one on the same tab that never finished (the page may be showing a dialog, or be busy), so nothing was done. Take a screenshot or snapshot to see the page.`);
      }
      return action(deadline);
    });
    let timer;
    const outOfTime = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); });
    const tail = Promise.race([turn.then(() => {}, () => {}), outOfTime]).then(() => clearTimeout(timer));
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return Promise.race([turn, answeredByStop]);
  }

  return {
    run,
    /**
     * Stop pressed: every action still waiting is answered NOW, as not done, and will not run
     * when its turn comes. An action already running is not undone.
     */
    stop() {
      for (const entry of waiting) {
        entry.stopped = true;
        entry.answer(nothingWasDone(STOPPED));
      }
      waiting.clear();
    },
    size: () => tails.size,
  };
}
