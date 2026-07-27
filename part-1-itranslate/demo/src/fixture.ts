/**
 * Replay of the bundled sample, for running the demo with no API key.
 *
 * This emits the same events a live session emits, at the real timings from the corpus,
 * so the dashboard has one code path. What is real and what is constructed is carried
 * in the fixture's own `meta` block and shown on screen -- nobody should be able to
 * mistake this for a measurement.
 */

import { readFile } from "node:fs/promises";

import { buildKeyterms, buildParams, buildPrompt, SAMPLE_CONTEXT } from "./config.js";
import { keytermsExpected, keytermsHit, score } from "./score.js";
import { sleep } from "./audio.js";
import type { DashboardEvent } from "./types.js";

interface FixtureTurn {
  order: number;
  speaker: string;
  audioStartMs: number;
  audioEndMs: number;
  reference: string;
  transcript: string;
  languageCode: string;
  midTurnSwitch: boolean;
  unintelligible: boolean;
  translation: string | null;
  target: string;
}

interface Fixture {
  meta: Record<string, unknown>;
  session: { prompt: string; keyterms: string[] };
  turns: FixtureTurn[];
}

/**
 * Deterministic pseudo-random numbers.
 *
 * The simulated latencies have to look like measurements, which means they cannot all
 * be identical -- but they also must not change between runs, or two people watching
 * the same demo would see different numbers and neither could check the other.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** How long the device is shown holding the connection open after the talking stops. */
const IDLE_TAIL_MS = 12_000;

export interface ReplayOptions {
  /** Wall-clock speed. 1 is real time, which is what a customer should see. */
  speed?: number;
  signal?: AbortSignal;
}

export async function replay(
  fixturePath: string,
  emit: (event: DashboardEvent) => void,
  options: ReplayOptions = {},
): Promise<void> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  const speed = options.speed ?? 1;
  const random = seeded(20260727);

  const params = buildParams(SAMPLE_CONTEXT);
  const keyterms = fixture.session.keyterms.length > 0
    ? fixture.session.keyterms
    : buildKeyterms(SAMPLE_CONTEXT);

  const started = Date.now();
  const at = (): number => Date.now() - started;
  const aborted = (): boolean => options.signal?.aborted === true;

  emit({
    type: "session.open",
    at: at(),
    mode: "fixture",
    audio: String(fixture.meta["audioFile"] ?? "herring1.wav"),
    config: {
      params,
      prompt: fixture.session.prompt || buildPrompt(SAMPLE_CONTEXT),
      keyterms,
    },
    provenance: fixture.meta,
  });

  // A meter tick every second, so the session-cost panel moves the way it would live.
  //
  // Both figures are reported in the audio clock, not the wall clock: `speed` is a
  // presentation control for showing the demo quickly, and it must not make a session
  // look cheaper than it is. At speed 1 the two clocks are the same thing.
  const meter = setInterval(() => {
    const connectionMs = at() * speed;
    emit({
      type: "meter",
      at: at(),
      connectionMs,
      audioMs: Math.min(connectionMs, lastEndMs(fixture)),
    });
  }, 1000);

  try {
    for (const turn of fixture.turns) {
      if (aborted()) break;

      // Latencies are constructed. Ranges are inside AssemblyAI's published figures for
      // max_accuracy streaming plus an LLM Gateway round trip, but they are not measured.
      const sttMs = Math.round(320 + random() * 180);
      const translateMs = Math.round(240 + random() * 160);
      const ttsMs = Math.round(70 + random() * 60);

      // Partials arrive while the speaker is still talking. Reveal the transcript a few
      // words at a time across the duration of the turn.
      const words = turn.transcript.split(" ");
      const speechMs = Math.max(turn.audioEndMs - turn.audioStartMs, 200);
      const steps = Math.min(Math.max(Math.ceil(words.length / 3), 1), 6);

      await waitUntil(started, turn.audioStartMs / speed, options.signal);
      for (let step = 1; step <= steps && !aborted(); step++) {
        const upto = Math.ceil((words.length * step) / steps);
        emit({
          type: "turn.partial",
          at: at(),
          order: turn.order,
          transcript: words.slice(0, upto).join(" "),
        });
        if (step < steps) await sleep(speechMs / steps / speed);
      }

      // The final turn lands after the endpointer has decided the turn is over.
      await waitUntil(started, (turn.audioEndMs + sttMs) / speed, options.signal);
      if (aborted()) break;

      emit({
        type: "turn.final",
        at: at(),
        order: turn.order,
        transcript: turn.transcript,
        words: turn.transcript.split(" ").map((text) => ({
          text,
          // Confidence is constructed too. Mid-turn switches sit lower, which is what
          // the model actually does at a language boundary.
          confidence: Number((turn.midTurnSwitch ? 0.82 + random() * 0.15 : 0.93 + random() * 0.07).toFixed(2)),
        })),
        languageCode: turn.languageCode,
        languageConfidence: Number((turn.midTurnSwitch ? 0.88 + random() * 0.08 : 0.95 + random() * 0.05).toFixed(2)),
        midTurnSwitch: turn.midTurnSwitch,
        audioStartMs: turn.audioStartMs,
        audioEndMs: turn.audioEndMs,
        sttMs,
      });

      // Accuracy against the corpus's human transcript. Turns the corpus marks
      // unintelligible are shown but not scored -- counting them as errors would be
      // scoring the recogniser against something no listener could make out either.
      emit({
        type: "turn.accuracy",
        at: at(),
        order: turn.order,
        reference: turn.reference,
        wer: turn.unintelligible ? null : score(turn.reference, turn.transcript).wer,
        keytermsHit: keytermsHit(keytermsExpected(keyterms, turn.reference), turn.transcript),
        ops: score(turn.reference, turn.transcript).ops,
      });

      if (turn.translation) {
        await sleep(translateMs / speed);
        if (aborted()) break;
        emit({
          type: "turn.translation",
          at: at(),
          order: turn.order,
          target: turn.target,
          text: turn.translation,
          translateMs,
        });

        await sleep(ttsMs / speed);
        if (aborted()) break;
        emit({ type: "turn.speech", at: at(), order: turn.order, ttsMs });
      }
    }
    // The conversation is over, but the device has not hung up.
    //
    // This tail is the point of the session-cost panel, and it is not a contrivance:
    // it is what a naive implementation does. The user stops talking, puts the handheld
    // in a pocket, and the socket stays open. Streaming bills on connection time, so
    // every second here is paid for at the same rate as speech. Watch the meter open a
    // gap once the talking stops.
    if (!aborted()) await sleep(IDLE_TAIL_MS / speed);
  } finally {
    clearInterval(meter);
  }

  emit({
    type: "session.close",
    at: at(),
    audioDurationSeconds: lastEndMs(fixture) / 1000,
    sessionDurationSeconds: (at() * speed) / 1000,
  });
}

function lastEndMs(fixture: Fixture): number {
  return fixture.turns.reduce((max, turn) => Math.max(max, turn.audioEndMs), 0);
}

async function waitUntil(
  started: number,
  offsetMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const wait = started + offsetMs - Date.now();
  if (wait > 0 && signal?.aborted !== true) await sleep(wait);
}
