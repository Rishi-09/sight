// Hands-free mode listens all the time, so speech only counts when it starts with the assistant's
// name ("Sight, start live"). Speech-to-text often mishears names, so matching is fuzzy: spelling
// similarity, a rough sound-alike key, and known mishearings of the default name.

const GREETING = new Set(['hey', 'hi', 'ok', 'okay', 'hello', 'yo']);

// Whisper's usual mishearings of "Sight".
const SIGHT_ALIASES = new Set(['sight', 'site', 'cite', 'sites', 'sights', 'side', 'sigh', 'psych', 'sai', 'saight', 'sayt']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/'s\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// Very rough "sounds like" key: spellings of the same sound collapse, vowels drop after the first letter.
function soundKey(w: string): string {
  let s = w
    .replace(/'s$/, 's')
    .replace(/ght/g, 't')
    .replace(/gh/g, '')
    .replace(/ph/g, 'f')
    .replace(/^ps/, 's')
    .replace(/^kn/, 'n')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/ck|c|q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/d/g, 't')
    .replace(/b/g, 'p')
    .replace(/v/g, 'f');
  s = s[0] + s.slice(1).replace(/[aeiouyhw]/g, '');
  return s.replace(/(.)\1+/g, '$1');
}

function matchesName(candidate: string, name: string): boolean {
  if (candidate === name) return true;
  if (name === 'sight' && SIGHT_ALIASES.has(candidate)) return true;
  const similarity = 1 - levenshtein(candidate, name) / Math.max(candidate.length, name.length);
  if (similarity >= 0.75) return true;
  // Same sound key, loosely similar spelling, and not much shorter: avoids everyday words like
  // "set" or "sit" ("sit down") matching "sight".
  return soundKey(candidate) === soundKey(name) && similarity >= 0.5 && candidate.length >= name.length - 1;
}

/**
 * If the text starts with the name (optionally after "hey"/"ok"), returns what follows it ('' if only
 * the name was said). Returns null if it doesn't start with the name.
 */
export function stripWakeWord(text: string, name = 'Sight'): string | null {
  const nameWords = words(name);
  const tokens = words(text);
  if (!nameWords.length || !tokens.length) return null;

  // Only consider the name at the very start, optionally after one greeting word.
  for (const start of GREETING.has(tokens[0]) ? [1, 0] : [0]) {
    const candidate = tokens.slice(start, start + nameWords.length).join(' ');
    if (!candidate || !matchesName(candidate, nameWords.join(' '))) continue;
    // Cut the original text after the matched words, keeping the rest's punctuation and casing.
    const consumed = start + nameWords.length;
    const re = new RegExp(`^\\W*(?:\\S+\\W*){${consumed}}`);
    return text.trim().replace(re, '').trim();
  }
  return null;
}

/** Whisper prompt that biases transcription toward hearing the name correctly. */
export function whisperPrompt(name: string): string {
  return `${name}, start live. ${name}, what's in front of me? ${name}, stop. ${name}, repeat that.`;
}
