/**
 * Pilot Visual Indicator
 * 
 * Shows visual feedback when Pilot agent is active on a page.
 * - Glowing border animation
 * - "Stop Pilot" button
 * - Status indicator
 */

(function() {
  let glowBorder = null;
  let stopContainer = null;
  let statusIndicator = null;
  let isActive = false;

  // Pilot brand color (teal/cyan)
  const PILOT_COLOR = 'rgba(20, 184, 166, 0.7)'; // teal-500
  const PILOT_COLOR_LIGHT = 'rgba(20, 184, 166, 0.3)';
  const PILOT_COLOR_FAINT = 'rgba(20, 184, 166, 0.1)';

  /**
   * Inject animation styles
   */
  function injectStyles() {
    if (document.getElementById('pilot-agent-styles')) return;

    const style = document.createElement('style');
    style.id = 'pilot-agent-styles';
    style.textContent = `
      @keyframes pilot-pulse {
        0% {
          box-shadow: 
            inset 0 0 10px ${PILOT_COLOR},
            inset 0 0 20px ${PILOT_COLOR_LIGHT},
            inset 0 0 30px ${PILOT_COLOR_FAINT};
        }
        50% {
          box-shadow: 
            inset 0 0 15px ${PILOT_COLOR},
            inset 0 0 25px ${PILOT_COLOR_LIGHT},
            inset 0 0 35px ${PILOT_COLOR_FAINT};
        }
        100% {
          box-shadow: 
            inset 0 0 10px ${PILOT_COLOR},
            inset 0 0 20px ${PILOT_COLOR_LIGHT},
            inset 0 0 30px ${PILOT_COLOR_FAINT};
        }
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Create the glowing border element
   */
  function createGlowBorder() {
    const border = document.createElement('div');
    border.id = 'pilot-agent-glow-border';
    border.setAttribute('data-foxl-ui', '');
    border.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 2147483646;
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
      animation: pilot-pulse 2s ease-in-out infinite;
      box-shadow: 
        inset 0 0 10px ${PILOT_COLOR},
        inset 0 0 20px ${PILOT_COLOR_LIGHT},
        inset 0 0 30px ${PILOT_COLOR_FAINT};
    `;
    return border;
  }

  /**
   * Create the stop button container
   */
  function createStopContainer() {
    const container = document.createElement('div');
    container.id = 'pilot-agent-stop-container';
    container.setAttribute('data-foxl-ui', '');
    container.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      justify-content: center;
      align-items: center;
      pointer-events: none;
      z-index: 2147483647;
    `;

    const button = document.createElement('button');
    button.id = 'pilot-agent-stop-button';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" style="margin-right: 12px; vertical-align: middle;">
        <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>
      </svg>
      <span style="vertical-align: middle;">Stop Foxl</span>
    `;
    button.style.cssText = `
      position: relative;
      transform: translateY(100px);
      padding: 12px 16px;
      background: #18181b;
      color: #fafafa;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 
        0 40px 80px rgba(20, 184, 166, 0.24),
        0 4px 14px rgba(20, 184, 166, 0.24);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      opacity: 0;
      user-select: none;
      pointer-events: auto;
      white-space: nowrap;
      margin: 0 auto;
    `;

    button.addEventListener('mouseenter', () => {
      if (isActive) {
        button.style.background = '#27272a';
        button.style.boxShadow = '0 40px 80px rgba(20, 184, 166, 0.3), 0 4px 14px rgba(20, 184, 166, 0.3)';
      }
    });

    button.addEventListener('mouseleave', () => {
      if (isActive) {
        button.style.background = '#18181b';
        button.style.boxShadow = '0 40px 80px rgba(20, 184, 166, 0.24), 0 4px 14px rgba(20, 184, 166, 0.24)';
      }
    });

    button.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
      } catch (err) {
        console.error('[Pilot] Failed to stop agent:', err);
      }
    });

    container.appendChild(button);
    return container;
  }

  /**
   * Show the agent indicators
   */
  function showIndicators() {
    isActive = true;
    injectStyles();

    if (!glowBorder) {
      glowBorder = createGlowBorder();
      document.body.appendChild(glowBorder);
    } else {
      glowBorder.style.display = '';
    }

    if (!stopContainer) {
      stopContainer = createStopContainer();
      document.body.appendChild(stopContainer);
    } else {
      stopContainer.style.display = '';
    }

    // Animate in
    requestAnimationFrame(() => {
      if (glowBorder) {
        glowBorder.style.opacity = '1';
      }
      if (stopContainer) {
        const button = stopContainer.querySelector('#pilot-agent-stop-button');
        if (button) {
          button.style.transform = 'translateY(0)';
          button.style.opacity = '1';
        }
      }
    });
  }

  /**
   * Hide the agent indicators
   */
  function hideIndicators() {
    if (!isActive) return;
    isActive = false;

    if (glowBorder) {
      glowBorder.style.opacity = '0';
    }

    if (stopContainer) {
      const button = stopContainer.querySelector('#pilot-agent-stop-button');
      if (button) {
        button.style.transform = 'translateY(100px)';
        button.style.opacity = '0';
      }
    }

    // Remove after animation
    setTimeout(() => {
      if (!isActive) {
        if (glowBorder?.parentNode) {
          glowBorder.parentNode.removeChild(glowBorder);
          glowBorder = null;
        }
        if (stopContainer?.parentNode) {
          stopContainer.parentNode.removeChild(stopContainer);
          stopContainer = null;
        }
      }
    }, 300);
  }

  /**
   * Highlight a specific element temporarily
   */
  function highlightElement(refId, duration = 1000) {
    const element = window.__pilotGetElement?.(refId);
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const highlight = document.createElement('div');
    highlight.setAttribute('data-foxl-ui', '');
    highlight.style.cssText = `
      position: fixed;
      top: ${rect.top - 4}px;
      left: ${rect.left - 4}px;
      width: ${rect.width + 8}px;
      height: ${rect.height + 8}px;
      border: 2px solid ${PILOT_COLOR};
      border-radius: 4px;
      background: ${PILOT_COLOR_FAINT};
      pointer-events: none;
      z-index: 2147483645;
      transition: opacity 0.3s ease-out;
    `;
    document.body.appendChild(highlight);

    setTimeout(() => {
      highlight.style.opacity = '0';
      setTimeout(() => {
        highlight.parentNode?.removeChild(highlight);
      }, 300);
    }, duration);
  }

  // Listen for messages from service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    /*
     * An input action carries its deadline (src/input-queue.js). A message that reaches the
     * page after it - it waited behind a confirm() dialog or a hung script - is refused, not
     * performed: by then Foxl Desktop has told the model the action failed, and doing it now
     * would act behind the model's back (and twice, if it retried).
     */
    if (typeof message.deadline === 'number' && Date.now() > message.deadline) {
      sendResponse({ success: false, nothingWasDone: true, error: 'This action reached the page after its deadline (the page was showing a dialog, or busy), so nothing was done. Take a snapshot to see the page.' });
      return true;
    }
    switch (message.type) {
      case 'SHOW_AGENT_INDICATORS':
        showIndicators();
        sendResponse({ success: true });
        break;

      case 'HIDE_AGENT_INDICATORS':
        hideIndicators();
        sendResponse({ success: true });
        break;

      case 'HIGHLIGHT_ELEMENT':
        highlightElement(message.refId, message.duration);
        sendResponse({ success: true });
        break;

      /*
       * Hide Foxl's overlay for a screenshot, so the model is not shown a "Stop Foxl" button
       * to aim at (or a border it takes for the page). `visibility` is not transitioned, so it
       * takes effect on the next frame; the answer waits for that frame (or 150 ms, for a tab
       * that does not paint).
       */
      case 'SET_OVERLAY_HIDDEN': {
        const visibility = message.hidden ? 'hidden' : '';
        document.querySelectorAll('[data-foxl-ui]').forEach((el) => { el.style.visibility = visibility; });
        let answered = false;
        const answer = () => { if (!answered) { answered = true; sendResponse({ success: true }); } };
        requestAnimationFrame(() => requestAnimationFrame(answer));
        setTimeout(answer, 150);
        break;
      }

      case 'GET_ACCESSIBILITY_TREE':
        try {
          const result = window.__generateAccessibilityTree?.(
            message.filter,
            message.depth,
            message.maxChars,
            message.refId
          );
          sendResponse({ success: true, data: result });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;

      case 'CLICK_ELEMENT':
        try {
          const result = window.__pilotClickElement?.(message.refId);
          sendResponse(result || { success: false, error: 'Function not available' });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;

      case 'TYPE_IN_ELEMENT':
        try {
          const result = window.__pilotTypeInElement?.(message.refId, message.text, message.submit);
          sendResponse(result || { success: false, error: 'Function not available' });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;

      case 'SELECT_OPTION':
        try {
          const result = window.__pilotSelectOption?.(message.refId, message.value);
          sendResponse(result || { success: false, error: 'Function not available' });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;

      /*
       * The pieces the service worker composes into click / type / key / hover. Each
       * answers a plain object, including how it acted (`method`).
       */
      case 'FOCUS_ELEMENT':
      case 'ELEMENT_INFO':
      case 'FOCUS_FOR_TYPING':
      case 'READ_VALUE':
      case 'INSERT_TEXT_FALLBACK':
      case 'CLICK_FALLBACK':
      case 'CLICK_AT_FALLBACK':
      case 'HOVER_FALLBACK':
      case 'KEY_FALLBACK':
        try {
          const fn = {
            FOCUS_ELEMENT: () => window.__pilotFocusElement?.(message.refId),
            ELEMENT_INFO: () => window.__pilotElementInfo?.(message.refId),
            FOCUS_FOR_TYPING: () => window.__pilotFocusForTyping?.(message.refId),
            READ_VALUE: () => window.__pilotReadValue?.(message.refId),
            INSERT_TEXT_FALLBACK: () => window.__pilotInsertTextFallback?.(message.refId, message.text),
            CLICK_FALLBACK: () => window.__pilotClickFallback?.(message.refId),
            CLICK_AT_FALLBACK: () => window.__pilotClickAtFallback?.(message.x, message.y),
            HOVER_FALLBACK: () => window.__pilotHoverFallback?.(message.refId, message.x, message.y),
            KEY_FALLBACK: () => window.__pilotKeyFallback?.(message.key, message.refId),
          }[message.type];
          sendResponse(fn() || { success: false, error: 'Function not available' });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;
    }
    return true; // Keep channel open for async response
  });

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    hideIndicators();
  });
})();
