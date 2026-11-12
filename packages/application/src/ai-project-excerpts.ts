/**
 * What of an AI project's reference files a call carries: deterministic excerpts, no extra model
 * call (decision 4, amended F). Each excerpt is about a quarter the text's head and the rest its
 * paragraphs that best match the task's terms (BM25), kept in document order; a transcript with no
 * paragraph breaks falls back to sentences. The budget is the smaller of
 * {@link AI_PROJECT_EXCERPT_MAX_CHARS} and a share of the tier's spare context, split 50 / 30 / 20
 * across the first three references (a share one can't use passes on).
 */

/** Most characters of reference text one call carries inline, all references together. */
export const AI_PROJECT_EXCERPT_MAX_CHARS = 12_000;
/** References excerpted per call; the rest are listed by title and length. */
export const AI_PROJECT_EXCERPTED_REFERENCES = 3;
/** How the excerpt budget splits across the excerpted references, in order. */
export const AI_PROJECT_EXCERPT_WEIGHTS: readonly number[] = [50, 30, 20];
/** The part of a reference an excerpt is chosen from: its first characters. */
export const AI_PROJECT_EXCERPT_SOURCE_CHARS = 100_000;
/** Bytes read to get them: a ranged read, never the whole 500,000 characters. */
export const AI_PROJECT_EXCERPT_SOURCE_BYTES = 200_000;
/** The share of a tier's spare context the excerpts may take. */
const SPARE_SHARE = 0.5;
/** Tokens held back from the spare context for headers, wrappers and the estimate's error. */
const SAFETY_TOKENS = 512;
/** An excerpt's head: about a quarter of what it may hold. */
const HEAD_SHARE = 0.25;
/** What sits between two non-adjacent passages of one excerpt. */
const GAP = '\n…\n';

// ---- token estimates ---------------------------------------------------------------------------

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN = /[\p{Script=Latin}\p{N}\p{P}\p{Zs}\n\t]/u;

/**
 * Tokens `text` is likely to cost, by script: Latin text (and digits, punctuation, spaces) about
 * four characters a token, CJK about one, other scripts (Cyrillic, Greek, Arabic, Devanagari, …)
 * about two. An estimate to budget by, rounded up: what the model bills is what the call settles.
 */
export function estimateTokens(text: string): number {
  let latin = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else if (ch.charCodeAt(0) < 0x80 || LATIN.test(ch)) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4 + cjk + other / 2);
}

/** Characters per token in `sample` (at least one character a token). */
function charsPerToken(sample: string): number {
  if (!sample) return 4;
  return Math.max(1, sample.length / Math.max(1, estimateTokens(sample)));
}

export interface ExcerptBudgetInput {
  /** The tier's context window (`AIProvider.limits`). */
  readonly contextTokens: number;
  /** The whole system prompt and user turn the call sends besides the references. */
  readonly system: string;
  readonly prompt: string;
  /** The answer's room. */
  readonly maxTokens: number;
  /** The reference texts the budget is spent on, to read their script's density off. */
  readonly sample: string;
}

/**
 * The excerpt budget in characters: the smaller of {@link AI_PROJECT_EXCERPT_MAX_CHARS} and half
 * the tier's spare context (its window less the system prompt, the task, the content and the
 * answer's room), at the references' own characters per token. 0 when nothing is spare.
 */
export function excerptBudgetChars(input: ExcerptBudgetInput): number {
  const used =
    estimateTokens(input.system) + estimateTokens(input.prompt) + input.maxTokens + SAFETY_TOKENS;
  const spare = input.contextTokens - used;
  if (spare <= 0) return 0;
  const chars = Math.floor(spare * SPARE_SHARE * charsPerToken(input.sample));
  return Math.max(0, Math.min(AI_PROJECT_EXCERPT_MAX_CHARS, chars));
}

/**
 * How many characters each excerptable reference gets of `budget`, in order, by
 * {@link AI_PROJECT_EXCERPT_WEIGHTS}: each takes its weight's share of what is left, at most its
 * text's length, and what it can't use passes on to the next.
 */
export function splitExcerptBudget(budget: number, lengths: readonly number[]): number[] {
  const weights = lengths.map((_, i) => AI_PROJECT_EXCERPT_WEIGHTS[i] ?? 0);
  const out: number[] = [];
  let left = budget;
  for (let i = 0; i < lengths.length; i++) {
    const rest = weights.slice(i).reduce((a, b) => a + b, 0);
    const share = rest > 0 ? Math.floor((left * (weights[i] ?? 0)) / rest) : 0;
    const take = Math.min(share, lengths[i] ?? 0);
    out.push(take);
    left -= take;
  }
  return out;
}

// ---- hygiene -------------------------------------------------------------------------------------

/**
 * A PDF's text without the `## Metadata` section Markdown conversion writes (author, producer,
 * creation tool), up to the next second-level heading: none of it is what the document says, and
 * it should never reach a prompt. Texts extracted since conversion was told to leave metadata out
 * have none; older ones are cleaned here as they are read.
 */
