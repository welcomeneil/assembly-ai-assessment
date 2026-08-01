"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Conversation from "@/components/Conversation";
import LanguagePicker from "@/components/LanguagePicker";
import MicButton from "@/components/MicButton";
import TranscriptPanel, { type TranscriptResult } from "@/components/TranscriptPanel";
import { AAIStream, type FinalTurn } from "@/lib/aai-stream";
import { LANGUAGES, lang } from "@/lib/languages";
import { Mic } from "@/lib/mic";
import { speak } from "@/lib/tts";
import type { Status, Turn } from "@/lib/types";
import { framesToWav } from "@/lib/wav";

const SAMPLE_RATE = 16000;
/** How long after our own audio stops before we trust the microphone again. */
const UNMUTE_DELAY_MS = 250;

/** Strip case and punctuation so "¿Dónde está?" and "donde esta" compare equal. */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export default function Page() {
  const [pair, setPair] = useState({ a: "en", b: "es" });
  const [status, setStatus] = useState<Status>("idle");
  const [level, setLevel] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [hasElevenLabs, setHasElevenLabs] = useState(true);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelState, setPanelState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [panelResult, setPanelResult] = useState<TranscriptResult | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const micRef = useRef<Mic | null>(null);
  const streamRef = useRef<AAIStream | null>(null);
  /** Every PCM frame of the session — reused as the recording for Act two. */
  const framesRef = useRef<Int16Array[]>([]);
  /** Turns are translated and spoken strictly one at a time. */
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const lastSpokenRef = useRef("");
  const pairRef = useRef(pair);
  const statusRef = useRef(status);

  pairRef.current = pair;
  statusRef.current = status;

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        setHasElevenLabs(Boolean(h.elevenlabs));
      })
      .catch(() => {});
  }, []);

  const patch = useCallback((id: string, changes: Partial<Turn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...changes } : t)));
  }, []);

  /**
   * Layer three of the echo defence. Muting the worklet during playback and the
   * browser's own cancellation handle nearly everything, but a loud room can
   * still leak a phrase back in. If what we just heard is what we just said,
   * it isn't a new turn.
   */
  const isEcho = useCallback((text: string) => {
    const heard = normalize(text);
    const said = normalize(lastSpokenRef.current);
    if (!said || !heard) return false;
    if (heard === said) return true;
    return heard.length > 12 && (said.includes(heard) || heard.includes(said));
  }, []);

  const processTurn = useCallback(
    async (id: string, final: FinalTurn, sourceKnown: boolean) => {
      const { a, b } = pairRef.current;
      const sideA = { code: a, name: lang(a).name };
      const sideB = { code: b, name: lang(b).name };

      const translateStart = performance.now();
      let translation: string;
      let sourceCode: string;
      let targetCode: string;

      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: final.transcript,
            a: sideA,
            b: sideB,
            sourceCode: sourceKnown ? final.languageCode : null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Translation failed (${res.status}).`);
        ({ translation, sourceCode, targetCode } = data);
      } catch (err) {
        patch(id, {
          error: (err as Error).message,
          totalMs: performance.now() - final.endOfTurnAt,
        });
        return;
      }

      const translateMs = performance.now() - translateStart;
      const sttMs = performance.now() - final.endOfTurnAt - translateMs;

      patch(id, {
        translation,
        sourceLang: sourceCode,
        targetLang: targetCode,
        stages: { stt: sttMs, translate: translateMs },
      });

      // Hebrew transcribes and translates, but Flash v2.5 has no voice for it.
      // Show the text and say so in the details rather than failing quietly.
      if (!lang(targetCode).canSpeak) {
        patch(id, { voice: "none", totalMs: performance.now() - final.endOfTurnAt });
        return;
      }

      lastSpokenRef.current = translation;
      let playbackStart: number | null = null;

      const result = await speak(translation, targetCode, () => {
        playbackStart = performance.now();
        micRef.current?.setMuted(true);
      });

      setTimeout(() => micRef.current?.setMuted(false), UNMUTE_DELAY_MS);

      patch(id, {
        voice: result.voice,
        totalMs: (playbackStart ?? performance.now()) - final.endOfTurnAt,
        stages: {
          stt: sttMs,
          translate: translateMs,
          ...(result.ttfbMs !== null ? { tts: result.ttfbMs } : {}),
        },
      });
    },
    [patch],
  );

  const handleFinal = useCallback(
    (final: FinalTurn) => {
      if (isEcho(final.transcript)) return;

      const { a, b } = pairRef.current;
      // Trust the label when it names one of the two languages we asked for.
      // Anything else — null, or a third language, which this API does emit at
      // low confidence — goes to the gateway to sort out.
      const sourceKnown = final.languageCode === a || final.languageCode === b;
      const source = sourceKnown ? final.languageCode! : a;

      const id = crypto.randomUUID();
      setTurns((prev) => [
        ...prev,
        {
          id,
          sourceLang: source,
          targetLang: source === a ? b : a,
          original: final.transcript,
          translation: null,
          totalMs: null,
          stages: {},
        },
      ]);

      queueRef.current = queueRef.current
        .then(() => processTurn(id, final, sourceKnown))
        .catch(() => {});
    },
    [isEcho, processTurn],
  );

  const stop = useCallback(async () => {
    await micRef.current?.stop();
    micRef.current = null;
    streamRef.current?.close();
    streamRef.current = null;
    setLevel(0);
    setStatus((s) => (s === "error" ? s : "idle"));
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    framesRef.current = [];
    lastSpokenRef.current = "";

    try {
      const stream = new AAIStream([pairRef.current.a, pairRef.current.b], {
        onFinal: handleFinal,
        onError: (message) => {
          setError(message);
          setStatus("error");
          void stop();
        },
      });
      await stream.connect();
      streamRef.current = stream;

      const mic = new Mic(SAMPLE_RATE, {
        onFrame: (pcm) => {
          stream.send(pcm);
          framesRef.current.push(pcm);
        },
        onLevel: setLevel,
      });
      await mic.start();
      micRef.current = mic;

      setStatus("listening");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
      await stop();
    }
  }, [handleFinal, stop]);

  const toggle = useCallback(() => {
    if (status === "listening") void stop();
    else void start();
  }, [status, start, stop]);

  const changePair = useCallback(
    (a: string, b: string) => {
      setPair({ a, b });
      pairRef.current = { a, b };
      // The socket is opened with a fixed language set, so a change means a new
      // session. Restarting keeps the demo moving instead of quietly
      // transcribing against the old pair.
      if (statusRef.current === "listening") void stop().then(start);
    },
    [start, stop],
  );

  /**
   * Wipe the conversation without touching the session. The socket and the
   * microphone stay up, so a demo can be reset between attempts without paying
   * the reconnect. Recorded frames go too — the transcript recap belongs to the
   * conversation on screen, not to everything the tab has ever heard.
   */
  const refresh = useCallback(() => {
    setTurns([]);
    setError(null);
    framesRef.current = [];
    lastSpokenRef.current = "";
    setPanelOpen(false);
    setPanelState("idle");
    setPanelResult(null);
    setPanelError(null);
  }, []);

  const runTranscript = useCallback(async (targets: string[], formal: boolean) => {
    setPanelState("running");
    setPanelError(null);
    setPanelResult(null);
    try {
      const wav = framesToWav(framesRef.current);
      const params = new URLSearchParams({ targets: targets.join(","), formal: String(formal) });
      const res = await fetch(`/api/transcript-translate?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: wav,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status}).`);
      setPanelResult({ utterances: data.utterances, targets: data.targets });
      setPanelState("done");
    } catch (err) {
      setPanelError((err as Error).message);
      setPanelState("error");
    }
  }, []);

  // Release the microphone and close the socket if the tab goes away mid-session.
  useEffect(() => {
    const cleanup = () => {
      streamRef.current?.close();
      void micRef.current?.stop();
    };
    window.addEventListener("pagehide", cleanup);
    return () => {
      window.removeEventListener("pagehide", cleanup);
      cleanup();
    };
  }, []);

  const canRecap = turns.length > 0 && framesRef.current.length > 0;

  return (
    <main className="flex h-dvh flex-col">
      <header className="border-b border-edge px-4 py-5 sm:px-6">
        <LanguagePicker languages={LANGUAGES} a={pair.a} b={pair.b} onChange={changePair} />
        <div className="mt-3 flex items-center justify-center gap-4 text-sm">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-faint transition-colors hover:text-muted"
          >
            {showDetails ? "hide details" : "details"}
          </button>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={refresh}
              className="flex items-center gap-1.5 text-faint transition-colors hover:text-muted"
            >
              <span aria-hidden>↺</span>
              clear conversation
            </button>
          )}
          {!hasElevenLabs && (
            <span className="text-faint">browser voice — no ElevenLabs key</span>
          )}
        </div>
      </header>

      {error && (
        <p role="alert" className="bg-warn/10 px-6 py-3 text-center text-warn">
          {error}
        </p>
      )}

      <Conversation turns={turns} sideA={pair.a} showDetails={showDetails} />

      <footer className="flex flex-col items-center gap-4 border-t border-edge px-4 py-6">
        <MicButton status={status} level={level} onToggle={toggle} />
        {canRecap && status !== "listening" && (
          <button
            type="button"
            onClick={() => {
              setPanelOpen(true);
              setPanelState("idle");
            }}
            className="rounded-full border border-edge px-5 py-2.5 text-muted transition-colors hover:border-faint hover:text-ink"
          >
            Translated transcript
          </button>
        )}
      </footer>

      <TranscriptPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onRun={runTranscript}
        state={panelState}
        result={panelResult}
        error={panelError}
        defaultTargets={[pair.a, pair.b]}
      />
    </main>
  );
}
