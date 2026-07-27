/**
 * A live session: WAV in, scored transcript out, everything timed.
 *
 * This is the lab harness, not the production path. In production the device holds the
 * socket itself (see device/device_sim.py) so audio never touches iTranslate's servers.
 * Running it here is what lets the dashboard show a real session on a laptop with no
 * handheld in the room.
 */

import { readFile } from "node:fs/promises";

import { StreamingSession } from "./aai.js";
import { chunk, decodeWav, pace } from "./audio.js";
import { buildKeyterms, buildParams, buildPrompt, type DeviceContext } from "./config.js";
import { keytermsHit, score, scorePrefix } from "./score.js";
import type { DashboardEvent } from "./types.js";

export interface LiveOptions {
  apiKey: string;
  audioPath: string;
  context: DeviceContext;
  /** Gold transcript to score against. Omitted for microphone input. */
  referencePath?: string;
  /** Send the situational `prompt`. Off by default -- see config.ts for why. */
  withPrompt?: boolean;
  signal?: AbortSignal;
}

export async function runLiveSession(
  options: LiveOptions,
  emit: (event: DashboardEvent) => void,
): Promise<void> {
  const pcm = decodeWav(await readFile(options.audioPath));
  const chunks = chunk(pcm);

  const reference = options.referencePath
    ? (await readFile(options.referencePath, "utf8")).split("\n").join(" ").trim()
    : undefined;

  const keyterms = buildKeyterms(options.context);
  // `prompt` is off by default because it measured worse on this audio; `withPrompt`
  // is here so the comparison can be re-run on the customer's own recordings.
  const prompt = buildPrompt(options.context);
  const params = {
    ...buildParams(options.context),
    ...(options.withPrompt === true ? { prompt } : {}),
  };

  const started = Date.now();
  const at = (): number => Date.now() - started;

  // Resolved when the server's Termination message arrives. Waiting on the event rather
  // than on a fixed sleep matters: Termination carries the billed session duration, and
  // dropping it loses both the closing numbers and the end-of-session diff.
  let terminated: () => void = () => {};
  const termination = new Promise<void>((resolve) => { terminated = resolve; });

  // Timestamps are kept per turn so latency is measured, not estimated: sttMs is the
  // gap between the audio for a turn ending and its final transcript arriving.
  const turnFinalisedAt = new Map<number, number>();
  const transcripts: string[] = [];
  // Hypothesis tokens contributed by turns already reported. Ops are in hypothesis
  // order, so this is what lets a turn's own ops be sliced out of the global alignment.
  let hypTokensReported = 0;
  let audioSentMs = 0;

  const session = await StreamingSession.connect(options.apiKey, params, {
    onBegin: () => {
      emit({
        type: "session.open",
        at: at(),
        mode: "live",
        audio: options.audioPath.split("/").pop() ?? options.audioPath,
        config: {
          params,
          prompt: options.withPrompt === true ? prompt : "",
          keyterms,
        },
      });
    },

    onPartial: (turn) => {
      emit({
        type: "turn.partial",
        at: at(),
        order: turn.turn_order,
        transcript: turn.transcript,
      });
    },

    onTurn: (turn) => {
      const now = at();
      turnFinalisedAt.set(turn.turn_order, now);

      const lastWord = turn.words.at(-1);
      const audioEndMs = lastWord?.end ?? now;
      const audioStartMs = turn.words[0]?.start ?? audioEndMs;

      emit({
        type: "turn.final",
        at: now,
        order: turn.turn_order,
        transcript: turn.transcript,
        words: turn.words.map((word) => ({ text: word.text, confidence: word.confidence })),
        languageCode: turn.language_code ?? "",
        languageConfidence: turn.language_confidence ?? 0,
        // The API returns one language per turn, so a switch inside a turn is not
        // reported directly. Low language confidence on a turn the model still
        // transcribed cleanly is the signal that it crossed a boundary.
        midTurnSwitch: (turn.language_confidence ?? 1) < 0.9,
        audioStartMs,
        audioEndMs,
        // Audio is paced at real time, so wall-clock minus audio position is the
        // recogniser's actual lag rather than a disk-read artefact.
        sttMs: Math.max(0, now - audioEndMs),
      });

      if (reference !== undefined) {
        transcripts.push(turn.transcript);
        const result = scorePrefix(reference, transcripts.join(" "));
        emit({
          type: "turn.accuracy",
          at: now,
          order: turn.turn_order,
          keytermsHit: keytermsHit(keyterms, turn.transcript),
          session: {
            wer: result.wer,
            errors: result.substitutions + result.deletions + result.insertions,
            words: result.referenceWords,
          },
        });
      }
    },

    onTermination: (message) => {
      // One diff, over the whole session, aligned once.
      if (reference !== undefined && transcripts.length > 0) {
        const result = score(reference, transcripts.join(" "));
        emit({
          type: "session.accuracy",
          at: at(),
          reference,
          wer: result.wer,
          ops: result.ops,
        });
      }
      emit({
        type: "session.close",
        at: at(),
        audioDurationSeconds: message.audio_duration_seconds,
        sessionDurationSeconds: message.session_duration_seconds,
      });
      terminated();
    },

    onError: (error) => {
      emit({ type: "error", at: at(), message: error.message });
    },
  });

  const meter = setInterval(() => {
    emit({ type: "meter", at: at(), connectionMs: at(), audioMs: audioSentMs });
  }, 1000);

  try {
    for await (const { chunk: buffer, elapsedMs } of pace(chunks)) {
      if (options.signal?.aborted) break;
      session.send(buffer);
      audioSentMs = elapsedMs;
    }
    // Let the last turn finalise, then close. Closing promptly matters: streaming bills
    // on connection time, so a session left open after the talking stops is paid for.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    session.terminate();
    // Wait for the server to confirm, but never hang the demo on it.
    await Promise.race([
      termination,
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  } finally {
    clearInterval(meter);
    session.close();
  }
}
