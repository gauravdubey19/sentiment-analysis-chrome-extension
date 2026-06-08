# SentiScope — Sentiment Analyzer Chrome Extension

> A polished Manifest V3 Chrome Extension that performs **fully local, privacy-first sentiment analysis** on any text you select on the web — right on the page, with a beautiful blur overlay and no external API calls.

---

## ✨ Features

| Feature | Details |
|---|---|
| **In-Page Overlay** | Page blurs behind the panel — no popups or tab switches |
| **Floating Action Button** | Appears near your cursor when text is selected |
| **Context Menu** | Right-click → "Analyze Sentiment" |
| **Sentiment Classification** | Positive 🟢 / Negative 🔴 / Neutral 🔵 |
| **Confidence Score** | Visual ring with 0–99% confidence |
| **Sentiment Bars** | Breakdown of positive / negative / neutral ratios |
| **Word-Level Breakdown** | Top 5 sentiment-driving words with their scores |
| **Range Sliders** | Adjust start/end character position and re-analyze |
| **Text Highlighting** | Highlights analyzed text on the page in the result color |
| **Analysis History** | Last 100 analyses stored locally in chrome.storage |
| **Export** | Download history as JSON or CSV |
| **Dark / Light Mode** | Auto-detects + manual toggle |
| **Privacy First** | Zero network requests — all analysis runs locally |

---

## 🗂 Project Structure

```
sentiment-analysis-ex/
├── manifest.json                  # Manifest V3 config
├── background/
│   └── service-worker.js          # Message router, history, export
├── content/
│   ├── content.js                 # FAB, overlay, highlighting
│   └── content.css                # Page-level styles (namespaced)
├── popup/
│   ├── popup.html                 # Extension toolbar popup
│   ├── popup.js                   # History, settings, export UI
│   └── popup.css                  # Popup styles (light/dark)
├── sentiment/
│   └── analyzer.js                # VADER-inspired lexicon engine
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── generate_icons.py              # Run once to generate icons
└── README.md
```

---

## 🚀 Installation

### Step 1 — Generate Icons (one-time)

```bash
cd /path/to/sentiment-analysis-ex
pip3 install Pillow
python3 generate_icons.py
```

This creates `icons/icon-16.png`, `icon-48.png`, and `icon-128.png`.

### Step 2 — Load in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `sentiment-analysis-ex/` folder
5. The SentiScope icon appears in your Chrome toolbar 🎉

---

## 🧠 Architecture & Data Flow

```
User selects text on any webpage
            │
            ▼
  content.js — detects mouseup with selection
            │
            ▼
  Floating Action Button appears near cursor
            │  (or right-click → context menu)
            ▼
  content.js — applies backdrop blur to <html>
             — injects Shadow DOM overlay panel
             — sends ANALYZE_TEXT message
            │
            ▼
  background/service-worker.js receives message
             — imports sentiment/analyzer.js
             — runs analyzeSentiment(text)
             — sends result back
            │
            ▼
  content.js — renders result in overlay:
             — sentiment badge (😊/😟/😐)
             — confidence ring (conic-gradient)
             — positive/negative/neutral bars
             — word-level breakdown
             — sends SAVE_HISTORY message
            │
            ▼
  chrome.storage.local — persists history entry
  popup.js — reads history on open → renders list
```

### Key Design Choices

| Choice | Reason |
|---|---|
| **Shadow DOM** for overlay | Prevents CSS conflicts with any host page |
| **VADER-inspired local lexicon** | No API key needed, instant results, fully private |
| **`backdrop-filter: blur`** on host | Creates immersive focus on the result panel |
| **Namespaced CSS** (`.sentiscope-*`) | Safe to inject into any webpage |
| **`chrome.storage.local`** for history | Persists across browser restarts, survives SW termination |
| **Batched DOM updates** with `requestAnimationFrame` | Prevents janky highlighting operations |

---

## 🔬 Sentiment Analysis Engine

The engine (`sentiment/analyzer.js`) is a **VADER-inspired** (Valence Aware Dictionary and sEntiment Reasoner) implementation:

- **Lexicon**: ~200 curated words with valence scores (-4 to +4)
- **Intensifiers**: "very", "extremely", "absolutely" → boost magnitude by up to 1.5×
- **Diminishers**: "somewhat", "slightly", "barely" → reduce magnitude
- **Negation**: "not", "never", "no" → flips sentiment (−74% of original)
- **CAPS emphasis**: ALL CAPS words get +25% magnitude boost
- **Exclamation marks**: add up to +0.87 to the compound score
- **Compound score**: Normalized to [−1.0, +1.0] using the VADER normalization formula
- **Threshold**: score ≥ 0.05 = Positive, ≤ −0.05 = Negative, else Neutral

---

## 🎨 Color System

| Sentiment | Color | Hex |
|---|---|---|
| Positive | Green | `#22c55e` |
| Negative | Red | `#ef4444` |
| Neutral | Blue-Gray | `#6b93d6` |
| Brand | Purple → Indigo | `#a855f7` → `#6366f1` |

---

## 🔐 Permissions Used

| Permission | Why |
|---|---|
| `activeTab` | Read the active tab to inject content script on demand |
| `contextMenus` | Add "Analyze Sentiment" to right-click menu |
| `storage` | Save analysis history and settings locally |
| `scripting` | Programmatically inject scripts if needed |
| `downloads` | Export history as JSON/CSV files |
| `host_permissions: <all_urls>` | Allow the content script to run on any webpage |

---

## 🛠 Development Notes

- The service worker uses **ES module imports** (`type: "module"` in manifest)
- Content scripts are injected **statically** via `content_scripts` declaration
- All async operations use `async/await` (no `.then()` chains)
- History is capped at **100 entries** (oldest removed automatically)
- The overlay uses a **conic-gradient** confidence ring with CSS custom properties

---

## 📦 Export Format

### JSON
```json
[
  {
    "id": 1234567890,
    "timestamp": "2025-06-08T12:00:00.000Z",
    "text": "This is an amazing product!",
    "url": "https://example.com",
    "pageTitle": "Example Page",
    "result": {
      "sentiment": "positive",
      "score": 0.6369,
      "confidence": 87,
      "positive": 0.85,
      "negative": 0.15,
      "neutral": 0.0,
      "wordCount": 5,
      "charCount": 28
    }
  }
]
```

### CSV
```
Timestamp,Sentiment,Score,Confidence,Word Count,URL,Text
2025-06-08T12:00:00.000Z,positive,0.6369,87,5,https://example.com,"This is an amazing product!"
```
