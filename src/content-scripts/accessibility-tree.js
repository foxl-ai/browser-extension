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
   * Get the semantic role of an element
   */
  function getRole(element) {
    const explicitRole = element.getAttribute('role');
    if (explicitRole) return explicitRole;

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

    // Check associated label
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
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
           element.getAttribute('contenteditable') === 'true';
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

    // Process children
    if (element.children && depth < maxDepth) {
      for (const child of element.children) {
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

  /**
   * Click element by ref ID
   */
  window.__pilotClickElement = function(refId) {
    const element = window.__pilotGetElement(refId);
    if (!element) {
      return { success: false, error: `Element ${refId} not found` };
    }
    try {
      element.click();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  /**
   * Type into element by ref ID
   */
  window.__pilotTypeInElement = function(refId, text, submit = false) {
    const element = window.__pilotGetElement(refId);
    if (!element) {
      return { success: false, error: `Element ${refId} not found` };
    }
    try {
      element.focus();
      element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      
      if (submit) {
        const form = element.closest('form');
        if (form) {
          form.submit();
        } else {
          element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
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
