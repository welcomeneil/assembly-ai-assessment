/**
 * The demo server: token broker, session runner, event bus, and it serves the dashboard.
 *
 * In production only the token endpoint here is real. Everything else exists so the
 * demo can run on one laptop.
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer, WebSocket } from "ws";

import { mintToken } from "./aai.js";
import { buildKeyterms, buildParams, buildPrompt, SAMPLE_CONTEXT } from "./config.js";
import { replay } from "./fixture.js";
import { runLiveSession } from "./pipeline.js";
import type { DashboardEvent } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * Read demo/.env if it exists, so the key can live in a gitignored file rather than in
 * shell history. An already-exported variable wins, and no dependency is needed for
 * something this small.
 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const [, key, rawValue] = match;
    if (process.env[key!] === undefined) {
      process.env[key!] = rawValue!.replace(/^["']|["']$/g, "");
    }
  }
}
loadDotEnv(join(root, ".env"));

const PORT = Number(process.env["PORT"] ?? 8787);
const API_KEY = process.env["ASSEMBLYAI_API_KEY"];

const FIXTURE = join(root, "fixtures", "session.json");
const SAMPLE_AUDIO = join(root, "audio", "paris.wav");
const SAMPLE_REFERENCE = join(root, "fixtures", "reference.txt");

const app = express();
app.use(express.json());
app.use(express.static(join(root, "public")));

// ---------------------------------------------------------------------------
// Event bus. The pipeline publishes, the dashboard subscribes. The dashboard holds
// no credentials and never talks to AssemblyAI itself.
// ---------------------------------------------------------------------------

const subscribers = new Set<WebSocket>();
/** Replayed to a dashboard that connects mid-session, so a late joiner sees the run. */
let transcript: DashboardEvent[] = [];

function publish(event: DashboardEvent): void {
  transcript.push(event);
  const payload = JSON.stringify(event);
  for (const socket of subscribers) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

let running: AbortController | undefined;

function startRun(work: (signal: AbortSignal) => Promise<void>): void {
  running?.abort();
  const controller = new AbortController();
  running = controller;
  transcript = [];

  work(controller.signal)
    .catch((error: unknown) => {
      publish({
        type: "error",
        at: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (running === controller) running = undefined;
    });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    apiKeyConfigured: Boolean(API_KEY),
    sampleAudioPresent: existsSync(SAMPLE_AUDIO),
    fixturePresent: existsSync(FIXTURE),
    // What a live run would send, so it can be inspected without starting one.
    config: {
      params: buildParams(SAMPLE_CONTEXT),
      prompt: buildPrompt(SAMPLE_CONTEXT),
      keyterms: buildKeyterms(SAMPLE_CONTEXT),
    },
  });
});

/**
 * The only endpoint that would exist in production.
 *
 * The device calls this immediately before connecting and gets a token good for one
 * short window. No API key ever reaches the handheld.
 */
app.post("/api/token", async (_request, response) => {
  if (!API_KEY) {
    response.status(503).json({ error: "ASSEMBLYAI_API_KEY is not set on the server" });
    return;
  }
  try {
    const token = await mintToken(API_KEY, {
      expiresInSeconds: 60,
      maxSessionDurationSeconds: 600,
    });
    response.json({
      ...token,
      // Connection parameters come from the server, not from firmware, so they can be
      // changed for the whole fleet without a firmware release.
      params: buildParams(SAMPLE_CONTEXT),
      prompt: buildPrompt(SAMPLE_CONTEXT),
      keyterms: buildKeyterms(SAMPLE_CONTEXT),
    });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Replay the bundled sample. No API key, no network. */
app.post("/api/replay", (request, response) => {
  if (!existsSync(FIXTURE)) {
    response.status(404).json({ error: `fixture missing: ${FIXTURE}` });
    return;
  }
  const speed = Number(request.body?.speed ?? 1) || 1;
  startRun((signal) => replay(FIXTURE, publish, { speed, signal }));
  response.json({ started: true, mode: "fixture", speed });
});

/** Run a real session against AssemblyAI. */
app.post("/api/session", (request, response) => {
  if (!API_KEY) {
    response.status(503).json({ error: "ASSEMBLYAI_API_KEY is not set on the server" });
    return;
  }

  const audioPath = request.body?.audio ? resolve(String(request.body.audio)) : SAMPLE_AUDIO;
  if (!existsSync(audioPath)) {
    response.status(404).json({
      error: `audio not found: ${audioPath}`,
      hint: "run demo/audio/fetch_sample.sh, or pass {\"audio\": \"/path/to.wav\"}",
    });
    return;
  }

  startRun((signal) =>
    runLiveSession(
      {
        apiKey: API_KEY,
        audioPath,
        context: SAMPLE_CONTEXT,
        signal,
        ...(existsSync(SAMPLE_REFERENCE) ? { referencePath: SAMPLE_REFERENCE } : {}),
      },
      publish,
    ),
  );
  response.json({ started: true, mode: "live", audio: audioPath });
});

app.post("/api/stop", (_request, response) => {
  running?.abort();
  response.json({ stopped: true });
});

/**
 * Where the device simulator publishes.
 *
 * device_sim.py runs the real handheld path -- its own socket to AssemblyAI, its own
 * TTS -- and posts events here so the same dashboard shows them.
 */
app.post("/api/publish", (request, response) => {
  const event = request.body as DashboardEvent | undefined;
  if (!event?.type) {
    response.status(400).json({ error: "expected a dashboard event" });
    return;
  }
  publish(event);
  response.json({ ok: true });
});

// ---------------------------------------------------------------------------

const server = createServer(app);
const events = new WebSocketServer({ server, path: "/events" });

events.on("connection", (socket) => {
  subscribers.add(socket);
  for (const event of transcript) socket.send(JSON.stringify(event));
  socket.on("close", () => subscribers.delete(socket));
  socket.on("error", () => subscribers.delete(socket));
});

server.listen(PORT, () => {
  process.stdout.write(`\n  iTranslate demo   http://localhost:${PORT}\n\n`);
  process.stdout.write(
    API_KEY
      ? "  ASSEMBLYAI_API_KEY is set -- live sessions available\n"
      : "  no ASSEMBLYAI_API_KEY -- replay only, which is enough to run the demo\n",
  );
  if (!existsSync(SAMPLE_AUDIO)) {
    process.stdout.write("  audio/paris.wav not present -- run audio/fetch_sample.sh for live sessions\n");
  }
  process.stdout.write("\n");
});
