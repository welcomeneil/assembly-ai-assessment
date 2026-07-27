/**
 * iTranslate backend.
 *
 * The device has no GPU and, more importantly for this file, no safe place to keep a secret.
 * A consumer handheld can be opened, its firmware dumped and its traffic intercepted. An
 * AssemblyAI API key on the device is a key on every device, and revoking it bricks the fleet.
 *
 * This service sits between the fleet and AssemblyAI. It holds the only copy of the API key
 * and exposes:
 *
 *   POST /v1/session      mint a single-use streaming token, plus the connection parameters
 *   POST /v1/translate    proxy a finished turn through the LLM Gateway
 *   GET  /v1/health       liveness
 *   WS   /v1/events       event bus: the device publishes, the dashboard subscribes
 *   POST /v1/demo/replay  push a scripted conversation onto the bus, for demos without a key
 *   GET  /                the dashboard
 *
 * The device connects straight to AssemblyAI over WebSocket using the token it is given.
 * Audio never passes through this service, so it stays small and cheap regardless of fleet
 * size. Only session setup, translation and the event stream touch it.
 */

import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Request, type Response } from "express";
import { WebSocketServer } from "ws";

import { EventBus, type BusEvent } from "./events.js";
import { startReplay, type ReplayHandle } from "./replay.js";

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const PORT = Number(process.env.PORT ?? 8787);

// dist/server.js -> ../../dashboard
const DASHBOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard");

// Pin a region per deployment. The default host edge-routes for latency and provides no data
// residency guarantee, which will not survive an EU launch review.
const STREAMING_HOST = process.env.AAI_STREAMING_HOST ?? "streaming.assemblyai.com";
const TOKEN_URL = `https://${STREAMING_HOST}/v3/token`;
const LLM_GATEWAY_URL =
  process.env.AAI_LLM_GATEWAY ?? "https://llm-gateway.assemblyai.com/v1/chat/completions";

// Tokens are single-use and valid for 1 to 600 seconds. Keep the window short: the device
// requests one immediately before connecting, so it never needs to store a credential.
const TOKEN_TTL_SECONDS = 60;

// Conversations through a handheld are short. Capping the session below the 3-hour maximum
// bounds the cost of a device that is left switched on in a bag.
const MAX_SESSION_SECONDS = 1800;

const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL ?? "gemini-2.5-flash-lite";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", nl: "Dutch", tr: "Turkish", sv: "Swedish", no: "Norwegian",
  da: "Danish", fi: "Finnish", hi: "Hindi", vi: "Vietnamese", ar: "Arabic",
  he: "Hebrew", ja: "Japanese", zh: "Mandarin",
};

const app = express();
app.use(express.json({ limit: "64kb" }));

// The dashboard is a single static page with no build step. That is deliberate: a demo shown
// to a customer should not depend on a bundler starting correctly.
app.use(express.static(DASHBOARD_DIR));

const bus = new EventBus();

// ---------------------------------------------------------------------------------------
// Context prompt
// ---------------------------------------------------------------------------------------

interface DeviceContext {
  location?: string;      // reverse-geocoded from GPS
  domain?: string;        // travel | medical | business | legal
  knownNames?: string[];  // contacts, hotel, itinerary entries
  recentTurns?: string[]; // rolling conversation history from the device
}

/**
 * Build the `prompt` parameter from device telemetry.
 *
 * This is the highest-return accuracy work available to iTranslate. AssemblyAI benchmarked
 * prompting across 20,000 real calls: a detailed prompt reduced word error rate by 21% and
 * errors on person names by 49%. A handheld already knows its location, the selected domain
 * and what was said thirty seconds ago, so the prompt can be assembled server-side on every
 * session with no user involvement.
 *
 * Hard limit is 1750 characters.
 */
