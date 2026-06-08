/**
 * SentiScope — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Register context menu item
 *  - Route ANALYZE_TEXT messages to the sentiment analyzer
 *  - Persist and retrieve analysis history via chrome.storage.local
 *  - Handle CSV / JSON export via chrome.downloads
 *
 * IMPORTANT: Service workers are ephemeral. No state is stored in module-level
 * variables — everything lives in chrome.storage.
 */

// Load the sentiment analyzer into the service worker global scope
importScripts('../sentiment/analyzer.js');


// ─── Context Menu Setup ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'sentiscope-analyze',
    title: '🔍 Analyze Sentiment',
    contexts: ['selection']
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'sentiscope-analyze') return;

  const selectedText = info.selectionText?.trim();
  if (!selectedText) return;

  // Tell the content script to show the overlay with the context-menu text
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_OVERLAY_FROM_CONTEXT_MENU',
      text: selectedText
    });
  } catch (err) {
    console.warn('SentiScope: Could not reach content script:', err.message);
  }
});

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // ── Sentiment Analysis ──────────────────────────────────────────────────
    case 'ANALYZE_TEXT': {
      (async () => {
        try {
          const result = analyzeSentiment(message.text);
          sendResponse({ success: true, result });
        } catch (err) {
          console.error('SentiScope analysis error:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // keep channel open for async sendResponse
    }

    // ── Save History Entry ──────────────────────────────────────────────────
    case 'SAVE_HISTORY': {
      (async () => {
        try {
          const { history = [] } = await chrome.storage.local.get('history');
          const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            text: message.text,
            url: sender.tab?.url || '',
            pageTitle: sender.tab?.title || '',
            result: message.result
          };
          // Prepend new entry, keep latest 100
          const updated = [entry, ...history].slice(0, 100);
          await chrome.storage.local.set({ history: updated });
          sendResponse({ success: true, entry });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Get History ─────────────────────────────────────────────────────────
    case 'GET_HISTORY': {
      (async () => {
        try {
          const { history = [] } = await chrome.storage.local.get('history');
          sendResponse({ success: true, history });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Clear History ───────────────────────────────────────────────────────
    case 'CLEAR_HISTORY': {
      (async () => {
        try {
          await chrome.storage.local.set({ history: [] });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Export Data ─────────────────────────────────────────────────────────
    // Returns raw data to the caller (popup) which creates the blob + download
    case 'EXPORT_DATA': {
      (async () => {
        try {
          const { history = [] } = await chrome.storage.local.get('history');
          let content, filename, mimeType;

          if (message.format === 'json') {
            content = JSON.stringify(history, null, 2);
            filename = `sentiscope-history-${Date.now()}.json`;
            mimeType = 'application/json';
          } else {
            // CSV
            const headers = ['Timestamp', 'Sentiment', 'Score', 'Confidence', 'Word Count', 'URL', 'Text'];
            const rows = history.map(e => [
              e.timestamp,
              e.result?.sentiment ?? '',
              e.result?.score ?? '',
              e.result?.confidence ?? '',
              e.result?.wordCount ?? '',
              e.url,
              `"${(e.text || '').replace(/"/g, '""')}"`
            ]);
            content = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
            filename = `sentiscope-history-${Date.now()}.csv`;
            mimeType = 'text/csv';
          }

          // Return raw content — popup handles the download
          sendResponse({ success: true, content, filename, mimeType });
        } catch (err) {
          console.error('SentiScope export error:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Get/Set Settings ────────────────────────────────────────────────────
    case 'GET_SETTINGS': {
      (async () => {
        try {
          const { settings = { theme: 'auto' } } = await chrome.storage.sync.get('settings');
          sendResponse({ success: true, settings });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'SAVE_SETTINGS': {
      (async () => {
        try {
          await chrome.storage.sync.set({ settings: message.settings });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
  }
});
