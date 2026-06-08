/**
 * SentiScope — Content Script
 *
 * Responsibilities:
 *  - Detect text selections on any webpage
 *  - Show a floating action button (FAB) near the selection
 *  - On FAB click: apply blur overlay to non-selected page content
 *  - Inject an in-page overlay panel (via Shadow DOM) showing results
 *  - Allow start/end range adjustment and re-analysis
 *  - Handle context-menu triggered analysis
 *  - Highlight analyzed text on the page
 */

(function () {
  'use strict';

  // ─── Guard: don't inject twice ──────────────────────────────────────────────
  if (window.__sentiscopeInjected) return;
  window.__sentiscopeInjected = true;

  // ─── Extension Context Guard ─────────────────────────────────────────────────
  // When the extension is reloaded while the page is open, the content script's
  // connection to the runtime is severed. This guard prevents the cryptic
  // "Extension context invalidated" error from surfacing to the user.

  function isExtensionContextValid() {
    try {
      // chrome.runtime.id is undefined when the context is invalidated
      return !!(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  /**
   * Safe wrapper around chrome.runtime.sendMessage.
   * Returns null (instead of throwing) when the context is invalidated.
   */
  async function safeSendMessage(msg) {
    if (!isExtensionContextValid()) return null;
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (err.message?.includes('Extension context invalidated') ||
          err.message?.includes('message channel closed')) {
        return null; // treat as invalidated
      }
      throw err; // re-throw unexpected errors
    }
  }

  // ─── State ──────────────────────────────────────────────────────────────────
  let fabEl = null;
  let overlayRoot = null;
  let shadowRoot = null;
  let currentSelection = null; // { text, fullText, startOffset, endOffset, range }
  let currentResult = null;
  let highlightElements = [];
  let isDark = false;

  // Detect dark mode preference
  function detectDarkMode() {
    isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    // Check page background luminance as a secondary signal
    const bg = getComputedStyle(document.body).backgroundColor;
    const rgb = bg.match(/\d+/g);
    if (rgb) {
      const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      if (lum < 100) isDark = true;
    }
  }
  detectDarkMode();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', e => {
    isDark = e.matches;
    if (shadowRoot) {
      shadowRoot.host.dataset.theme = isDark ? 'dark' : 'light';
    }
  });

  // ─── Block Context Helper ─────────────────────────────────────────────────────
  // Extracts the full text of the nearest block-level ancestor so sliders
  // can span beyond the originally selected range.

  /**
   * Block-level tag names — used to find the "paragraph boundary"
   * around a DOM selection.
   */
  const BLOCK_TAGS = new Set([
    'P','DIV','SECTION','ARTICLE','BLOCKQUOTE','LI','TD','TH',
    'H1','H2','H3','H4','H5','H6','PRE','FIGURE','HEADER','FOOTER',
    'MAIN','ASIDE','NAV','CAPTION','DETAILS','SUMMARY'
  ]);

  /**
   * Given a DOM Range and the selected text string, return:
   *   contextText  – full text of the nearest block ancestor (max 2000 chars)
   *   selStart     – char offset of selection start within contextText
   *   selEnd       – char offset of selection end within contextText
   */
  function getBlockContext(range, selectedText) {
    // Walk up to the nearest block ancestor
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    let blockEl = node;
    while (blockEl && blockEl !== document.body) {
      if (BLOCK_TAGS.has(blockEl.tagName)) break;
      blockEl = blockEl.parentElement;
    }
    if (!blockEl || blockEl === document.body) blockEl = node;

    // Get block text (cap at 2000 chars to keep sliders manageable)
    const rawContext = blockEl.textContent || '';
    const contextText = rawContext.length > 2000
      ? rawContext.slice(0, 2000)
      : rawContext;

    // Locate selection start within contextText using a pre-range
    let selStart = 0;
    try {
      const preRange = document.createRange();
      preRange.setStart(blockEl, 0);
      preRange.setEnd(range.startContainer, range.startOffset);
      selStart = preRange.toString().length;
    } catch (_) {
      // Fallback: search for the selected text in the block
      const idx = contextText.indexOf(selectedText.slice(0, 30));
      selStart = idx >= 0 ? idx : 0;
    }

    const selEnd = Math.min(contextText.length, selStart + selectedText.length);

    return { contextText, selStart, selEnd };
  }

  // ─── FAB ────────────────────────────────────────────────────────────────────


  function createFAB() {
    if (fabEl) return;
    fabEl = document.createElement('div');
    fabEl.className = 'sentiscope-fab';
    fabEl.id = 'sentiscope-fab';
    fabEl.setAttribute('role', 'button');
    fabEl.setAttribute('aria-label', 'Analyze sentiment of selected text');
    fabEl.setAttribute('tabindex', '0');
    fabEl.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.35-4.35"/>
        <path d="M8 11h6M11 8v6" stroke-width="2"/>
      </svg>
      <span>Analyze</span>
    `;
    document.body.appendChild(fabEl);

    fabEl.addEventListener('click', handleFABClick);
    fabEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleFABClick();
      }
    });
  }

  function showFAB(x, y) {
    createFAB();
    // Position near selection end, avoid viewport overflow
    const margin = 12;
    const fabWidth = 120;
    const fabHeight = 40;
    let left = Math.min(x + margin, window.innerWidth - fabWidth - margin);
    let top = Math.max(y + margin, margin);
    if (top + fabHeight > window.innerHeight - margin) {
      top = y - fabHeight - margin;
    }

    fabEl.style.left = `${left + window.scrollX}px`;
    fabEl.style.top = `${top + window.scrollY}px`;
    fabEl.classList.add('sentiscope-fab--visible');
  }

  function hideFAB() {
    fabEl?.classList.remove('sentiscope-fab--visible');
  }

  // ─── Selection Detection ─────────────────────────────────────────────────────

  let fabHideTimeout = null;

  document.addEventListener('mouseup', (e) => {
    // Ignore clicks inside our own overlay
    if (e.target.closest?.('#sentiscope-overlay-host, .sentiscope-fab')) return;

    // If the extension was reloaded, hide the FAB and stop
    if (!isExtensionContextValid()) {
      hideFAB();
      return;
    }

    clearTimeout(fabHideTimeout);

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      fabHideTimeout = setTimeout(hideFAB, 200);
      return;
    }

    const selectedText = selection.toString().trim();
    if (selectedText.length < 3) {
      fabHideTimeout = setTimeout(hideFAB, 200);
      return;
    }

    // Save selection state before it's lost
    const range = selection.getRangeAt(0);

    // Capture the surrounding block paragraph text so sliders can range
    // beyond the selection boundaries
    const { contextText, selStart, selEnd } = getBlockContext(range, selectedText);

    currentSelection = {
      text: selectedText,            // initial analyze text = what user highlighted
      contextText,                   // full block around the selection
      startOffset: selStart,         // selection start inside contextText
      endOffset: selEnd,             // selection end inside contextText
      range: range.cloneRange()
    };

    // Show FAB at cursor position
    showFAB(e.clientX, e.clientY);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeOverlay();
      hideFAB();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (e.target.closest?.('#sentiscope-overlay-host, .sentiscope-fab')) return;
    if (overlayRoot) return; // Don't hide if overlay is open
    clearTimeout(fabHideTimeout);
    fabHideTimeout = setTimeout(hideFAB, 300);
  });

  // ─── FAB Click Handler ───────────────────────────────────────────────────────

  async function handleFABClick() {
    if (!currentSelection) return;

    // Guard: if extension was reloaded, show a friendly notice
    if (!isExtensionContextValid()) {
      hideFAB();
      showContextInvalidatedBanner();
      return;
    }

    hideFAB();
    showOverlay(
      currentSelection.text,
      currentSelection.contextText,
      currentSelection.startOffset,
      currentSelection.endOffset
    );
  }

  // ─── Context Menu Handler ─────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SHOW_OVERLAY_FROM_CONTEXT_MENU') {
      const text = message.text;
      currentSelection = {
        text,
        contextText: text,
        startOffset: 0,
        endOffset: text.length
      };
      showOverlay(text, text, 0, text.length);
      sendResponse({ success: true });
    }
    return true;
  });

  // ─── Overlay ─────────────────────────────────────────────────────────────────

  function showOverlay(analyzeText, contextText, selStart, selEnd) {
    closeOverlay(); // close any existing one

    // Ensure we have valid context bounds
    const safeContext = contextText || analyzeText;
    const safeStart   = selStart ?? 0;
    const safeEnd     = selEnd   ?? safeContext.length;

    // Create shadow host
    const host = document.createElement('div');
    host.id = 'sentiscope-overlay-host';
    host.dataset.theme = isDark ? 'dark' : 'light';
    document.body.appendChild(host);
    overlayRoot = host;

    // Create shadow root to isolate styles
    shadowRoot = host.attachShadow({ mode: 'open' });

    // Inject styles into shadow DOM
    const styleEl = document.createElement('style');
    styleEl.textContent = getOverlayStyles();
    shadowRoot.appendChild(styleEl);

    // Build overlay HTML
    const overlay = document.createElement('div');
    overlay.className = 'ss-backdrop';
    overlay.innerHTML = buildOverlayHTML(safeContext, analyzeText, safeStart, safeEnd);
    shadowRoot.appendChild(overlay);

    // Apply page blur
    applyPageBlur(host);

    // Wire up controls — pass context + initial selection bounds
    wireOverlayControls(overlay, safeContext, safeStart, safeEnd);

    // Auto-analyze the originally selected text
    runAnalysis(analyzeText, overlay);

    // Entrance animation
    requestAnimationFrame(() => overlay.classList.add('ss-backdrop--visible'));
  }

  function closeOverlay() {
    clearHighlights();
    if (overlayRoot) {
      overlayRoot.remove();
      overlayRoot = null;
      shadowRoot = null;
    }
    removePageBlur();
  }

  // ─── Page Blur ───────────────────────────────────────────────────────────────

  function applyPageBlur(excludeEl) {
    document.documentElement.classList.add('sentiscope-blur-active');
  }

  function removePageBlur() {
    document.documentElement.classList.remove('sentiscope-blur-active');
  }

  // ─── Analysis ────────────────────────────────────────────────────────────────

  // analyzeSentiment is loaded as a content script (sentiment/analyzer.js)
  // so it runs synchronously right here in the page context — no SW round-trip.

  async function runAnalysis(text, overlay) {
    const resultsEl = overlay.querySelector('.ss-results');
    const loadingEl = overlay.querySelector('.ss-loading');

    if (loadingEl) loadingEl.style.display = 'flex';
    if (resultsEl) resultsEl.style.display = 'none';

    try {
      // Run analysis synchronously in the content script (no message passing)
      const result = analyzeSentiment(text);

      // Short RAF pause so the spinner is visible (UX feedback)
      await new Promise(resolve => requestAnimationFrame(resolve));

      currentResult = result;
      renderResults(result, overlay);

      // Persist to history via service worker — fire-and-forget, non-blocking
      safeSendMessage({ type: 'SAVE_HISTORY', text, result });

    } catch (err) {
      console.error('SentiScope analysis error:', err);
      renderError(err.message, overlay);
    } finally {
      if (loadingEl) loadingEl.style.display = 'none';
    }
  }

  /** Shown inside the overlay when the extension context has been invalidated. */
  function renderContextInvalidatedError(overlay) {
    const resultsEl = overlay.querySelector('.ss-results');
    if (resultsEl) {
      resultsEl.innerHTML = `
        <div class="ss-error" style="flex-direction:column; gap:12px; align-items:flex-start">
          <div style="display:flex; gap:10px; align-items:center">
            <span style="font-size:20px">🔄</span>
            <div>
              <div style="font-weight:700; color:rgba(255,255,255,0.85); margin-bottom:4px">Extension was updated</div>
              <div style="color:rgba(255,255,255,0.5); font-size:12px; line-height:1.5">The SentiScope extension was reloaded while this page was open. Please refresh the page to reconnect.</div>
            </div>
          </div>
          <button onclick="location.reload()" style="
            background: linear-gradient(135deg, #a855f7, #6366f1);
            color: white; border: none; border-radius: 8px;
            padding: 8px 16px; font-size: 12px; font-weight: 600;
            cursor: pointer; font-family: inherit; width: 100%;
          ">↻ Refresh Page</button>
        </div>
      `;
      resultsEl.style.display = 'block';
    }
  }

  /** Shown as a small banner when FAB is clicked with invalidated context. */
  function showContextInvalidatedBanner() {
    // Create a tiny toast directly on the page
    const banner = document.createElement('div');
    banner.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #1a1530; color: white; font-family: sans-serif;
      font-size: 13px; padding: 10px 18px; border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4); z-index: 2147483647;
      border: 1px solid rgba(168,85,247,0.3); white-space: nowrap;
      display: flex; align-items: center; gap: 10px;
    `;
    banner.innerHTML = `🔄 Extension updated — <a href="" onclick="location.reload();return false;" style="color:#a855f7;text-decoration:none;font-weight:600;">Refresh page</a> to continue`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 6000);
  }

  function renderResults(result, overlay) {
    const resultsEl = overlay.querySelector('.ss-results');
    if (!resultsEl) return;

    const sentimentConfig = {
      positive: { icon: '😊', label: 'Positive', color: '#22c55e', bgColor: 'rgba(34,197,94,0.15)', emoji: '🟢' },
      negative: { icon: '😟', label: 'Negative', color: '#ef4444', bgColor: 'rgba(239,68,68,0.15)', emoji: '🔴' },
      neutral:  { icon: '😐', label: 'Neutral',  color: '#6b93d6', bgColor: 'rgba(107,147,214,0.15)', emoji: '🔵' }
    };
    const cfg = sentimentConfig[result.sentiment] || sentimentConfig.neutral;

    const posW = Math.round(result.positive * 100);
    const negW = Math.round(result.negative * 100);
    const neuW = Math.max(0, 100 - posW - negW);

    // Breakdown items (top 5 most impactful words)
    const topWords = [...result.breakdown]
      .sort((a, b) => Math.abs(b.adjustedScore) - Math.abs(a.adjustedScore))
      .slice(0, 5);

    const breakdownHTML = topWords.length > 0 ? `
      <div class="ss-breakdown">
        <div class="ss-breakdown-title">Key Sentiment Words</div>
        <div class="ss-breakdown-list">
          ${topWords.map(w => `
            <div class="ss-breakdown-item ${parseFloat(w.adjustedScore) >= 0 ? 'positive' : 'negative'}">
              <span class="ss-breakdown-word">${escapeHTML(w.word)}</span>
              <span class="ss-breakdown-score">${parseFloat(w.adjustedScore) >= 0 ? '+' : ''}${w.adjustedScore}</span>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    resultsEl.innerHTML = `
      <div class="ss-sentiment-badge" style="background:${cfg.bgColor}; border-color:${cfg.color}40">
        <span class="ss-sentiment-icon">${cfg.icon}</span>
        <div class="ss-sentiment-info">
          <span class="ss-sentiment-label" style="color:${cfg.color}">${cfg.label}</span>
          <span class="ss-sentiment-score">Score: ${result.score > 0 ? '+' : ''}${result.score.toFixed(3)}</span>
        </div>
        <div class="ss-confidence">
          <div class="ss-confidence-ring" style="--confidence:${result.confidence}; --color:${cfg.color}">
            <span>${result.confidence}%</span>
          </div>
          <div class="ss-confidence-label">Confidence</div>
        </div>
      </div>

      <div class="ss-bars">
        <div class="ss-bar-row">
          <span class="ss-bar-label positive">Positive</span>
          <div class="ss-bar-track">
            <div class="ss-bar-fill positive" style="width:${posW}%"></div>
          </div>
          <span class="ss-bar-pct">${posW}%</span>
        </div>
        <div class="ss-bar-row">
          <span class="ss-bar-label negative">Negative</span>
          <div class="ss-bar-track">
            <div class="ss-bar-fill negative" style="width:${negW}%"></div>
          </div>
          <span class="ss-bar-pct">${negW}%</span>
        </div>
        <div class="ss-bar-row">
          <span class="ss-bar-label neutral">Neutral</span>
          <div class="ss-bar-track">
            <div class="ss-bar-fill neutral" style="width:${neuW}%"></div>
          </div>
          <span class="ss-bar-pct">${neuW}%</span>
        </div>
      </div>

      <div class="ss-stats">
        <div class="ss-stat"><span class="ss-stat-val">${result.wordCount}</span><span class="ss-stat-lbl">Words</span></div>
        <div class="ss-stat"><span class="ss-stat-val">${result.charCount}</span><span class="ss-stat-lbl">Characters</span></div>
        <div class="ss-stat"><span class="ss-stat-val">${result.sentimentWordCount}</span><span class="ss-stat-lbl">Sentiment Words</span></div>
      </div>

      ${breakdownHTML}
    `;

    resultsEl.style.display = 'block';
  }

  function renderError(msg, overlay) {
    const resultsEl = overlay.querySelector('.ss-results');
    if (resultsEl) {
      resultsEl.innerHTML = `
        <div class="ss-error">
          <span>⚠️</span>
          <p>Analysis failed: ${escapeHTML(msg)}</p>
        </div>
      `;
      resultsEl.style.display = 'block';
    }
  }

  // ─── Controls Wiring ─────────────────────────────────────────────────────────

  /**
   * @param {Element} overlay  - the shadow DOM backdrop element
   * @param {string}  contextText - full block text (may be wider than selection)
   * @param {number}  selStart - initial slider start position within contextText
   * @param {number}  selEnd   - initial slider end position within contextText
   */
  function wireOverlayControls(overlay, contextText, selStart, selEnd) {
    // Close button
    overlay.querySelector('.ss-close-btn')?.addEventListener('click', closeOverlay);

    // Range sliders
    const startSlider = overlay.querySelector('#ss-start-slider');
    const endSlider   = overlay.querySelector('#ss-end-slider');
    const startVal    = overlay.querySelector('#ss-start-val');
    const endVal      = overlay.querySelector('#ss-end-val');
    const previewEl   = overlay.querySelector('.ss-text-preview');
    const reanalyzeBtn = overlay.querySelector('.ss-reanalyze-btn');

    const maxLen = contextText.length;

    // Pre-position sliders at the original selection bounds
    if (startSlider) {
      startSlider.max   = maxLen;
      startSlider.value = selStart ?? 0;
    }
    if (endSlider) {
      endSlider.max   = maxLen;
      endSlider.value = selEnd ?? maxLen;
    }
    if (startVal) startVal.textContent = selStart ?? 0;
    if (endVal)   endVal.textContent   = selEnd   ?? maxLen;

    function updatePreview() {
      let start = parseInt(startSlider?.value ?? 0);
      let end   = parseInt(endSlider?.value   ?? maxLen);

      // Enforce start < end with a minimum 1-char gap
      if (start >= end) {
        start = Math.max(0, end - 1);
        if (startSlider) startSlider.value = start;
      }
      if (startVal) startVal.textContent = start;
      if (endVal)   endVal.textContent   = end;

      const sliced = contextText.slice(start, end);
      if (previewEl) {
        previewEl.textContent = sliced || '(empty)';
      }

      // Update active selection state so Re-Analyze uses the trimmed text
      currentSelection = {
        ...currentSelection,
        text:        sliced,
        startOffset: start,
        endOffset:   end
      };
    }

    startSlider?.addEventListener('input', updatePreview);
    endSlider?.addEventListener('input',   updatePreview);

    reanalyzeBtn?.addEventListener('click', () => {
      if (currentSelection?.text?.trim()) {
        runAnalysis(currentSelection.text, overlay);
        highlightTextOnPage(currentSelection.text);
      }
    });

    // Footer close button
    overlay.querySelector('#ss-footer-close')?.addEventListener('click', closeOverlay);

    // Highlight button
    overlay.querySelector('.ss-highlight-btn')?.addEventListener('click', () => {
      highlightTextOnPage(currentSelection?.text || contextText);
    });
  }

  // ─── Text Highlighting ───────────────────────────────────────────────────────

  function highlightTextOnPage(searchText) {
    clearHighlights();
    if (!searchText?.trim() || !currentResult) return;

    const color = currentResult.sentiment === 'positive' ? '#22c55e44'
      : currentResult.sentiment === 'negative' ? '#ef444444'
      : '#6b93d644';

    // Use TreeWalker to find text nodes
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest('#sentiscope-overlay-host, .sentiscope-fab, script, style')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.textContent.includes(searchText.slice(0, 20))) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    // Process in batches to avoid blocking
    const BATCH = 10;
    let i = 0;

    function processBatch() {
      const batchEnd = Math.min(i + BATCH, textNodes.length);
      for (; i < batchEnd; i++) {
        const tn = textNodes[i];
        const idx = tn.textContent.indexOf(searchText.slice(0, 20));
        if (idx === -1) continue;

        try {
          const range = document.createRange();
          range.setStart(tn, idx);
          range.setEnd(tn, Math.min(tn.textContent.length, idx + searchText.length));

          const mark = document.createElement('mark');
          mark.className = 'sentiscope-highlight';
          mark.style.cssText = `background:${color} !important; border-radius:3px; padding:0 1px;`;
          range.surroundContents(mark);
          highlightElements.push(mark);
        } catch (_) {
          // Range may span multiple nodes — skip gracefully
        }
      }
      if (i < textNodes.length) {
        requestAnimationFrame(processBatch);
      }
    }

    requestAnimationFrame(processBatch);
  }

  function clearHighlights() {
    for (const el of highlightElements) {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      }
    }
    highlightElements = [];
  }

  // ─── HTML Builder ─────────────────────────────────────────────────────────────

  function buildOverlayHTML(contextText, analyzeText, selStart, selEnd) {
    const preview = analyzeText.length > 300
      ? analyzeText.slice(0, 300) + '…'
      : analyzeText;

    const wordCount = analyzeText.trim().split(/\s+/).filter(Boolean).length;
    const ctxLen    = contextText.length;
    const initStart = selStart ?? 0;
    const initEnd   = selEnd   ?? ctxLen;

    return `
      <div class="ss-panel" role="dialog" aria-label="Sentiment Analysis Results" aria-modal="true">
        <!-- Header -->
        <div class="ss-header">
          <div class="ss-header-left">
            <div class="ss-logo">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <defs>
                  <linearGradient id="sg" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#a855f7"/>
                    <stop offset="100%" stop-color="#6366f1"/>
                  </linearGradient>
                </defs>
                <circle cx="12" cy="12" r="10" fill="url(#sg)"/>
                <path d="M8 12h2.5M13.5 12H16M10.5 9l1.5 3-1.5 3M13.5 9l-1.5 3 1.5 3" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="ss-title-group">
              <h2 class="ss-title">SentiScope</h2>
              <span class="ss-subtitle">Sentiment Analysis</span>
            </div>
          </div>
          <button class="ss-close-btn" aria-label="Close panel" title="Close (Esc)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Scrollable body -->
        <div class="ss-body">

          <!-- Selected Text Preview -->
          <div class="ss-section">
            <div class="ss-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              Selected Text
              <span class="ss-word-count">${wordCount} words · ${analyzeText.length} chars</span>
            </div>
            <div class="ss-text-preview" aria-label="Selected text for analysis">${escapeHTML(preview)}</div>
          </div>

          <!-- Range Controls -->
          <div class="ss-section">
            <div class="ss-section-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h16M4 16h16"/></svg>
              Adjust Range
              <span class="ss-tooltip" title="Sliders span the full surrounding paragraph — drag beyond your original selection to include more context, then Re-Analyze">ⓘ</span>
            </div>
            <div class="ss-sliders">
              <div class="ss-slider-row">
                <label class="ss-slider-label" for="ss-start-slider">Start</label>
                 <input type="range" id="ss-start-slider" class="ss-slider" min="0" max="${ctxLen}" value="${initStart}" aria-label="Start position"/>
                 <span class="ss-slider-val" id="ss-start-val">${initStart}</span>
              </div>
              <div class="ss-slider-row">
                <label class="ss-slider-label" for="ss-end-slider">End</label>
                 <input type="range" id="ss-end-slider" class="ss-slider" min="0" max="${ctxLen}" value="${initEnd}" aria-label="End position"/>
                 <span class="ss-slider-val" id="ss-end-val">${initEnd}</span>
              </div>
            </div>
            <div class="ss-range-actions">
              <button class="ss-reanalyze-btn" id="ss-reanalyze">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                Re-Analyze
              </button>
              <button class="ss-highlight-btn" id="ss-highlight">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                Highlight on Page
              </button>
            </div>
          </div>

          <!-- Loading -->
          <div class="ss-loading" style="display:flex">
            <div class="ss-spinner"></div>
            <span>Analyzing sentiment…</span>
          </div>

          <!-- Results -->
          <div class="ss-results" style="display:none"></div>

        </div>

        <!-- Footer -->
        <div class="ss-footer">
          <span class="ss-footer-note">Local analysis · No data sent · 100% private</span>
          <button class="ss-close-btn-text" id="ss-footer-close">Close</button>
        </div>
      </div>
    `;
  }

  // ─── Styles ───────────────────────────────────────────────────────────────────

  function getOverlayStyles() {
    return `
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
        pointer-events: none;
      }

      /* ── Backdrop ── */
      .ss-backdrop {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        pointer-events: all;
        opacity: 0;
        transform: scale(0.96);
        transition: opacity 0.25s ease, transform 0.25s ease;
        z-index: 2147483647;
      }
      .ss-backdrop--visible {
        opacity: 1;
        transform: scale(1);
      }

      /* ── Panel ── */
      .ss-panel {
        background: var(--ss-panel-bg, rgba(15, 12, 30, 0.95));
        border: 1px solid rgba(168, 85, 247, 0.3);
        border-radius: 20px;
        width: 100%;
        max-width: 520px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 25px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05), inset 0 1px 0 rgba(255,255,255,0.1);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        overflow: hidden;
      }

      /* ── Header ── */
      .ss-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 18px 20px 14px;
        border-bottom: 1px solid rgba(168,85,247,0.15);
        background: linear-gradient(135deg, rgba(168,85,247,0.1) 0%, rgba(99,102,241,0.05) 100%);
        flex-shrink: 0;
      }
      .ss-header-left {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .ss-logo {
        width: 38px;
        height: 38px;
        border-radius: 10px;
        background: linear-gradient(135deg, rgba(168,85,247,0.2), rgba(99,102,241,0.15));
        border: 1px solid rgba(168,85,247,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .ss-title-group { display: flex; flex-direction: column; gap: 1px; }
      .ss-title {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
        background: linear-gradient(135deg, #a855f7, #6366f1);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        line-height: 1.2;
      }
      .ss-subtitle {
        font-size: 11px;
        color: rgba(255,255,255,0.45);
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .ss-close-btn {
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 8px;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: rgba(255,255,255,0.6);
        transition: all 0.15s ease;
        flex-shrink: 0;
      }
      .ss-close-btn:hover {
        background: rgba(239,68,68,0.2);
        border-color: rgba(239,68,68,0.4);
        color: #ef4444;
      }

      /* ── Body ── */
      .ss-body {
        overflow-y: auto;
        padding: 16px 20px;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 16px;
        scrollbar-width: thin;
        scrollbar-color: rgba(168,85,247,0.3) transparent;
      }

      /* ── Section ── */
      .ss-section { display: flex; flex-direction: column; gap: 8px; }
      .ss-section-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: rgba(168,85,247,0.9);
      }
      .ss-section-label svg { opacity: 0.8; }
      .ss-word-count {
        margin-left: auto;
        font-size: 10px;
        color: rgba(255,255,255,0.4);
        font-weight: 400;
        text-transform: none;
        letter-spacing: 0;
      }

      /* ── Text Preview ── */
      .ss-text-preview {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        padding: 12px 14px;
        font-size: 13px;
        line-height: 1.6;
        color: rgba(255,255,255,0.75);
        max-height: 120px;
        overflow-y: auto;
        word-break: break-word;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.15) transparent;
      }

      /* ── Sliders ── */
      .ss-sliders { display: flex; flex-direction: column; gap: 10px; }
      .ss-slider-row {
        display: grid;
        grid-template-columns: 40px 1fr 40px;
        align-items: center;
        gap: 10px;
      }
      .ss-slider-label {
        font-size: 11px;
        color: rgba(255,255,255,0.5);
        font-weight: 500;
      }
      .ss-slider {
        -webkit-appearance: none;
        appearance: none;
        height: 4px;
        background: rgba(168,85,247,0.2);
        border-radius: 99px;
        outline: none;
        cursor: pointer;
        border: none;
        width: 100%;
      }
      .ss-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: linear-gradient(135deg, #a855f7, #6366f1);
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(168,85,247,0.5);
        transition: transform 0.15s;
      }
      .ss-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
      .ss-slider-val {
        font-size: 11px;
        color: rgba(255,255,255,0.5);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .ss-range-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      /* ── Buttons ── */
      .ss-reanalyze-btn, .ss-highlight-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px 14px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: all 0.2s ease;
        font-family: inherit;
      }
      .ss-reanalyze-btn {
        background: linear-gradient(135deg, #a855f7, #6366f1);
        color: white;
        box-shadow: 0 4px 15px rgba(168,85,247,0.3);
      }
      .ss-reanalyze-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(168,85,247,0.4);
      }
      .ss-highlight-btn {
        background: rgba(255,255,255,0.07);
        color: rgba(255,255,255,0.7);
        border: 1px solid rgba(255,255,255,0.12);
      }
      .ss-highlight-btn:hover {
        background: rgba(255,255,255,0.12);
        color: white;
        transform: translateY(-1px);
      }

      /* ── Loading ── */
      .ss-loading {
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 24px;
        color: rgba(255,255,255,0.5);
        font-size: 14px;
      }
      .ss-spinner {
        width: 24px;
        height: 24px;
        border: 2.5px solid rgba(168,85,247,0.2);
        border-top-color: #a855f7;
        border-radius: 50%;
        animation: ss-spin 0.7s linear infinite;
        flex-shrink: 0;
      }
      @keyframes ss-spin { to { transform: rotate(360deg); } }

      /* ── Results ── */
      .ss-results { display: flex; flex-direction: column; gap: 14px; }

      /* Sentiment Badge */
      .ss-sentiment-badge {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 16px;
        border-radius: 14px;
        border: 1px solid;
      }
      .ss-sentiment-icon { font-size: 36px; line-height: 1; }
      .ss-sentiment-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .ss-sentiment-label {
        font-size: 22px;
        font-weight: 800;
        line-height: 1;
      }
      .ss-sentiment-score {
        font-size: 12px;
        color: rgba(255,255,255,0.5);
        font-variant-numeric: tabular-nums;
      }
      .ss-confidence {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }
      .ss-confidence-ring {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: conic-gradient(var(--color) calc(var(--confidence) * 1%), rgba(255,255,255,0.08) 0%);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 700;
        color: var(--color);
        position: relative;
      }
      .ss-confidence-ring::before {
        content: '';
        position: absolute;
        inset: 6px;
        border-radius: 50%;
        background: rgba(15, 12, 30, 0.95);
      }
      .ss-confidence-ring span { position: relative; z-index: 1; }
      .ss-confidence-label {
        font-size: 10px;
        color: rgba(255,255,255,0.4);
        text-align: center;
      }

      /* Sentiment Bars */
      .ss-bars {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 12px;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .ss-bar-row {
        display: grid;
        grid-template-columns: 60px 1fr 38px;
        align-items: center;
        gap: 10px;
      }
      .ss-bar-label {
        font-size: 11px;
        font-weight: 600;
        text-align: right;
      }
      .ss-bar-label.positive { color: #22c55e; }
      .ss-bar-label.negative { color: #ef4444; }
      .ss-bar-label.neutral  { color: #6b93d6; }
      .ss-bar-track {
        height: 8px;
        background: rgba(255,255,255,0.07);
        border-radius: 99px;
        overflow: hidden;
      }
      .ss-bar-fill {
        height: 100%;
        border-radius: 99px;
        transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .ss-bar-fill.positive { background: linear-gradient(90deg, #16a34a, #22c55e); }
      .ss-bar-fill.negative { background: linear-gradient(90deg, #b91c1c, #ef4444); }
      .ss-bar-fill.neutral  { background: linear-gradient(90deg, #3b5fa0, #6b93d6); }
      .ss-bar-pct {
        font-size: 11px;
        color: rgba(255,255,255,0.5);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      /* Stats row */
      .ss-stats {
        display: flex;
        gap: 8px;
      }
      .ss-stat {
        flex: 1;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 10px;
        padding: 10px 8px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
      }
      .ss-stat-val {
        font-size: 18px;
        font-weight: 700;
        color: rgba(255,255,255,0.9);
        font-variant-numeric: tabular-nums;
      }
      .ss-stat-lbl {
        font-size: 10px;
        color: rgba(255,255,255,0.4);
        text-align: center;
        line-height: 1.3;
      }

      /* Breakdown */
      .ss-breakdown {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 12px;
        padding: 14px;
      }
      .ss-breakdown-title {
        font-size: 11px;
        font-weight: 600;
        color: rgba(255,255,255,0.5);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 10px;
      }
      .ss-breakdown-list { display: flex; flex-direction: column; gap: 6px; }
      .ss-breakdown-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 12px;
      }
      .ss-breakdown-item.positive { background: rgba(34,197,94,0.1); }
      .ss-breakdown-item.negative { background: rgba(239,68,68,0.1); }
      .ss-breakdown-word { color: rgba(255,255,255,0.8); font-weight: 500; }
      .ss-breakdown-score {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        font-size: 11px;
      }
      .ss-breakdown-item.positive .ss-breakdown-score { color: #22c55e; }
      .ss-breakdown-item.negative .ss-breakdown-score { color: #ef4444; }

      /* Error */
      .ss-error {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px;
        background: rgba(239,68,68,0.1);
        border: 1px solid rgba(239,68,68,0.2);
        border-radius: 10px;
        color: #fca5a5;
        font-size: 13px;
      }

      /* Tooltip */
      .ss-tooltip {
        cursor: help;
        color: rgba(255,255,255,0.35);
        font-size: 12px;
      }

      /* Footer */
      .ss-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 20px;
        border-top: 1px solid rgba(255,255,255,0.06);
        flex-shrink: 0;
      }
      .ss-footer-note {
        font-size: 10px;
        color: rgba(255,255,255,0.25);
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .ss-footer-note::before {
        content: '🔒';
        font-size: 10px;
      }
      .ss-close-btn-text {
        font-size: 11px;
        color: rgba(255,255,255,0.35);
        background: none;
        border: none;
        cursor: pointer;
        font-family: inherit;
        padding: 4px 8px;
        border-radius: 6px;
        transition: color 0.15s;
      }
      .ss-close-btn-text:hover { color: rgba(255,255,255,0.7); }
    `;
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

})();