function buildPrompt(ctx: DeviceContext, pair: string[]): string {
  const langs = pair.map((c) => LANGUAGE_NAMES[c] ?? c).join(" and ");
  const parts: string[] = [
    `Face-to-face conversation between two people speaking ${langs}, ` +
      `translated through a handheld device.`,
  ];
  if (ctx.domain) parts.push(`Topic: ${ctx.domain}.`);
  if (ctx.location) parts.push(`Location: ${ctx.location}.`);
  if (ctx.knownNames?.length) {
    parts.push(`Names likely to be mentioned: ${ctx.knownNames.slice(0, 30).join(", ")}.`);
  }
  if (ctx.recentTurns?.length) {
    parts.push(`Recently said: ${ctx.recentTurns.slice(-4).join(" ")}`);
  }
  return parts.join(" ").slice(0, 1750);
}

// ---------------------------------------------------------------------------------------
// POST /v1/session
// ---------------------------------------------------------------------------------------

app.post("/v1/session", async (req: Request, res: Response) => {
  if (!API_KEY) return res.status(503).json({ error: "ASSEMBLYAI_API_KEY is not set" });

  const deviceId = req.header("x-device-id");
  if (!deviceId) return res.status(401).json({ error: "missing x-device-id" });

  // Production: verify a per-device credential here, check the device is not deactivated,
  // and apply a per-device rate limit. One compromised handheld must not be able to consume
  // the fleet's session budget.

  const pair: string[] = Array.isArray(req.body?.pair) ? req.body.pair : ["en", "es"];
  if (pair.length !== 2) return res.status(400).json({ error: "pair must be two codes" });

  const ctx: DeviceContext = req.body?.context ?? {};
  const keyterms: string[] = req.body?.keyterms ?? [];

  try {
    const url = new URL(TOKEN_URL);
    url.searchParams.set("expires_in_seconds", String(TOKEN_TTL_SECONDS));
    url.searchParams.set("max_session_duration_seconds", String(MAX_SESSION_SECONDS));

    const tokenRes = await fetch(url, { headers: { Authorization: API_KEY! } });
    if (!tokenRes.ok) {
      console.error(`token mint failed: ${tokenRes.status} ${await tokenRes.text()}`);
      return res.status(502).json({ error: "could not mint streaming token" });
    }
    const { token } = (await tokenRes.json()) as { token: string };

    // The device receives fully-formed parameters rather than assembling them itself. This
    // is deliberate. Firmware updates roll out slowly across a consumer fleet, so any tuning
    // baked into the device is frozen for months. Returning the parameters from the server
    // means model selection, noise settings and turn-detection thresholds can be changed for
    // every device at once.
    const params: Record<string, string> = {
      speech_model: "universal-3-5-pro",
      encoding: "pcm_s16le",
      sample_rate: "16000",

      // Bias toward the two languages in play while keeping native mid-sentence switching.
      // This is what allows the device to drop its language selector.
      language_codes: pair.join(","),
      language_detection: "true",

      // The device is a close-talking handheld used in noisy public spaces.
      voice_focus: "near-field",
      voice_focus_threshold: "0.7",

      // Conversational turn-taking rewards responsiveness over decode time.
      mode: "min_latency",
    };

    // prompt and keyterms_prompt should not be sent together. AssemblyAI's guidance is that
    // combining them causes overprompting and unpredictable output. The contextual prompt
    // benchmarks better, so it is the default; an explicit vocabulary list overrides it.
    if (keyterms.length > 0) {
      params.keyterms_prompt = keyterms
        .filter((t) => t.length <= 50)
        .slice(0, 100)
        .join(",");
    } else {
      params.prompt = buildPrompt(ctx, pair);
    }

    res.json({
      token,
      expiresInSeconds: TOKEN_TTL_SECONDS,
      // Device connects to this URL directly. Audio does not transit this service.
      websocketUrl: `wss://${STREAMING_HOST}/v3/ws?${new URLSearchParams({
        ...params,
        token,
      })}`,
      params,
    });
  } catch (err) {
    console.error("session error", err);
    res.status(500).json({ error: "internal error" });
  }
});

// ---------------------------------------------------------------------------------------
// POST /v1/translate
// ---------------------------------------------------------------------------------------

