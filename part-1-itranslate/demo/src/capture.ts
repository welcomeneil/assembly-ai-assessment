/**
 * Record a real session to disk, so the no-key demo replays a measurement.
 *
 * This is the thing that makes the offline mode honest. An earlier version of this demo
 * shipped a fixture I wrote by hand, with plausible-looking errors and latencies -- it
 * had to carry a banner saying the numbers were constructed. This records an actual
 * AssemblyAI session instead: every transcript, confidence, language label and timing in
 * fixtures/session.json came off the wire.
 *
 *   npm run capture
 *
 * Re-run it whenever the configuration changes, so the offline demo cannot drift away
 * from what the live one does.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SAMPLE_CONTEXT } from "./config.js";
import { runLiveSession } from "./pipeline.js";
import type { DashboardEvent } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<number> {
  const apiKey = process.env["ASSEMBLYAI_API_KEY"];
  if (!apiKey) {
    process.stderr.write("ASSEMBLYAI_API_KEY is not set (put it in demo/.env)\n");
    return 1;
  }

  const audioPath = join(root, "audio", "paris.wav");
  const referencePath = join(root, "fixtures", "reference.txt");
  const events: DashboardEvent[] = [];

  process.stdout.write("recording a live session...\n\n");

  await runLiveSession(
    { apiKey, audioPath, referencePath, context: SAMPLE_CONTEXT },
    (event) => {
      events.push(event);
      if (event.type === "turn.final") {
        process.stdout.write(
          `  [${event.languageCode} ${event.languageConfidence.toFixed(2)}] ` +
          `${String(event.sttMs).padStart(4)}ms  ${event.transcript}\n`,
        );
      }
      if (event.type === "error") process.stderr.write(`  error: ${event.message}\n`);
    },
  );

  const target = join(root, "fixtures", "session.json");
  await writeFile(target, JSON.stringify({
    recordedAt: new Date().toISOString(),
    note: "A real AssemblyAI session, recorded by src/capture.ts. Every transcript, " +
      "confidence, language label and timing here came off the wire. Regenerate with " +
      "`npm run capture`.",
    events,
  }, null, 2) + "\n", "utf8");

  // The last turn carries the authoritative session total.
  const last = events.filter((event) => event.type === "turn.accuracy").at(-1);
  const session = last?.type === "turn.accuracy" ? last.session : undefined;
  const turns = events.filter((event) => event.type === "turn.final").length;
  process.stdout.write(
    `\n${turns} turns, ${events.length} events` +
    (session ? `, session WER ${(session.wer * 100).toFixed(1)}% (${session.errors}/${session.words})` : "") +
    `\nwrote ${target}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
