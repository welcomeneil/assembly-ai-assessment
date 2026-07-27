/**
 * Word error rate and keyterm recall.
 *
 * This is the only place a number on the dashboard is computed, so it is the one file
 * with unit tests. See score.test.ts.
 *
 * CHAT-format markup in the corpus transcript is stripped by fixtures/build_fixture.py
 * before it ever reaches here -- this module only sees plain text.
 */

import type { DiffOp } from "./types.js";

export interface Score {
  /** Errors per reference word. Can exceed 1 when the recogniser inserts words. */
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
  ops: DiffOp[];
}

export interface Token {
  /** What the comparison runs on. */
  norm: string;
  /** What the reader sees, with its original case and spelling intact. */
  raw: string;
}

// Anything that separates words. Apostrophes are deliberately absent: "don't" is one
// word. Inverted Spanish marks are absent too, so "¿cuánto" stays a single token the
// way it does in the reference transcripts.
const SEPARATORS = /[^\s.,!?;:"“”«»()[\]—–]+/gu;

/**
 * Reduce text to comparable tokens, keeping the surface form alongside.
 *
 * Punctuation and case are formatting, not recognition: a model that returns "Fort
 * Lauderdale." should not be scored wrong against "fort lauderdale". But the dashboard
 * still has to *show* "Fort Lauderdale" -- displaying the lowercased comparison form
 * would make a correct proper noun look like a mistake, which is the opposite of the
 * point. Accents are kept, because in Spanish they distinguish words rather than
 * decorate them.
 */
export function tokenizeWithRaw(text: string): Token[] {
  return [...text.normalize("NFC").matchAll(SEPARATORS)].map((match) => ({
    raw: match[0],
    norm: match[0].toLowerCase(),
  }));
}

export function tokenize(text: string): string[] {
  return tokenizeWithRaw(text).map((token) => token.norm);
}

/**
 * Levenshtein alignment with backtrace, which is what WER is defined as.
 *
 * The backtrace is what lets the dashboard colour individual words rather than just
 * print a percentage -- seeing *which* word was lost is the part a customer reacts to.
 */
export function score(reference: string, hypothesis: string): Score {
  const refTokens = tokenizeWithRaw(reference);
  const hypTokens = tokenizeWithRaw(hypothesis);
  const ref = refTokens.map((token) => token.norm);
  const hyp = hypTokens.map((token) => token.norm);

  // distance[i][j] = edits to turn the first i reference words into the first j
  // hypothesis words.
  const distance: number[][] = Array.from({ length: ref.length + 1 }, () =>
    new Array<number>(hyp.length + 1).fill(0),
  );
  for (let i = 0; i <= ref.length; i++) distance[i]![0] = i;
  for (let j = 0; j <= hyp.length; j++) distance[0]![j] = j;

  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const match = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      distance[i]![j] = Math.min(
        distance[i - 1]![j]! + 1, // deletion: reference word not recognised
        distance[i]![j - 1]! + 1, // insertion: word invented
        distance[i - 1]![j - 1]! + match, // match or substitution
      );
    }
  }

  const ops: DiffOp[] = [];
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = ref.length;
  let j = hyp.length;

  while (i > 0 || j > 0) {
    // Ops carry the surface forms so the dashboard can print the sentence back the way
    // it was said, with only the errors marked.
    const refWord = refTokens[i - 1]?.raw;
    const hypWord = hypTokens[j - 1]?.raw;
    const match = i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] ? 0 : 1;

    if (i > 0 && j > 0 && distance[i]![j] === distance[i - 1]![j - 1]! + match) {
      if (match === 0) {
        ops.push({ kind: "ok", ref: refWord!, hyp: hypWord! });
      } else {
        ops.push({ kind: "sub", ref: refWord!, hyp: hypWord! });
        substitutions++;
      }
      i--;
      j--;
    } else if (i > 0 && distance[i]![j] === distance[i - 1]![j]! + 1) {
      ops.push({ kind: "del", ref: refWord! });
      deletions++;
      i--;
    } else {
      ops.push({ kind: "ins", hyp: hypWord! });
      insertions++;
      j--;
    }
  }
  ops.reverse();

  const errors = substitutions + deletions + insertions;
  return {
    // An empty reference with any hypothesis is all insertions; guard the divide.
    wer: ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : errors / ref.length,
    substitutions,
    deletions,
    insertions,
    referenceWords: ref.length,
    ops,
  };
}

/**
 * Score a partly-delivered hypothesis against a full reference.
 *
 * Mid-session, everything the speaker has not said yet aligns as a deletion, so a naive
 * WER against the full reference starts near 1 and falls as the session runs -- which
 * looks like the model improving and is not. Dropping the trailing deletions scores only
 * the region actually reached, which is the number that means something while a live
 * session is still going.
 */
export function scorePrefix(reference: string, hypothesisSoFar: string): Score {
  const full = score(reference, hypothesisSoFar);

  let end = full.ops.length;
  while (end > 0 && full.ops[end - 1]!.kind === "del") end--;
  const ops = full.ops.slice(0, end);

  const substitutions = ops.filter((op) => op.kind === "sub").length;
  const deletions = ops.filter((op) => op.kind === "del").length;
  const insertions = ops.filter((op) => op.kind === "ins").length;
  const referenceWords = ops.filter((op) => op.kind !== "ins").length;
  const errors = substitutions + deletions + insertions;

  return {
    wer: referenceWords === 0 ? (insertions > 0 ? 1 : 0) : errors / referenceWords,
    substitutions,
    deletions,
    insertions,
    referenceWords,
    ops,
  };
}

/**
 * Which keyterms actually came back.
 *
 * Multi-word terms ("Fort Lauderdale") are matched as token sequences, because that is
 * how they fail: the model gets one half and loses the other.
 */
export function keytermsHit(keyterms: string[], hypothesis: string): string[] {
  const hyp = tokenize(hypothesis);
  return keyterms.filter((term) => {
    const needle = tokenize(term);
    if (needle.length === 0) return false;
    for (let i = 0; i + needle.length <= hyp.length; i++) {
      if (needle.every((word, k) => hyp[i + k] === word)) return true;
    }
    return false;
  });
}

/** Keyterms a reference turn contains, i.e. the ones that turn could have got right. */
export function keytermsExpected(keyterms: string[], reference: string): string[] {
  return keytermsHit(keyterms, reference);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