app.post("/v1/translate", async (req: Request, res: Response) => {
  if (!API_KEY) return res.status(503).json({ error: "ASSEMBLYAI_API_KEY is not set" });

  const deviceId = req.header("x-device-id");
  if (!deviceId) return res.status(401).json({ error: "missing x-device-id" });

  const { text, source, target, context } = req.body ?? {};
  if (!text || !source || !target) {
    return res.status(400).json({ error: "text, source and target are required" });
  }

  const srcName = LANGUAGE_NAMES[source] ?? source;
  const tgtName = LANGUAGE_NAMES[target] ?? target;

  // Give the translator the same situational context the recognizer received. Short
  // conversational fragments are ambiguous without it: "Check, please" resolves differently
  // in a restaurant than in a bank.
  const system =
    `You translate speech from ${srcName} to ${tgtName} for a handheld translation device. ` +
    `Output only the translation, with no preamble, notes or quotation marks. Preserve the ` +
    `speaker's tone and register. Keep proper nouns unchanged. If the input is already ` +
    `${tgtName}, return it unchanged.` +
    (context ? `\nSituation: ${buildPrompt(context, [source, target]).slice(0, 600)}` : "");

  try {
    const started = Date.now();
    const llmRes = await fetch(LLM_GATEWAY_URL, {
      method: "POST",
      headers: { Authorization: API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TRANSLATION_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
        max_tokens: 400,
        temperature: 0.2, // translation should be repeatable, not creative
      }),
    });

    if (!llmRes.ok) {
      console.error(`gateway failed: ${llmRes.status} ${await llmRes.text()}`);
      return res.status(502).json({ error: "translation failed" });
    }

    const data = (await llmRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    res.json({
      translation: data.choices[0].message.content.trim(),
      model: TRANSLATION_MODEL,
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    console.error("translate error", err);
    res.status(500).json({ error: "internal error" });
  }
});

// ---------------------------------------------------------------------------------------
// POST /v1/demo/replay
// ---------------------------------------------------------------------------------------

let replay: ReplayHandle | null = null;

/**
 * Push a scripted conversation onto the event bus.
 *
 * This is what makes the dashboard demonstrable with no API key, no microphone and no
 * network. The events it produces are flagged `simulated`, and the dashboard shows a banner
 * saying so. It is a presentation aid, not evidence.
 */
app.post("/v1/demo/replay", (_req: Request, res: Response) => {
  replay?.stop();
  replay = startReplay(bus, STREAMING_HOST);
  res.json({ started: true, simulated: true });
});

app.post("/v1/demo/stop", (_req: Request, res: Response) => {
  replay?.stop();
  replay = null;
  bus.reset();
  res.json({ stopped: true });
});

app.get("/v1/health", (_req, res) =>
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(API_KEY),
    streamingHost: STREAMING_HOST,
    translationModel: TRANSLATION_MODEL,
    dashboardSubscribers: bus.subscriberCount,
  }),
);

// ---------------------------------------------------------------------------------------
// WS /v1/events
// ---------------------------------------------------------------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/v1/events" });

wss.on("connection", (socket) => {
  bus.add(socket);

  socket.on("message", (raw) => {
    // Anything a client sends is a published event. In production this endpoint needs the
    // same per-device authentication as /v1/session; it is open here so the demo is one
    // command to run.
    let event: BusEvent;
    try {
      event = JSON.parse(raw.toString()) as BusEvent;
    } catch {
      return;
    }
    if (event && typeof event.type === "string") bus.publish(event, socket);
  });

  socket.on("close", () => bus.remove(socket));
  socket.on("error", () => bus.remove(socket));
});

if (!API_KEY) {
  // Not fatal. The dashboard and its scripted replay run without a key, which is how the
  // demo gets shown when there is no key to hand. Live endpoints return 503 until one is set.
  console.warn("ASSEMBLYAI_API_KEY is not set. Dashboard replay works; live sessions do not.");
}

server.listen(PORT, () => {
  console.log(`iTranslate backend listening on :${PORT}`);
  console.log(`  dashboard          http://localhost:${PORT}`);
  console.log(`  event bus          ws://localhost:${PORT}/v1/events`);
  console.log(`  streaming host     ${STREAMING_HOST}`);
  console.log(`  translation model  ${TRANSLATION_MODEL}`);
  console.log(`  api key            ${API_KEY ? "configured" : "NOT SET (replay only)"}`);
});
