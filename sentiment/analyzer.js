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


// ─── Core Analysis Function ──────────────────────────────────────────────────

/**
 * Analyzes the sentiment of the given text.
 * @param {string} text - The text to analyze
 * @returns {{ sentiment: string, score: number, confidence: number, positive: number, negative: number, neutral: number, breakdown: Array, wordCount: number, charCount: number }}
 */
function analyzeSentiment(text) {
  if (!text || text.trim().length === 0) {
    return {
      sentiment: "neutral",
      score: 0,
      confidence: 50,
      positive: 0,
      negative: 0,
      neutral: 1,
      breakdown: [],
      wordCount: 0,
      charCount: 0,
    };
  }

  const trimmedText = text.trim();
  const charCount = trimmedText.length;

  // Tokenize
  const tokens = tokenize(trimmedText);
  const wordCount = tokens.filter((t) => /^[a-z]/i.test(t)).length;

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
      reasons,
    });
  }

  // Compute compound score (normalized to -1..+1)
  const compound = normalizeScore(valences);

  // Proportional ratios (pos/neg/neu)
  let pos = 0,
    neg = 0;
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
  const confidence = Math.round(Math.min(99, Math.max(30, (rawConfidence * 0.7 + sentimentWordRatio * 0.3) * 100)));

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
    sentimentWordCount: valences.length,
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
    .filter((t) => t.length > 1);
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
