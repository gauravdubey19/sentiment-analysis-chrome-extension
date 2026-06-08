/**
 * SentiScope Sentiment Analyzer
 * A VADER-inspired lexicon-based sentiment analysis engine.
 * Runs entirely locally — no external API calls, full privacy.
 *
 * Returns: { sentiment, score, confidence, positive, negative, neutral, breakdown }
 *   - sentiment: 'positive' | 'negative' | 'neutral'
 *   - score: -1.0 to +1.0 (compound score)
 *   - confidence: 0 to 100 (percentage)
 *   - positive/negative/neutral: proportion ratios (0..1)
 *   - breakdown: array of { word, score, reason } for key tokens
 */

// ─── Lexicon ────────────────────────────────────────────────────────────────
// Valence scores range from -4 (extremely negative) to +4 (extremely positive)

const LEXICON = {
  // Strongly Positive
  "outstanding": 3.8, "excellent": 3.5, "amazing": 3.5, "fantastic": 3.5,
  "wonderful": 3.5, "brilliant": 3.5, "superb": 3.5, "exceptional": 3.5,
  "incredible": 3.5, "magnificent": 3.5, "phenomenal": 3.5, "spectacular":3.5,
  "extraordinary": 3.5, "splendid": 3.2, "awesome": 3.2, "marvelous": 3.2,
  "delightful": 3.2, "terrific": 3.0, "perfect": 3.5, "flawless": 3.2,
  "love": 3.0, "adore": 3.2, "cherish": 3.0, "passionate": 2.8,
  "thrilled": 2.8, "ecstatic": 3.5, "elated": 3.2, "overjoyed": 3.5,
  "jubilant": 3.2, "euphoric": 3.5,

  // Moderately Positive
  "good": 1.9, "great": 3.1, "nice": 1.8, "lovely": 2.5, "happy": 2.7,
  "joyful": 2.8, "cheerful": 2.5, "pleased": 2.0, "satisfied": 2.0,
  "glad": 2.1, "thankful": 2.2, "grateful": 2.4, "hopeful": 1.9,
  "optimistic": 2.2, "confident": 1.8, "enjoyable": 2.2, "fun": 1.9,
  "pleasant": 2.0, "positive": 1.9, "successful": 2.2, "effective": 1.8,
  "helpful": 1.9, "useful": 1.7, "valuable": 1.9, "impressive": 2.4,
  "elegant": 2.1, "beautiful": 2.9, "pretty": 2.0, "charming": 2.3,
  "friendly": 2.0, "kind": 2.1, "caring": 2.0, "supportive": 2.0,
  "reliable": 1.9, "trustworthy": 2.1, "honest": 1.9, "fair": 1.6,
  "better": 1.5, "best": 3.0, "improved": 1.6, "progress": 1.5,
  "innovative": 2.0, "creative": 1.9, "smart": 1.8, "clever": 1.8,
  "recommended": 1.7, "approve": 1.5, "endorse": 1.7, "prefer": 1.2,
  "enjoy": 2.0, "like": 1.4, "appreciate": 1.9, "worthy": 1.7,
  "safe": 1.5, "secure": 1.6, "clean": 1.4, "clear": 1.2, "fresh": 1.5,
  "exciting": 2.3, "enthusiastic": 2.5, "motivated": 2.0, "inspired": 2.2,
  "productive": 1.8, "efficient": 1.7, "powerful": 1.8, "robust": 1.7,
  "smooth": 1.4, "easy": 1.5, "simple": 1.2, "quick": 1.1, "fast": 1.2,
  "free": 1.0, "open": 0.9, "flexible": 1.3, "generous": 2.0, "brave": 2.0,
  "courageous": 2.2, "strong": 1.5, "capable": 1.4, "skilled": 1.7,
  "compassionate": 2.3, "loyal": 2.0, "dedicated": 2.0, "committed": 1.8,

  // Mildly Positive
  "ok": 0.9, "okay": 0.9, "fine": 0.6, "decent": 0.9, "acceptable": 0.9,
  "adequate": 0.5, "reasonable": 0.7, "stable": 0.8, "steady": 0.7,
  "manageable": 0.5, "appropriate": 0.7,

  // Neutral/Objective (near-zero scores)
  "new": 0.1, "different": 0.0, "various": 0.0, "many": 0.0,

  // Mildly Negative
  "mediocre": -1.2, "dull": -1.0, "boring": -1.2, "bland": -1.0,
  "weak": -1.2, "slow": -1.1, "outdated": -1.3, "expensive": -1.2,
  "complicated": -1.1, "difficult": -1.0, "confusing": -1.3, "unclear": -1.1,
  "limited": -0.9, "lacking": -1.2, "poor": -1.9, "bad": -2.0,
  "wrong": -1.5, "mistake": -1.5, "error": -1.4, "problem": -1.3,
  "issue": -1.0, "concern": -1.0, "trouble": -1.3, "worry": -1.3,
  "disappointing": -2.2, "disappointed": -2.0, "frustrating": -2.0,
  "frustrated": -1.9, "annoying": -1.8, "annoyed": -1.6, "upset": -1.8,
  "unhappy": -2.0, "sad": -2.1, "unfortunate": -1.8, "regret": -1.9,
  "regrettable": -2.0, "failure": -2.1, "fail": -1.8, "failed": -2.0,
  "wrong": -1.5, "broken": -1.9, "defective": -2.0, "flawed": -1.7,
  "worse": -1.9, "worst": -3.2, "inferior": -2.1, "substandard": -2.0,
  "inadequate": -1.6, "unacceptable": -2.2, "unreliable": -1.9,
  "difficult": -1.2, "hard": -1.0, "tough": -1.0, "challenging": -0.8,
  "complex": -0.7, "risky": -1.5, "dangerous": -2.2, "harmful": -2.4,
  "negative": -1.4, "critical": -1.0,

  // Moderately Negative
  "terrible": -3.0, "horrible": -3.2, "awful": -3.1, "dreadful": -2.9,
  "horrific": -3.2, "atrocious": -3.5, "appalling": -3.2, "abysmal": -3.5,
  "disgusting": -3.1, "revolting": -3.2, "repulsive": -3.0, "offensive": -2.7,
  "unpleasant": -2.1, "nasty": -2.5, "vile": -3.0, "inferior": -2.1,
  "incompetent": -2.5, "useless": -2.5, "worthless": -2.8, "pointless": -2.0,
  "waste": -2.2, "spam": -1.8, "fake": -2.0, "dishonest": -2.5,
  "corrupt": -3.0, "manipulative": -2.8, "deceptive": -2.7, "unfair": -1.9,
  "cruel": -3.1, "brutal": -2.8, "violent": -2.9, "aggressive": -2.0,
  "hostile": -2.7, "hateful": -3.2, "racist": -3.5, "abusive": -3.3,
  "toxic": -2.9, "evil": -3.2, "sinister": -2.8, "wicked": -3.0,
  "greedy": -2.4, "selfish": -2.2, "arrogant": -2.3, "rude": -2.4,

  // Strongly Negative
  "catastrophic": -3.5, "devastating": -3.5, "disastrous": -3.5,
  "unbearable": -3.2, "intolerable": -3.2, "inexcusable": -3.3,
  "outrageous": -3.0, "despicable": -3.5, "malicious": -3.2,
  "terrifying": -3.0, "frightening": -2.8, "alarming": -2.5,
  "shocking": -2.3, "disgraceful": -3.0, "shameful": -2.8,
  "hate": -3.0, "loathe": -3.2, "despise": -3.2, "detest": -3.0,
  "abhor": -3.2, "horrified": -3.2, "furious": -3.0, "enraged": -3.2,
  "devastated": -3.2, "heartbroken": -3.0, "miserable": -3.0, "agonizing": -3.2
};

