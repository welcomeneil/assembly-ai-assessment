/**
 * Replay a recorded session, for running the demo with no API key.
 *
 * The recording in fixtures/session.json is a real AssemblyAI session captured by
 * src/capture.ts -- not a construction. Replaying it at the timings it was recorded at
 * means the offline demo shows exactly what the live one showed, and the numbers on
 * screen are measurements either way.
 *
 * The only thing this adds is the idle tail: the recorded session ends when the audio
 * does, and the demo holds the connection open past that to make the billing point.
 */

import { readFile } from "node:fs/promises";

import { sleep } from "./audio.js";
import type { DashboardEvent } from "./types.js";

/** How long the device is shown holding the connection open after the talking stops. */
const IDLE_TAIL_MS = 12_000;

interface Recording {
  recordedAt: string;
  note: string;
  events: DashboardEvent[];
}

export interface ReplayOptions {
  /** Wall-clock speed. 1 is real time, which is what a customer should see. */
  speed?: number;
  signal?: AbortSignal;
}

export async function replay(
  recordingPath: string,
  emit: (event: DashboardEvent) => void,
  options: ReplayOptions = {},
): Promise<void> {
  const recording = JSON.parse(await readFile(recordingPath, "utf8")) as Recording;
  const speed = options.speed ?? 1;
  const started = Date.now();
  const aborted = (): boolean => options.signal?.aborted === true;

  let lastAudioMs = 0;
  let closing: DashboardEvent | undefined;

  for (const event of recording.events) {
    if (aborted()) return;

    // Each event carries the millisecond offset it actually arrived at.
    const due = started + event.at / speed;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);

    if (event.type === "session.close") {
      closing = event;
      break; // held until after the idle tail below
    }

    if (event.type === "meter") lastAudioMs = event.audioMs;

    // The recording is a live session; the replay says so rather than claiming to be one.
    emit(event.type === "session.open"
      ? { ...event, mode: "fixture", provenance: { recordedAt: recording.recordedAt, note: recording.note } }
      : event);
  }

  // The conversation is over, but the device has not hung up.
  //
  // This tail is the one thing the replay adds, and it is not a contrivance: it is what
  // a naive implementation does. The user stops talking, pockets the handheld, and the
  // socket stays open. Streaming bills on connection time, so every second here costs
  // the same as speech. Watch the meter open a gap once the talking stops.
  const tailStarted = Date.now();
  while (!aborted() && Date.now() - tailStarted < IDLE_TAIL_MS / speed) {
    await sleep(Math.min(1000 / speed, 1000));
    const connectionMs = (Date.now() - started) * speed;
    emit({ type: "meter", at: Date.now() - started, connectionMs, audioMs: lastAudioMs });
  }

  const connectionMs = (Date.now() - started) * speed;
  emit(closing !== undefined && closing.type === "session.close"
    ? { ...closing, at: Date.now() - started, sessionDurationSeconds: connectionMs / 1000 }
    : {
        type: "session.close",
        at: Date.now() - started,
        audioDurationSeconds: lastAudioMs / 1000,
        sessionDurationSeconds: connectionMs / 1000,
      });
}
