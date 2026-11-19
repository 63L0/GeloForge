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
 * Extracts normalized search keywords (>= 3 chars, excluding stop words).
 */
export function tokenizeKeywords(text) {
  if (!text || typeof text !== "string") {
    return new Set();
  }
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
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
