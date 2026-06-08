/**
 * SentiScope — Popup Script
 * Handles: history rendering, tab switching, export, clear, theme toggle.
 */

'use strict';

// ─── DOM Refs ────────────────────────────────────────────────────────────────

const historyList   = document.getElementById('history-list');
const historyEmpty  = document.getElementById('history-empty');
const historyCount  = document.getElementById('history-count');
const historyToolbar = document.getElementById('history-toolbar');
const toastEl       = document.getElementById('toast');

// Tabs
const tabHistory = document.getElementById('tab-history');
const tabGuide   = document.getElementById('tab-guide');
const panelHistory = document.getElementById('panel-history');
const panelGuide   = document.getElementById('panel-guide');

// Theme
const themeIconDark  = document.getElementById('theme-icon-dark');
const themeIconLight = document.getElementById('theme-icon-light');

// ─── State ───────────────────────────────────────────────────────────────────

let currentTheme = 'dark'; // 'dark' | 'light'

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  // Load settings
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (resp?.success && resp.settings?.theme) {
      currentTheme = resp.settings.theme === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : resp.settings.theme;
    }
  } catch (_) {
    // Default to dark
  }
  applyTheme(currentTheme);

  // Load history
  await loadHistory();

  // Tab switching
  tabHistory.addEventListener('click', () => switchTab('history'));
  tabGuide.addEventListener('click',   () => switchTab('guide'));

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Export buttons
  document.getElementById('export-json').addEventListener('click', () => exportData('json'));
  document.getElementById('export-csv').addEventListener('click',  () => exportData('csv'));

  // Clear history
  document.getElementById('clear-history').addEventListener('click', clearHistory);
}

// ─── Theme ───────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);
  themeIconDark.style.display  = theme === 'dark'  ? 'block' : 'none';
  themeIconLight.style.display = theme === 'light' ? 'block' : 'none';
}

async function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(currentTheme);
  try {
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { theme: currentTheme }
    });
  } catch (_) {}
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function switchTab(which) {
  const isHistory = which === 'history';
  tabHistory.classList.toggle('tab--active', isHistory);
  tabGuide.classList.toggle('tab--active', !isHistory);
  tabHistory.setAttribute('aria-selected', isHistory ? 'true' : 'false');
  tabGuide.setAttribute('aria-selected',   isHistory ? 'false' : 'true');
  panelHistory.hidden = !isHistory;
  panelGuide.hidden   = isHistory;
}

// ─── History ─────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
    const history = resp?.history ?? [];
    renderHistory(history);
  } catch (err) {
    console.error('SentiScope: Failed to load history', err);
    renderHistory([]);
  }
}

function renderHistory(history) {
  historyCount.textContent = history.length;

  if (history.length === 0) {
    historyList.style.display = 'none';
    historyToolbar.style.display = 'none';
    historyEmpty.style.display = 'flex';
    return;
  }

  historyList.style.display = 'flex';
  historyEmpty.style.display = 'none';
  historyToolbar.style.display = 'flex';

  historyList.innerHTML = '';
  for (const entry of history) {
    historyList.appendChild(createHistoryItem(entry));
  }
}

function createHistoryItem(entry) {
  const result = entry.result ?? {};
  const sentiment = result.sentiment ?? 'neutral';
  const confidence = result.confidence ?? 0;
  const score = result.score ?? 0;
  const wordCount = result.wordCount ?? 0;
  const charCount = result.charCount ?? 0;

  const sentimentLabel = sentiment.charAt(0).toUpperCase() + sentiment.slice(1);
  const timeStr = formatTime(entry.timestamp);
  const textPreview = (entry.text || '').slice(0, 120);

  const item = document.createElement('div');
  item.className = 'history-item';
  item.setAttribute('role', 'listitem');
  item.innerHTML = `
    <div class="history-item-header">
      <span class="sentiment-dot ${sentiment}" aria-hidden="true"></span>
      <span class="history-item-sentiment ${sentiment}">${sentimentLabel}</span>
      <span class="history-item-confidence">${score >= 0 ? '+' : ''}${score.toFixed(3)}</span>
      <span class="history-item-confidence">${confidence}% confidence</span>
      <span class="history-item-time">${timeStr}</span>
    </div>
    <div class="history-item-text">${escapeHTML(textPreview)}${entry.text?.length > 120 ? '…' : ''}</div>
    <div class="history-item-meta">
      <span class="history-item-stat">${wordCount} words</span>
      <span class="history-item-stat">${charCount} chars</span>
      ${entry.pageTitle ? `<span class="history-item-stat" title="${escapeHTML(entry.url)}">${escapeHTML(entry.pageTitle.slice(0, 30))}${entry.pageTitle.length > 30 ? '…' : ''}</span>` : ''}
    </div>
  `;
  return item;
}

function formatTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

// ─── Export ──────────────────────────────────────────────────────────────────
// Blob + download happens here in the popup (has URL.createObjectURL).
// The service worker just returns the raw content string.

async function exportData(format) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'EXPORT_DATA', format });
    if (!resp?.success) {
      showToast(`❌ Export failed: ${resp?.error ?? 'Unknown error'}`);
      return;
    }

    const blob = new Blob([resp.content], { type: resp.mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = resp.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`✅ Exported as ${format.toUpperCase()}`);
  } catch (err) {
    showToast('❌ Export failed');
    console.error('SentiScope export error:', err);
  }
}

// ─── Clear ───────────────────────────────────────────────────────────────────
// Chrome extension popups block window.confirm(), so we use an inline
// confirmation UI instead.

let clearPending = false;

async function clearHistory() {
  const btn = document.getElementById('clear-history');
  if (!btn) return;

  if (!clearPending) {
    // First click: enter confirmation state
    clearPending = true;
    btn.textContent = 'Confirm?';
    btn.classList.add('btn--confirm');
    // Auto-reset after 3 s if user doesn't confirm
    setTimeout(() => {
      if (clearPending) {
        clearPending = false;
        btn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg> Clear`;
        btn.classList.remove('btn--confirm');
      }
    }, 3000);
    return;
  }

  // Second click: actually clear
  clearPending = false;
  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14H6L5 6"/>
      <path d="M10 11v6M14 11v6"/>
      <path d="M9 6V4h6v2"/>
    </svg> Clear`;
  btn.classList.remove('btn--confirm');

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    if (resp?.success) {
      renderHistory([]);
      showToast('🗑️ History cleared');
    } else {
      showToast('❌ Failed to clear history');
    }
  } catch (err) {
    showToast('❌ Failed to clear history');
  }
}

// ─── Toast ───────────────────────────────────────────────────────────────────

let toastTimeout = null;
function showToast(message, duration = 2500) {
  clearTimeout(toastTimeout);
  toastEl.textContent = message;
  toastEl.classList.add('toast--visible');
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove('toast--visible');
  }, duration);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHTML(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str ?? ''));
  return div.innerHTML;
}

// ─── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
