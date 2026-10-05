/**
 * Pilot Accessibility Tree Generator
 * 
 * Generates a structured accessibility tree from the DOM for AI agent interaction.
 * Based on Claude's approach but simplified for Pilot.
 * 
 * Key features:
 * - Creates ref IDs for interactive elements (ref_1, ref_2, etc.)
 * - Uses WeakRef to track elements without memory leaks
 * - Filters by visibility, interactivity, and semantic roles
 * - Returns structured text representation of the page
 */

(function() {
  // Initialize global state
  window.__pilotElementMap = window.__pilotElementMap || {};
  window.__pilotRefCounter = window.__pilotRefCounter || 0;

  /**
   * The element a person types into on a rich-text editor: the OUTERMOST contenteditable.
   * Gmail's compose body, Slack's and Notion's message boxes are all one of these. The tree
   * used to list them only for a literal `contenteditable="true"` and called them
   * `generic`, so a model had no way to tell the editor apart from a div.
   */
  function isEditingHost(element) {
    return !!element.isContentEditable && !(element.parentElement && element.parentElement.isContentEditable);
  }

  /** Is `node` inside `ancestor`, crossing open shadow-root boundaries? */
  function composedContains(ancestor, node) {
    for (let n = node; n; n = n.parentNode || n.host) {
      if (n === ancestor) return true;
    }
    return false;
  }

  /** The focused element, looking through open shadow roots. */
  function deepActiveElement() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  /**
   * Get the semantic role of an element
   */
  function getRole(element) {
    const explicitRole = element.getAttribute('role');
    if (explicitRole) return explicitRole;
    if (isEditingHost(element)) return 'textbox';

    const tagName = element.tagName.toLowerCase();
    const inputType = element.getAttribute('type');

    const roleMap = {
      'a': 'link',
      'button': 'button',
      'input': inputType === 'submit' || inputType === 'button' ? 'button' :
               inputType === 'checkbox' ? 'checkbox' :
               inputType === 'radio' ? 'radio' :
               inputType === 'file' ? 'button' : 'textbox',
      'select': 'combobox',
      'textarea': 'textbox',
      'h1': 'heading',
      'h2': 'heading',
      'h3': 'heading',
      'h4': 'heading',
      'h5': 'heading',
      'h6': 'heading',
      'img': 'image',
      'nav': 'navigation',
      'main': 'main',
      'header': 'banner',
      'footer': 'contentinfo',
      'section': 'region',
      'article': 'article',
      'aside': 'complementary',
      'form': 'form',
      'table': 'table',
      'ul': 'list',
      'ol': 'list',
      'li': 'listitem',
      'label': 'label'
    };

    return roleMap[tagName] || 'generic';
  }

  /**
   * Get accessible name/label for an element
   */
  function getAccessibleName(element) {
    const tagName = element.tagName.toLowerCase();

    // Handle select elements
    if (tagName === 'select') {
      const selectedOption = element.querySelector('option[selected]') || 
                            element.options[element.selectedIndex];
      if (selectedOption?.textContent) {
        return selectedOption.textContent.trim();
      }
    }

    // Check aria-label
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel?.trim()) return ariaLabel.trim();

    // Check placeholder
    const placeholder = element.getAttribute('placeholder');
    if (placeholder?.trim()) return placeholder.trim();

    // Check title
    const title = element.getAttribute('title');
    if (title?.trim()) return title.trim();

    // Check alt (for images)
    const alt = element.getAttribute('alt');
    if (alt?.trim()) return alt.trim();

    // Check associated label (in the element's own tree, which is a shadow root inside a
    // web component)
    if (element.id) {
      const root = element.getRootNode && element.getRootNode().querySelector ? element.getRootNode() : document;
      const label = root.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label?.textContent?.trim()) {
        return label.textContent.trim();
      }
    }

    // Handle input values
    if (tagName === 'input') {
      const inputType = element.getAttribute('type') || '';
      const value = element.getAttribute('value');
      if (inputType === 'submit' && value?.trim()) {
        return value.trim();
      }
      if (element.value && element.value.length < 50 && element.value.trim()) {
        return element.value.trim();
      }
    }

    // Handle buttons, links, summaries - get direct text content
    if (['button', 'a', 'summary'].includes(tagName)) {
      let text = '';
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent;
        }
      }
      if (text.trim()) return text.trim();
    }

    // Handle headings
    if (tagName.match(/^h[1-6]$/)) {
      const text = element.textContent;
      if (text?.trim()) {
        return text.trim().substring(0, 100);
      }
    }

    // Skip images without alt
    if (tagName === 'img') return '';

    // Get direct text content for other elements
    let directText = '';
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        directText += child.textContent;
      }
    }
    if (directText?.trim() && directText.trim().length >= 3) {
      const trimmed = directText.trim();
      return trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed;
    }

    return '';
  }

  /**
   * Check if element is visible
   */
  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           element.offsetWidth > 0 &&
           element.offsetHeight > 0;
  }

  /**
   * Check if element is interactive
   */
  function isInteractive(element) {
    const tagName = element.tagName.toLowerCase();
    return ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tagName) ||
           element.getAttribute('onclick') !== null ||
           element.getAttribute('tabindex') !== null ||
           element.getAttribute('role') === 'button' ||
           element.getAttribute('role') === 'link' ||
           element.getAttribute('contenteditable') === 'true' ||
           isEditingHost(element);
  }

  /**
   * Check if element has semantic meaning
   */
  function isSemantic(element) {
    const tagName = element.tagName.toLowerCase();
    return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 
            'section', 'article', 'aside'].includes(tagName) ||
           element.getAttribute('role') !== null;
  }

  /**
   * Check if element should be included in the tree
   */
  function shouldInclude(element, options) {
    const tagName = element.tagName.toLowerCase();

    // Skip non-content elements
    if (['script', 'style', 'meta', 'link', 'title', 'noscript'].includes(tagName)) {
      return false;
    }

    // Skip aria-hidden elements (unless showing all)
    if (options.filter !== 'all' && element.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    // Skip invisible elements (unless showing all)
    if (options.filter !== 'all' && !isVisible(element)) {
      return false;
    }

    // Check viewport visibility (unless targeting specific ref)
    if (options.filter !== 'all' && !options.refId) {
      const rect = element.getBoundingClientRect();
      if (!(rect.top < window.innerHeight && rect.bottom > 0 &&
            rect.left < window.innerWidth && rect.right > 0)) {
        return false;
      }
    }

    // Interactive filter
    if (options.filter === 'interactive') {
      return isInteractive(element);
    }

    // Include interactive elements
    if (isInteractive(element)) return true;

    // Include semantic elements
    if (isSemantic(element)) return true;

    // Include elements with accessible names
    if (getAccessibleName(element).length > 0) return true;

    // Include elements with meaningful roles
    const role = getRole(element);
    return role !== null && role !== 'generic' && role !== 'image';
  }

  /**
   * Build the accessibility tree recursively
   */
  function buildTree(element, depth, options, output, maxDepth) {
    if (depth > maxDepth || !element || !element.tagName) return;
    // Foxl's own overlay (visual-indicator.js: the glow border and the "Stop Foxl" button)
    // is not part of the page. Listed, it was an unlabeled button the agent could click to
    // stop itself.
    if (element.id && element.id.startsWith('pilot-agent-')) return;

    const include = shouldInclude(element, options) || 
                   (options.refId !== null && depth === 0);

    if (include) {
      const role = getRole(element);
      const name = getAccessibleName(element);

      // Find or create ref ID
      let refId = null;
      for (const [id, ref] of Object.entries(window.__pilotElementMap)) {
        if (ref.deref() === element) {
          refId = id;
          break;
        }
      }
      if (!refId) {
        refId = 'ref_' + (++window.__pilotRefCounter);
        window.__pilotElementMap[refId] = new WeakRef(element);
      }

      // Build line
      let line = ' '.repeat(depth) + role;
      if (name) {
        const escapedName = name.replace(/\s+/g, ' ').substring(0, 100).replace(/"/g, '\\"');
        line += ` "${escapedName}"`;
      }
      line += ` [${refId}]`;

      // Add relevant attributes
      if (element.getAttribute('href')) {
        line += ` href="${element.getAttribute('href')}"`;
      }
      if (element.getAttribute('type')) {
        line += ` type="${element.getAttribute('type')}"`;
      }
      if (element.getAttribute('placeholder')) {
        line += ` placeholder="${element.getAttribute('placeholder')}"`;
      }

      output.push(line);

      // Handle select options
      if (element.tagName.toLowerCase() === 'select') {
        for (const option of element.options) {
          let optLine = ' '.repeat(depth + 1) + 'option';
          const optText = option.textContent?.trim() || '';
          if (optText) {
            const escapedText = optText.replace(/\s+/g, ' ').substring(0, 100).replace(/"/g, '\\"');
            optLine += ` "${escapedText}"`;
          }
          if (option.selected) {
            optLine += ' (selected)';
          }
          if (option.value && option.value !== optText) {
            optLine += ` value="${option.value.replace(/"/g, '\\"')}"`;
          }
          output.push(optLine);
        }
      }
    }

    // Process children - and an OPEN shadow root's, which `children` never reaches. A web
    // component's buttons and fields (a design-system <x-button>, a shadow-DOM form) were
    // invisible to the tree and so could not be clicked or typed into at all. A closed
    // shadow root stays out of reach; nothing in a page can see into one.
    if (depth < maxDepth) {
      const kids = element.shadowRoot
        ? [...element.shadowRoot.children, ...(element.children || [])]
        : (element.children || []);
      for (const child of kids) {
        buildTree(child, include ? depth + 1 : depth, options, output, maxDepth);
      }
    }
  }

  /**
   * Main function to generate accessibility tree
   * 
   * @param {string} filter - 'all', 'interactive', or 'visible' (default)
   * @param {number} depth - Maximum depth to traverse (default: 15)
   * @param {number} maxChars - Maximum output characters (optional)
   * @param {string} refId - Focus on specific element by ref ID (optional)
   * @returns {Object} { pageContent, viewport, error? }
   */
  window.__generateAccessibilityTree = function(filter, depth, maxChars, refId) {
    try {
      const output = [];
      const maxDepth = depth ?? 15;
      const options = {
        filter: filter || 'all',
        refId: refId
      };

      // If targeting specific ref
      if (refId) {
        const ref = window.__pilotElementMap[refId];
        if (!ref) {
          return {
            error: `Element with ref_id '${refId}' not found. It may have been removed from the page.`,
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight }
          };
        }
        const element = ref.deref();
        if (!element) {
          return {
            error: `Element with ref_id '${refId}' no longer exists. It may have been removed from the page.`,
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight }
          };
        }
        buildTree(element, 0, options, output, maxDepth);
      } else if (document.body) {
        buildTree(document.body, 0, options, output, maxDepth);
      }

      // Cleanup stale refs
      for (const id in window.__pilotElementMap) {
        if (!window.__pilotElementMap[id].deref()) {
          delete window.__pilotElementMap[id];
        }
      }

      const pageContent = output.join('\n');

      // Check character limit
      if (maxChars != null && pageContent.length > maxChars) {
        let errorMsg = `Output exceeds ${maxChars} character limit (${pageContent.length} characters). `;
        if (refId) {
          errorMsg += 'The specified element has too much content. Try specifying a smaller depth parameter.';
        } else if (depth !== undefined) {
          errorMsg += 'Try specifying an even smaller depth parameter or use ref_id to focus on a specific element.';
        } else {
          errorMsg += 'Try specifying a depth parameter (e.g., depth: 5) or use ref_id to focus on a specific element.';
        }
        return {
          error: errorMsg,
          pageContent: '',
          viewport: { width: window.innerWidth, height: window.innerHeight }
        };
      }

      return {
        pageContent,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      };
    } catch (err) {
      throw new Error('Error generating accessibility tree: ' + (err.message || 'Unknown error'));
    }
  };

  /**
   * Get element by ref ID
   */
  window.__pilotGetElement = function(refId) {
    const ref = window.__pilotElementMap[refId];
    return ref ? ref.deref() : null;
  };

  function notFound(refId) {
    return { success: false, error: `Element ${refId} not found. Take a new snapshot: the page may have changed since the last one.` };
  }

  /** A short, page-safe name for an element: tag plus id or first class. */
  function describe(el) {
    if (!el || !el.tagName) return 'something';
    const id = el.id ? `#${el.id}` : '';
    const cls = !id && typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  /** The deepest element at a viewport point, looking through open shadow roots. */
  function deepElementFromPoint(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  /**
   * Where a person would click this element, in viewport CSS pixels, after scrolling it
   * into view - and whether a click there would actually reach it (`hitsTarget`, with what
   * covers it otherwise). The click's pointer events carry these coordinates.
   */
  window.__pilotElementInfo = function(refId) {
    const el = window.__pilotGetElement(refId);
    if (!el) return notFound(refId);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      return { success: false, error: `Element ${refId} takes no space on the page (it is hidden). Take a new snapshot.` };
    }
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = deepElementFromPoint(x, y);
    const hitsTarget = !!hit && (composedContains(el, hit) || composedContains(hit, el));
    return { success: true, x, y, width: Math.round(r.width), height: Math.round(r.height), hitsTarget, covering: hitsTarget ? null : describe(hit) };
  };

  function textFieldValue(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
    if (el.isContentEditable) return el.innerText;
    return null;
  }

  /**
   * Focus a text field and select what is in it, so the next inserted text REPLACES it -
   * the same as clicking into a field and pressing Select All. Works for <input>, <textarea>
   * and a contenteditable editor (inside an open shadow root too).
   */
  window.__pilotFocusForTyping = function(refId) {
    const el = window.__pilotGetElement(refId);
    if (!el) return notFound(refId);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      try { el.select(); } catch { /* some input types (number, email) refuse select() */ }
    } else if (el.isContentEditable) {
      const doc = el.ownerDocument;
      const selection = (el.getRootNode().getSelection ? el.getRootNode().getSelection() : null) || doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      return { success: false, error: `Element ${refId} (${describe(el)}) is not a text field. Snapshot again and type into a textbox.` };
    }
    const active = deepActiveElement();
    if (!active || !(active === el || composedContains(el, active))) {
      return { success: false, error: `Element ${refId} would not take focus (${describe(active)} has it).` };
    }
    return { success: true, password: el instanceof HTMLInputElement && el.type === 'password' };
  };

  /** What the field holds now. A password's value is never returned, only its length. */
  window.__pilotReadValue = function(refId) {
    const el = window.__pilotGetElement(refId);
    if (!el) return notFound(refId);
    const value = textFieldValue(el);
    if (value === null) return { success: false, error: `Element ${refId} is not a text field` };
    const password = el instanceof HTMLInputElement && el.type === 'password';
    return { success: true, value: password ? null : value, length: value.length, password };
  };

  /**
   * Type: text inserted through the editing engine (`execCommand('insertText')`), which
   * produces the same `beforeinput` / `input` events a keyboard does (isTrusted), so React's
   * controlled inputs and contenteditable rich-text editors take it. Only if that leaves the
   * field without the text does it fall back to the native value setter plus an InputEvent,
   * which React's value tracker also accepts.
   *
   * The old path set `element.value` and dispatched plain `input` / `change` Events. On a
   * contenteditable that did nothing at all; on a plain input it still worked.
   */
  window.__pilotInsertTextFallback = function(refId, text) {
    const prep = window.__pilotFocusForTyping(refId);
    if (!prep.success) return prep;
    const el = window.__pilotGetElement(refId);
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }
    if (inserted && holdsText(textFieldValue(el), text)) return { success: true, method: 'editing-engine' };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    } else if (el.isContentEditable) {
      el.textContent = text;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, method: 'value-setter' };
  };

  /**
   * Does the field hold the text? Ignoring whitespace, and also on letters and digits only
   * (case-insensitive), so a field that formats as you type ("(555) 123-4567") still counts.
   * The service worker's read-back uses the same rule.
   */
  function holdsText(value, text) {
    const squash = (s) => String(s ?? '').replace(/\s+/g, '');
    if (squash(value).includes(squash(text))) return true;
    const alnum = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const want = alnum(text);
    return want.length > 0 && alnum(value).includes(want);
  }

  function mouseSequence(target, x, y) {
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
    const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerover', pointer));
    target.dispatchEvent(new MouseEvent('mouseover', base));
    target.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    target.dispatchEvent(new PointerEvent('pointerup', pointer));
    target.dispatchEvent(new MouseEvent('mouseup', base));
    // A dispatched click runs the element's activation behaviour (a checkbox toggles, a link
    // follows, a submit button submits) just as `element.click()` does, and it carries the
    // point, which a page reading `clientX` / `clientY` (a map, a canvas) needs.
    target.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
  }

  /**
   * Click: the whole pointer/mouse sequence a real click produces (many sites act on
   * pointerdown or mousedown, which `element.click()` alone never sends). Still page events,
   * so `isTrusted` stays false.
   *
   * An element with NO BOX (a `display: none` checkbox behind a styled label, which the full
   * tree lists) has no point to aim at, and the old `element.click()` still toggled it. So it
   * gets exactly that: `el.click()`, without the pointer events.
   */
  window.__pilotClickFallback = function(refId) {
    const el = window.__pilotGetElement(refId);
    if (!el) return notFound(refId);
    const info = window.__pilotElementInfo(refId);
    if (!info.success) {
      el.click();
      return { success: true, method: 'synthetic', note: `${refId} has no box on the page, so it was clicked without pointer events` };
    }
    mouseSequence(el, info.x, info.y);
    return { success: true, method: 'synthetic' };
  };

  /** Focus an element, for a key press aimed at it (focusing does not toggle or submit). */
  window.__pilotFocusElement = function(refId) {
    const el = window.__pilotGetElement(refId);
    if (!el) return notFound(refId);
    if (typeof el.focus === 'function') el.focus({ preventScroll: false });
    const active = deepActiveElement();
    if (!active || !(active === el || composedContains(el, active))) {
      return { success: false, error: `Element ${refId} (${describe(el)}) cannot take focus, so a key press would go elsewhere.` };
    }
    return { success: true };
  };

  window.__pilotClickAtFallback = function(x, y) {
    const target = deepElementFromPoint(x, y);
    if (!target) return { success: false, error: `Nothing at (${x}, ${y}) - is it inside the visible page?` };
    mouseSequence(target, x, y);
    return { success: true, method: 'synthetic', target: describe(target) };
  };

  window.__pilotHoverFallback = function(refId, x, y) {
    let target = null;
    if (refId) {
      const info = window.__pilotElementInfo(refId);
      if (!info.success) return info;
      target = window.__pilotGetElement(refId);
      x = info.x; y = info.y;
    } else {
      target = deepElementFromPoint(x, y);
    }
    if (!target) return { success: false, error: 'Nothing to hover there' };
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    target.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseover', base));
    target.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
    target.dispatchEvent(new MouseEvent('mousemove', base));
    return { success: true, method: 'synthetic', target: describe(target) };
  };

  /*
   * Named keys: `key` / `code` per the UI Events KeyboardEvent spec, with the legacy keyCode
   * a page may still read.
   */
  const NAMED_KEYS = {
    enter: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
    backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32],
    arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
    home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
  };
  const MODIFIER_FLAGS = { control: 'ctrlKey', ctrl: 'ctrlKey', shift: 'shiftKey', alt: 'altKey', meta: 'metaKey', cmd: 'metaKey', command: 'metaKey' };

  /** "Enter", "Escape", "a", "Control+a", "Shift+Tab" -> a KeyboardEvent init, or null. */
  function parseKey(spec) {
    const parts = String(spec || '').split('+').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const init = { bubbles: true, cancelable: true, composed: true };
    for (const m of parts.slice(0, -1)) {
      const flag = MODIFIER_FLAGS[m.toLowerCase()];
      if (!flag) return null;
      init[flag] = true;
    }
    const last = parts[parts.length - 1];
    const named = NAMED_KEYS[last.toLowerCase()];
    if (named) return { ...init, key: named[0], code: named[1], keyCode: named[2], which: named[2] };
    if (last.length !== 1) return null;
    const upper = last.toUpperCase();
    const code = upper >= 'A' && upper <= 'Z' ? `Key${upper}` : last >= '0' && last <= '9' ? `Digit${last}` : '';
    return { ...init, key: last, code, keyCode: upper.charCodeAt(0), which: upper.charCodeAt(0) };
  }

  /**
   * A key press on whatever has focus. Page events: `isTrusted` is false, so a key the
   * BROWSER acts on by itself (Tab moving focus, typing a character) does not happen - only
   * the page's own key handlers see it.
   *
   * Enter in a form goes through `requestSubmit()`, which runs the page's own submit handlers
   * and its validation; the old `form.submit()` skipped both (and reloaded a React form). And
   * `submitted` reports what HAPPENED: true only when a submit event was observed. A form
   * that fails validation reports `invalid`, and a page that handles Enter itself (a chat
   * composer calls preventDefault) reports `enterHandledByPage`.
   */
  window.__pilotKeyFallback = function(spec) {
    const init = parseKey(spec);
    if (!init) return { success: false, error: `Unknown key "${spec}". Use Enter, Tab, Escape, Backspace, Delete, Space, an arrow, Home, End, PageUp, PageDown or a character, optionally with Control+, Shift+, Alt+ or Meta+.` };
    const target = deepActiveElement() || document.body;
    const notCancelled = target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (init.key.length === 1 || init.key === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    const result = { success: true, method: 'synthetic', submitted: false };
    if (init.key !== 'Enter' || init.ctrlKey || init.metaKey || init.altKey) return result;
    if (!notCancelled) return { ...result, enterHandledByPage: true };
    const form = target.closest ? target.closest('form') : (target.form || null);
    if (!form) return result;
    if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
      const bad = form.querySelector(':invalid');
      return { ...result, invalid: bad ? `${describe(bad)}: ${bad.validationMessage || 'invalid'}` : 'the form is invalid' };
    }
    let sawSubmit = false;
    const seen = () => { sawSubmit = true; };
    form.addEventListener('submit', seen, { capture: true, once: true });
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
    form.removeEventListener('submit', seen, { capture: true });
    return { ...result, submitted: sawSubmit };
  };

  /** Kept for an older service worker: the improved synthetic click. */
  window.__pilotClickElement = function(refId) {
    return window.__pilotClickFallback(refId);
  };

  /** Kept for an older service worker: insert, verify, then Enter through requestSubmit. */
  window.__pilotTypeInElement = function(refId, text, submit = false) {
    const typed = window.__pilotInsertTextFallback(refId, text);
    if (!typed.success) return typed;
    const read = window.__pilotReadValue(refId);
    if (read.success && !read.password && !holdsText(read.value, text)) {
      return { success: false, error: `Typed into ${refId}, but it now holds ${JSON.stringify((read.value || '').slice(0, 200))}.` };
    }
    if (submit) window.__pilotKeyFallback('Enter');
    return { success: true, method: typed.method };
  };

  /**
   * Select option by ref ID
   */
  window.__pilotSelectOption = function(refId, value) {
    const element = window.__pilotGetElement(refId);
    if (!element || element.tagName.toLowerCase() !== 'select') {
      return { success: false, error: `Select element ${refId} not found` };
    }
    try {
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };
})();