export function stripPdfMetadata(text: string): string {
  return text.replace(/(^|\n)## Metadata[ \t]*\n[\s\S]*?(?=\n## |$)/, '$1').replace(/^\n+/, '');
}

// ---- passages and BM25 -------------------------------------------------------------------------

/** A run of a text: its characters `[start, end)`. */
interface Passage {
  readonly start: number;
  readonly end: number;
}

/** Paragraphs (blank-line separated), or sentences when the text has too few paragraphs. */
function passagesOf(text: string, from: number, maxPassage: number): Passage[] {
  const paragraphs: Passage[] = [];
  const re = /\n[ \t]*\n+/g;
  let at = from;
  for (const m of text.slice(from).matchAll(re)) {
    const end = from + (m.index ?? 0);
    if (end > at) paragraphs.push({ start: at, end });
    at = end + m[0].length;
  }
  if (at < text.length) paragraphs.push({ start: at, end: text.length });
  // A transcript (or a wall of text) has few breaks: its passages are its sentences.
  const tooCoarse =
    paragraphs.length < 3 || paragraphs.some((p) => p.end - p.start > Math.max(maxPassage, 1));
  if (!tooCoarse) return paragraphs;
  const sentences: Passage[] = [];
  const sre = /[.!?。！？](?=\s|$)\s*/gu;
  at = from;
  for (const m of text.slice(from).matchAll(sre)) {
    const end = from + (m.index ?? 0) + m[0].length;
    if (end > at) sentences.push({ start: at, end });
    at = end;
  }
  if (at < text.length) sentences.push({ start: at, end: text.length });
  // A sentence longer than a passage may be is cut into pieces of that size.
  return sentences.flatMap((s) => {
    const out: Passage[] = [];
    for (let a = s.start; a < s.end; a += maxPassage) {
      out.push({ start: a, end: Math.min(s.end, a + maxPassage) });
    }
    return out;
  });
}

const STOPWORDS = new Set(
  (
    'the and for with that this from are was were has have had not but you your our their its ' +
    'into over under than then them they what when where which who will would can could should ' +
    'about all any each more most some such only also very just been being does did done'
  ).split(' '),
);

/**
 * Terms of a text for matching: lowercase words of three letters or more (stopwords out), and
 * character bigrams of CJK runs (which have no spaces between words).
 */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLocaleLowerCase('en-US').matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    if (CJK.test(word)) {
      const chars = [...word];
      if (chars.length === 1) out.push(word);
      for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
    } else if (word.length >= 3 && !STOPWORDS.has(word)) {
      out.push(word);
    }
  }
  return out;
}

const K1 = 1.2;
const B = 0.75;

/** Each passage's BM25 score against `query`'s terms. */
function bm25(text: string, passages: readonly Passage[], query: readonly string[]): number[] {
  const docs = passages.map((p) => termsOf(text.slice(p.start, p.end)));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const unique = [...new Set(query)];
  const df = new Map(unique.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of unique) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.length) / Math.max(1, avg)));
    }
    return score;
  });
}

// ---- excerpts ------------------------------------------------------------------------------------

export interface Excerpt {
  /** The excerpt as sent: its passages in document order, a gap marker between non-adjacent ones. */
  readonly text: string;
  /** Characters of the reference text sent, `[start, end)`, in order. */
  readonly ranges: readonly (readonly [number, number])[];
}

/** `[start, end)` cut back to the last whitespace before `end`, when there is one past `start`. */
function cutAtSpace(text: string, start: number, end: number): number {
  if (end >= text.length) return text.length;
  const space = text.lastIndexOf(' ', end);
  const line = text.lastIndexOf('\n', end);
  const at = Math.max(space, line);
  return at > start ? at : end;
}

/**
 * An excerpt of `text` within `maxChars` characters: the whole text when it fits; else about a
 * quarter its head, then the passages that best match `query` (BM25, ties to the earlier one) in
 * document order, as many as fit. Deterministic: the same text, budget and query give the same
 * excerpt.
 */
export function selectExcerpt(text: string, maxChars: number, query: string): Excerpt {
  if (maxChars <= 0 || !text) return { text: '', ranges: [] };
  if (text.length <= maxChars) return { text, ranges: [[0, text.length]] };
  const headEnd = cutAtSpace(text, 0, Math.floor(maxChars * HEAD_SHARE));
  const ranges: [number, number][] = headEnd > 0 ? [[0, headEnd]] : [];
  let room = maxChars - headEnd;
  const passages = passagesOf(text, headEnd, Math.max(200, Math.floor(maxChars / 4)));
  const terms = termsOf(query);
  const scores = terms.length > 0 ? bm25(text, passages, terms) : passages.map(() => 0);
  // Best first; with no terms (or no match), in document order: the text after the head.
  const order = passages
    .map((p, i) => ({ p, i, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const picked: Passage[] = [];
  for (const { p } of order) {
    const length = p.end - p.start + GAP.length;
    if (length > room) continue;
    picked.push(p);
    room -= length;
    if (room <= GAP.length) break;
  }
  picked.sort((a, b) => a.start - b.start);
  for (const p of picked) {
    const last = ranges[ranges.length - 1];
    // A passage right after the last one (only whitespace between) extends it.
    if (last && !text.slice(last[1], p.start).trim()) last[1] = p.end;
    else ranges.push([p.start, p.end]);
  }
  const parts = ranges.map(([a, b]) => text.slice(a, b).trim());
  return { text: parts.join(GAP), ranges };
}
