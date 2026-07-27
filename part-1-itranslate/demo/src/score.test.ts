/**
 * Tests for the scoring engine. Every expected value here is worked out by hand, so a
 * regression in the aligner shows up as a wrong number rather than a plausible one.
 *
 *   npm test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { keytermsHit, median, score, scorePrefix, tokenize } from "./score.js";

test("tokenize strips punctuation and case but keeps Spanish accents", () => {
  assert.deepEqual(tokenize("Fort Lauderdale."), ["fort", "lauderdale"]);
  assert.deepEqual(tokenize("¿Cuánto?  Sí!"), ["¿cuánto", "sí"]);
  assert.deepEqual(tokenize("«y ¡ay!»"), ["y", "¡ay"]);
  assert.deepEqual(tokenize("   "), []);
});

test("identical strings score zero", () => {
  const result = score("they have Chicago from Fort Lauderdale", "they have Chicago from Fort Lauderdale");
  assert.equal(result.wer, 0);
  assert.equal(result.referenceWords, 6);
  assert.equal(result.ops.filter((op) => op.kind === "ok").length, 6);
});

test("one substitution in six words is 1/6", () => {
  // "Lauderdale" -> "loaderdale": 1 substitution, 6 reference words.
  const result = score(
    "they have Chicago from Fort Lauderdale",
    "they have Chicago from Fort loaderdale",
  );
  assert.equal(result.substitutions, 1);
  assert.equal(result.deletions, 0);
  assert.equal(result.insertions, 0);
  assert.equal(result.wer, 1 / 6);
});

test("counts substitutions, deletions and insertions separately", () => {
  // ref: the only thing is they don't fly to Canada          (9 words)
  // hyp: the only thing is they don't fly to Canada so        (+1 insertion)
  const inserted = score(
    "the only thing is they don't fly to Canada",
    "the only thing is they don't fly to Canada so",
  );
  assert.equal(inserted.insertions, 1);
  assert.equal(inserted.substitutions, 0);
  assert.equal(inserted.wer, 1 / 9);

  // A dropped word is a deletion.
  const deleted = score("but they they fly to Chicago", "but they fly to Chicago");
  assert.equal(deleted.deletions, 1);
  assert.equal(deleted.wer, 1 / 6);
});

test("word error rate can exceed 1", () => {
  // 2 reference words, 4 hypothesis words: 2 substitutions + 2 insertions = 4 errors.
  const result = score("it's good", "it is really quite good");
  assert.equal(result.referenceWords, 2);
  assert.ok(result.wer > 1, `expected wer > 1, got ${result.wer}`);
});

test("empty reference is handled without dividing by zero", () => {
  assert.equal(score("", "").wer, 0);
  assert.equal(score("", "something").wer, 1);
  assert.equal(score("something", "").wer, 1);
});

test("diff ops line up with the reference so the dashboard can colour words", () => {
  const result = score("porque se llama Paige the girl", "pork a se yama page the girl");
  const rendered = result.ops.map((op) => op.kind).join(" ");
  // Whatever path the aligner takes, every reference word must be accounted for
  // exactly once by an ok, sub or del.
  const accounted = result.ops.filter((op) => op.kind !== "ins").length;
  assert.equal(accounted, result.referenceWords, rendered);
  assert.equal(
    result.substitutions + result.deletions + result.insertions,
    Math.round(result.wer * result.referenceWords),
  );
});

test("scorePrefix ignores reference the speaker has not reached yet", () => {
  const reference = "they have Chicago from Fort Lauderdale for eighty eight dollars";
  // Halfway through the session, only the first five words have been spoken.
  const partial = scorePrefix(reference, "they have Chicago from Fort");
  assert.equal(partial.wer, 0, "a perfect partial transcript should score 0, not 5/10");
  assert.equal(partial.referenceWords, 5);

  // A real error inside the delivered region still counts.
  const withError = scorePrefix(reference, "they have chicargo from Fort");
  assert.equal(withError.substitutions, 1);
  assert.equal(withError.wer, 1 / 5);

  // Once the whole reference is delivered, it agrees with score().
  const complete = scorePrefix(reference, reference);
  assert.equal(complete.wer, score(reference, reference).wer);
  assert.equal(complete.referenceWords, 10);
});

test("scorePrefix on an empty hypothesis scores nothing rather than everything", () => {
  const result = scorePrefix("they have Chicago", "");
  assert.equal(result.referenceWords, 0);
  assert.equal(result.wer, 0);
});

test("ops carry the original spelling, not the comparison form", () => {
  // The dashboard prints these back to the customer. Lowercasing a proper noun that
  // the model got right would make a win look like a mistake.
  const result = score("Lauren like I'm ay me tienen cansada", "Lauren like I'm ay me tienen cansada");
  assert.equal(result.wer, 0);
  assert.equal(result.ops.map((op) => op.hyp).join(" "), "Lauren like I'm ay me tienen cansada");

  const missed = score("they have Chicago from Fort Lauderdale", "they have Chicago from Fort");
  const deleted = missed.ops.find((op) => op.kind === "del");
  assert.equal(deleted?.ref, "Lauderdale", "the dropped word keeps its capital");
});

test("keyterm matching handles multi-word terms", () => {
  const terms = ["Fort Lauderdale", "Kingston", "Nicaragua"];
  assert.deepEqual(
    keytermsHit(terms, "they have Chicago from Fort Lauderdale"),
    ["Fort Lauderdale"],
  );
  // Half a multi-word term is a miss, which is exactly how these fail in the field.
  assert.deepEqual(keytermsHit(terms, "they have Chicago from Fort"), []);
  assert.deepEqual(
    keytermsHit(terms, "ticket to Kingston where Michael stays"),
    ["Kingston"],
  );
});

test("keyterm matching is case and punctuation insensitive", () => {
  assert.deepEqual(keytermsHit(["Paige"], "with paige?"), ["Paige"]);
});

test("median", () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
});