// ─── Modifier Lists ──────────────────────────────────────────────────────────

/** Intensifiers — boost the magnitude of adjacent sentiment words */
const INTENSIFIERS = {
  "very": 1.3, "extremely": 1.5, "incredibly": 1.5, "absolutely": 1.5,
  "utterly": 1.5, "completely": 1.4, "totally": 1.4, "highly": 1.3,
  "really": 1.2, "super": 1.3, "so": 1.2, "quite": 1.1, "particularly": 1.2,
  "especially": 1.3, "terribly": 1.3, "awfully": 1.3, "remarkably": 1.4,
  "exceptionally": 1.4, "extraordinarily": 1.5, "undeniably": 1.4,
  "unbelievably": 1.5, "deeply": 1.3, "profoundly": 1.4, "immensely": 1.4,
  "enormously": 1.4, "vastly": 1.3, "hugely": 1.3, "massively": 1.3,
  "overwhelming": 1.4, "overwhelmingly": 1.5, "significantly": 1.2,
  "substantially": 1.2, "genuinely": 1.2, "truly": 1.3
};

/** Diminishers — reduce the magnitude of adjacent sentiment words */
const DIMINISHERS = {
  "somewhat": 0.7, "slightly": 0.6, "a bit": 0.6, "a little": 0.6,
  "kind of": 0.7, "kinda": 0.7, "sort of": 0.7, "sorta": 0.7,
  "rather": 0.8, "fairly": 0.8, "mostly": 0.9, "nearly": 0.9,
  "almost": 0.9, "barely": 0.5, "hardly": 0.5, "marginally": 0.6,
  "mildly": 0.6, "moderately": 0.7, "relatively": 0.8
};

/** Negation words — flip the sentiment of the next word */
const NEGATION_WORDS = new Set([
  "not", "no", "never", "nothing", "neither", "nor", "nobody", "nowhere",
  "none", "cannot", "can't", "won't", "wouldn't", "shouldn't", "couldn't",
  "didn't", "doesn't", "don't", "isn't", "wasn't", "weren't", "haven't",
  "hadn't", "hasn't", "mustn't", "needn't", "without", "lack", "lacking",
  "rarely", "seldom", "hardly", "scarcely", "barely", "fails", "fail",
  "failed", "contrary", "despite", "against", "refuse", "refused",
  "rejection", "reject", "deny", "denied"
]);

