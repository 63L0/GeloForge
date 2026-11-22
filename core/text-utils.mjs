/**
 * Shared deterministic text, token-estimation, keywording, and fence-escaping helpers
 * reused across GeloForge Context Compiler and Portable Skills modules.
 */

export const TOKEN_ESTIMATE_METHOD = "heuristic:ceil(utf8_bytes/4)";

export const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "what", "where",
  "which", "will", "should", "must", "have", "has", "been", "being", "they", "their",
  "them", "then", "than", "only", "also", "more", "most", "some", "such", "each",
  "other", "about", "after", "before", "between", "through", "under", "over", "using",
  "use", "used", "task", "project", "brain", "file", "files", "all", "not", "are", "but",
]);

/**
 * Estimates prompt token count conservatively from UTF-8 byte length.
 */
export function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Extracts normalized search term tokens (>= 3 chars, excluding stop words), preserving multiplicities.
 */
export function tokenizeTerms(text) {
  if (!text || typeof text !== "string") {
    return [];
  }
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/**
 * Extracts normalized unique search keywords (>= 3 chars, excluding stop words).
 */
export function tokenizeKeywords(text) {
  return new Set(tokenizeTerms(text));
}

/**
 * Computes deterministic Okapi BM25 scores for candidate term arrays against query terms.
 */
export function scoreBm25Documents(queryTerms, docs, { k1 = 1.5, b = 0.75 } = {}) {
  const uniqueQuery = [];
  const seenQuery = new Set();
  for (const term of queryTerms || []) {
    if (typeof term === "string" && term.length > 0 && !seenQuery.has(term)) {
      seenQuery.add(term);
      uniqueQuery.push(term);
    }
  }
  const scores = new Map();
  if (uniqueQuery.length === 0 || !Array.isArray(docs) || docs.length === 0) {
    return scores;
  }

  const totalDocs = docs.length;
  const docFreq = new Map(uniqueQuery.map((term) => [term, 0]));
  let totalTerms = 0;

  const docStats = docs.map((doc) => {
    const terms = Array.isArray(doc.terms) ? doc.terms : [];
    totalTerms += terms.length;
    const tf = new Map();
    for (const term of terms) {
      if (docFreq.has(term)) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
      }
    }
    for (const term of tf.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
    return { id: doc.id, length: terms.length, tf };
  });

  const avgdl = totalTerms > 0 ? totalTerms / totalDocs : 1;
  for (const doc of docStats) {
    let score = 0;
    const normFactor = 1 - b + b * (doc.length / avgdl);
    for (const term of uniqueQuery) {
      const freq = doc.tf.get(term) ?? 0;
      if (freq === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * normFactor));
    }
    scores.set(doc.id, Math.round(score * 1e6) / 1e6);
  }
  return scores;
}

/**
 * Escapes spoofed GELOFORGE_DOC delimiters inside included text.
 * Marker escaping alone does NOT mitigate semantic prompt injection.
 */
export function sanitizeFenceContent(text) {
  return String(text || "")
    .replace(/<<<END_GELOFORGE_DOC>>>/g, "<<<ESCAPED_END_GELOFORGE_DOC>>>")
    .replace(/<<<GELOFORGE_DOC/g, "<<<ESCAPED_GELOFORGE_DOC");
}
