/**
 * A live session: WAV in, transcript and translation out, everything timed.
 *
 * This is the lab harness, not the production path. In production the device holds the
 * socket itself (see device/device_sim.py) so audio never touches iTranslate's servers.
 * Running it here is what lets the dashboard show a real session on a laptop with no
 * handheld in the room.
 */

import { readFile } from "node:fs/promises";

import { StreamingSession, translationText } from "./aai.js";
import { chunk, decodeWav, pace } from "./audio.js";
import { buildKeyterms, buildParams, buildPrompt, type DeviceContext } from "./config.js";
import { keytermsHit, scorePrefix } from "./score.js";
import type { DashboardEvent } from "./types.js";

export interface LiveOptions {
  apiKey: string;
  audioPath: string;
  context: DeviceContext;
  /** Gold transcript to score against. Omitted for microphone input. */
  referencePath?: string;
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

  const prompt = buildPrompt(options.context);
  const keyterms = buildKeyterms(options.context);
  const params = {
    ...buildParams(options.context),
    prompt,
    keyterms_prompt: JSON.stringify(keyterms),
  };

  const started = Date.now();
  const at = (): number => Date.now() - started;

  // Timestamps are kept per turn so latency is measured, not estimated: sttMs is the
  // gap between the audio for a turn ending and its final transcript arriving.
  const turnFinalisedAt = new Map<number, number>();
  const transcripts: string[] = [];
  let audioSentMs = 0;

  const session = await StreamingSession.connect(options.apiKey, params, {
    onBegin: () => {
      emit({
        type: "session.open",
        at: at(),
        mode: "live",
        audio: options.audioPath.split("/").pop() ?? options.audioPath,
        config: { params, prompt, keyterms },
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
        const soFar = transcripts.join(" ");
        const result = scorePrefix(reference, soFar);
        emit({
          type: "turn.accuracy",
          at: now,
          order: turn.turn_order,
          reference,
          wer: result.wer,
          keytermsHit: keytermsHit(keyterms, turn.transcript),
          ops: result.ops,
        });
      }
    },

    onTranslation: (message) => {
      const finalisedAt = turnFinalisedAt.get(message.turn_order);
      emit({
        type: "turn.translation",
        at: at(),
        order: message.turn_order,
        target: "",  // the gateway prompt picks the direction; the model reports the text
        text: translationText(message),
        translateMs: finalisedAt === undefined ? 0 : at() - finalisedAt,
      });
    },

    onTermination: (message) => {
      emit({
        type: "session.close",
        at: at(),
        audioDurationSeconds: message.audio_duration_seconds,
        sessionDurationSeconds: message.session_duration_seconds,
      });
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    clearInterval(meter);
    session.close();
  }
}