// ─── Core Analysis Function ──────────────────────────────────────────────────

/**
 * Analyzes the sentiment of the given text.
 * @param {string} text - The text to analyze
 * @returns {{ sentiment: string, score: number, confidence: number, positive: number, negative: number, neutral: number, breakdown: Array, wordCount: number, charCount: number }}
 */
function analyzeSentiment(text) {
  if (!text || text.trim().length === 0) {
    return {
      sentiment: "neutral", score: 0, confidence: 50,
      positive: 0, negative: 0, neutral: 1,
      breakdown: [], wordCount: 0, charCount: 0
    };
  }

  const trimmedText = text.trim();
  const charCount = trimmedText.length;

  // Tokenize
  const tokens = tokenize(trimmedText);
  const wordCount = tokens.filter(t => /^[a-z]/i.test(t)).length;

  const valences = [];
  const breakdown = [];
  let negationWindow = 0; // counts down for negation scope

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lowerToken = token.toLowerCase();

    // Handle negation scope (applies 3 words ahead)
    if (NEGATION_WORDS.has(lowerToken)) {
      negationWindow = 3;
      continue;
    }
    if (negationWindow > 0) negationWindow--;

    // Skip tokens with no lexicon entry
    if (!(lowerToken in LEXICON)) continue;

    let valence = LEXICON[lowerToken];
    const reasons = [];

    // Capitalization emphasis (ALL CAPS boosts |valence| by 25%)
    if (token === token.toUpperCase() && token.length > 1) {
      valence *= 1.25;
      reasons.push("CAPS emphasis");
    }

    // Intensifier (look back 1–2 tokens)
    for (let back = 1; back <= 2; back++) {
      const prev = tokens[i - back]?.toLowerCase();
      if (prev && INTENSIFIERS[prev]) {
        valence *= INTENSIFIERS[prev];
        reasons.push(`intensified by "${prev}"`);
        break;
      }
      if (prev && DIMINISHERS[prev]) {
        valence *= DIMINISHERS[prev];
        reasons.push(`diminished by "${prev}"`);
        break;
      }
    }

    // Negation flip
    if (negationWindow > 0) {
      valence *= -0.74; // partial negation, not full inversion
      reasons.push("negated");
    }

    // Exclamation marks (add 0.29 per mark, up to 3)
    const exclamations = (trimmedText.match(/!/g) || []).length;
    if (exclamations > 0 && valence !== 0) {
      valence += Math.min(exclamations, 3) * 0.29 * Math.sign(valence);
      if (exclamations > 0) reasons.push(`${exclamations} exclamation mark(s)`);
    }

    // Question marks may reduce confidence in positive assertions
    const questionMarks = (trimmedText.match(/\?/g) || []).length;
    if (questionMarks > 1 && valence > 0) {
      valence *= 0.85;
      reasons.push("rhetorical question dampen");
    }

    valences.push(valence);
    breakdown.push({
      word: token,
      rawScore: LEXICON[lowerToken].toFixed(2),
      adjustedScore: valence.toFixed(2),
      reasons
    });
  }

  // Compute compound score (normalized to -1..+1)
  const compound = normalizeScore(valences);

  // Proportional ratios (pos/neg/neu)
  let pos = 0, neg = 0;
  for (const v of valences) {
    if (v > 0) pos += v;
    else if (v < 0) neg += Math.abs(v);
  }
  const total = pos + neg || 1;
  const posRatio = pos / total;
  const negRatio = neg / total;
  const neutralRatio = 1 - Math.min(1, (pos + neg) / Math.max(1, wordCount * 2));

  // Classify
  let sentiment;
  if (compound >= 0.05) sentiment = "positive";
  else if (compound <= -0.05) sentiment = "negative";
  else sentiment = "neutral";

  // Confidence: based on |compound| and number of sentiment words found
  const rawConfidence = Math.abs(compound);
  const sentimentWordRatio = Math.min(1, valences.length / Math.max(1, wordCount * 0.3));
  const confidence = Math.round(
    Math.min(99, Math.max(30, (rawConfidence * 0.7 + sentimentWordRatio * 0.3) * 100))
  );

  return {
    sentiment,
    score: parseFloat(compound.toFixed(4)),
    confidence,
    positive: parseFloat(posRatio.toFixed(3)),
    negative: parseFloat(negRatio.toFixed(3)),
    neutral: parseFloat(neutralRatio.toFixed(3)),
    breakdown: breakdown.slice(0, 20), // limit breakdown for display
    wordCount,
    charCount,
    sentimentWordCount: valences.length
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Tokenize text into lowercase words, preserving original case for CAPS check.
 */
function tokenize(text) {
  return text
    .replace(/[^a-zA-Z0-9''-\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * Normalize sum of valences to a -1..+1 compound score using VADER formula.
 */
function normalizeScore(valences) {
  if (valences.length === 0) return 0;
  const sum = valences.reduce((a, b) => a + b, 0);
  const alpha = 15; // normalization constant
  return sum / Math.sqrt(sum * sum + alpha);
}
