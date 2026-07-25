#!/usr/bin/env python3
"""
iTranslate device simulator.

Simulates the handheld unit: microphone in, translated speech out, no language button.

The point of this demo is the thing iTranslate cannot do today. Their current design almost
certainly requires the user to declare which language they are about to speak, because a
language-pinned STT session has to be told. Universal-3.5 Pro detects and switches natively
inside a single session, so the device can drop the language selector entirely. Two people
just talk into it.

Pipeline per turn:

    microphone -> AssemblyAI streaming STT -> detect language -> LLM Gateway translation -> TTS

Everything except audio capture and playback runs in the cloud, which matches the hardware
constraint: no GPU, no on-device inference.

Run:
    export ASSEMBLYAI_API_KEY=...
    pip install -r requirements.txt
    python3 translator.py --pair en,es

    # no microphone available:
    python3 translator.py --pair en,es --file ../../../part-2-spanglish/code/python/sample_bilingual.wav
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import wave
from dataclasses import dataclass, field
from urllib.parse import urlencode

import requests
import websocket  # websocket-client

# ---------------------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------------------

API_KEY = os.environ.get("ASSEMBLYAI_API_KEY")

# Pin a region. The default host edge-routes for latency and gives no data residency
# guarantee, which matters once the device is sold into the EU.
STT_HOST = os.environ.get("AAI_STREAMING_HOST", "streaming.assemblyai.com")
LLM_URL = os.environ.get(
    "AAI_LLM_GATEWAY", "https://llm-gateway.assemblyai.com/v1/chat/completions"
)

SAMPLE_RATE = 16_000
CHUNK_MS = 50                                       # inside the required 50-1000 ms window
CHUNK_BYTES = SAMPLE_RATE * 2 * CHUNK_MS // 1000    # 1600 bytes

# gemini-2.5-flash-lite is the model AssemblyAI's own translation guide uses. The Gateway is
# OpenAI-compatible and passes provider pricing through with no markup, so swapping models is
# a one-line change if translation quality needs to go up.
TRANSLATION_MODEL = os.environ.get("TRANSLATION_MODEL", "gemini-2.5-flash-lite")

LANGUAGE_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "nl": "Dutch", "tr": "Turkish",
    "sv": "Swedish", "no": "Norwegian", "da": "Danish", "fi": "Finnish",
    "hi": "Hindi", "vi": "Vietnamese", "ar": "Arabic", "he": "Hebrew",
    "ja": "Japanese", "zh": "Mandarin",
}

# macOS voices, used only so the demo makes sound out of the box. iTranslate already owns
# this stage of the pipeline; this is a placeholder for their TTS engine.
TTS_VOICES = {"en": "Samantha", "es": "Paulina", "fr": "Thomas", "de": "Anna",
              "it": "Alice", "pt": "Luciana", "ja": "Kyoko", "zh": "Tingting"}


# ---------------------------------------------------------------------------------------
# Device context
# ---------------------------------------------------------------------------------------

@dataclass
class DeviceContext:
    """Context the handheld knows and the cloud does not.

    This is the highest-leverage accuracy input available to iTranslate and it costs nothing
    to send. AssemblyAI's published benchmarks on 20,000 real calls show a detailed prompt
    reducing word error rate by 21% and errors on person names by 49%. A translation device
    knows where it is, what it is being used for, and what has already been said, so it can
    build that prompt automatically on every session. Nobody has to type anything.
    """
    scenario: str = "Two people having a face-to-face conversation through a handheld translator."
    location: str | None = None          # from GPS: "Mercado de San Miguel, Madrid"
    domain: str | None = None            # user-selected: travel, medical, business
    known_names: list[str] = field(default_factory=list)   # contacts, hotel, itinerary
    recent_turns: list[str] = field(default_factory=list)  # rolling conversation history

    def build_prompt(self, max_chars: int = 1750) -> str:
        """Assemble the `prompt` parameter. Max 1750 characters per the API."""
        parts = [self.scenario]
        if self.domain:
            parts.append(f"Topic: {self.domain}.")
        if self.location:
            parts.append(f"Location: {self.location}.")
        if self.known_names:
            parts.append("Names likely to be mentioned: " + ", ".join(self.known_names) + ".")
        if self.recent_turns:
            parts.append("Recently said: " + " ".join(self.recent_turns[-4:]))
        return " ".join(parts)[:max_chars]

    def remember(self, text: str) -> None:
        self.recent_turns.append(text)
        del self.recent_turns[:-8]   # keep the window small; stale context hurts


# ---------------------------------------------------------------------------------------
# Latency accounting
# ---------------------------------------------------------------------------------------

@dataclass
class TurnTiming:
    """Per-turn latency breakdown.

    A conversation device lives or dies on the gap between someone finishing a sentence and
    the device speaking. Reporting the breakdown rather than a single number is what lets
    iTranslate decide where to spend effort, and it is what an AE can put in front of a
    customer.
    """
    stt_final_ms: float = 0.0     # end of speech to final transcript
    translate_ms: float = 0.0     # LLM Gateway round trip
    tts_ms: float = 0.0           # first audio out

    @property
    def total_ms(self) -> float:
        return self.stt_final_ms + self.translate_ms + self.tts_ms

    def render(self) -> str:
        return (f"stt {self.stt_final_ms:>5.0f}ms | translate {self.translate_ms:>5.0f}ms | "
                f"tts {self.tts_ms:>5.0f}ms | total {self.total_ms:>5.0f}ms")


# ---------------------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------------------

def translate(text: str, source: str, target: str, ctx: DeviceContext) -> str:
    """Translate one finished turn through the AssemblyAI LLM Gateway.

    Using the Gateway rather than a separate translation vendor keeps iTranslate on one
    contract, one key, one DPA and one region setting. Pricing passes through at provider
    cost, so it is not a markup play.
    """
    src_name = LANGUAGE_NAMES.get(source, source)
    tgt_name = LANGUAGE_NAMES.get(target, target)

    # Give the translator the same situational context the recognizer got. Translation
    # quality on short conversational fragments depends heavily on it: "Check, please" in a
    # restaurant is not the same sentence as "Check, please" in a bank.
    system = (
        f"You translate speech from {src_name} to {tgt_name} for a handheld translation "
        f"device. Output only the translation, with no preamble, notes or quotation marks. "
        f"Preserve the speaker's tone and register. Keep proper nouns unchanged. "
        f"If the input is already {tgt_name}, return it unchanged.\n"
        f"Situation: {ctx.build_prompt(600)}"
    )

    resp = requests.post(
        LLM_URL,
        headers={"Authorization": API_KEY, "Content-Type": "application/json"},
        json={
            "model": TRANSLATION_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": text},
            ],
            "max_tokens": 400,
            "temperature": 0.2,   # translation should be boring and repeatable
        },
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


def speak(text: str, lang: str) -> float:
    """Placeholder TTS. Returns milliseconds to first audio.

    iTranslate already has a TTS model in their product. This exists so the demo is audible;
    it is the seam where their engine drops in.
    """
    t0 = time.monotonic()
    if not shutil.which("say"):
        return 0.0
    voice = TTS_VOICES.get(lang)
    cmd = ["say"] + (["-v", voice] if voice else []) + [text]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return (time.monotonic() - t0) * 1000


# ---------------------------------------------------------------------------------------
# Device
# ---------------------------------------------------------------------------------------

class TranslationDevice:
    def __init__(self, pair: list[str], ctx: DeviceContext, keyterms: list[str] | None = None):
        if len(pair) != 2:
            sys.exit("--pair needs exactly two language codes, for example: --pair en,es")
        self.pair = pair
        self.ctx = ctx
        self.keyterms = keyterms or []
        self.ws: websocket.WebSocketApp | None = None
        self.audio_q: queue.Queue[bytes | None] = queue.Queue(maxsize=200)
        self.stop = threading.Event()
        self.turns = 0
        self.timings: list[TurnTiming] = []
        self._speech_ended_at: float | None = None

    # -- connection ----------------------------------------------------------------------

    def url(self) -> str:
        p = {
            # Universal-3.5 Pro is the only model that code-switches natively mid-sentence
            # across 18 languages. That capability is what removes the language button.
            "speech_model": "universal-3-5-pro",
            "encoding": "pcm_s16le",
            "sample_rate": SAMPLE_RATE,

            # Bias toward the two languages in play without disabling switching between them.
            "language_codes": ",".join(self.pair),
            # Tells us which language each turn was, so we know which way to translate.
            "language_detection": "true",

            # The device is held close to the mouth and used in airports, markets and streets.
            # near-field isolates the primary speaker before audio reaches the model.
            "voice_focus": "near-field",
            "voice_focus_threshold": "0.7",

            # A conversation device should answer fast. Accuracy is recovered through context
            # rather than through extra decode time.
            "mode": "min_latency",
        }

        # prompt and keyterms_prompt should not be combined. AssemblyAI's guidance is that
        # sending both causes overprompting and unpredictable results. Prefer the contextual
        # prompt, which benchmarks better, and fall back to keyterms only when the caller
        # supplies an explicit vocabulary list.
        if self.keyterms:
            p["keyterms_prompt"] = ",".join(self.keyterms[:100])
        else:
            p["prompt"] = self.ctx.build_prompt()

        return f"wss://{STT_HOST}/v3/ws?{urlencode(p)}"

    def run_mic(self) -> None:
        try:
            import pyaudio
        except ImportError:
            sys.exit("pyaudio is not installed. Use --file, or: pip install pyaudio")

        pa = pyaudio.PyAudio()
        stream = pa.open(format=pyaudio.paInt16, channels=1, rate=SAMPLE_RATE,
                         input=True, frames_per_buffer=CHUNK_BYTES // 2)

        def capture():
            while not self.stop.is_set():
                data = stream.read(CHUNK_BYTES // 2, exception_on_overflow=False)
                try:
                    self.audio_q.put_nowait(data)
                except queue.Full:
                    self.audio_q.get_nowait()          # drop oldest, never block capture
                    self.audio_q.put_nowait(data)

        threading.Thread(target=capture, daemon=True).start()
        self._connect()
        stream.stop_stream(); stream.close(); pa.terminate()

    def run_file(self, path: str) -> None:
        with wave.open(path, "rb") as w:
            if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, SAMPLE_RATE):
                sys.exit(f"{path} must be 16 kHz mono 16-bit. Convert with:\n"
                         f"  ffmpeg -i {path} -ac 1 -ar 16000 -sample_fmt s16 out.wav")
            pcm = w.readframes(w.getnframes())

        def feed():
            # Pace at real time. Sending faster trips close code 3007 and produces
            # inconsistent turn boundaries.
            for i in range(0, len(pcm), CHUNK_BYTES):
                if self.stop.is_set():
                    return
                self.audio_q.put(pcm[i:i + CHUNK_BYTES])
                time.sleep(CHUNK_MS / 1000)
            self.audio_q.put(None)

        threading.Thread(target=feed, daemon=True).start()
        self._connect()

    def _connect(self) -> None:
        url = self.url()
        print(f"Connecting to {STT_HOST}")
        print(f"Languages: {' <-> '.join(LANGUAGE_NAMES.get(c, c) for c in self.pair)}")
        print(f"Context:   {self.ctx.build_prompt()[:120]}...")
        print("-" * 76)

        self.ws = websocket.WebSocketApp(
            url,
            header={"Authorization": API_KEY},
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=lambda ws, e: print(f"[error] {e}"),
            on_close=self._on_close,
        )
        self.ws.run_forever()

    # -- websocket callbacks --------------------------------------------------------------

    def _on_open(self, ws) -> None:
        def pump():
            while not self.stop.is_set():
                chunk = self.audio_q.get()
                if chunk is None:
                    break
                try:
                    ws.send(chunk, websocket.ABNF.OPCODE_BINARY)
                except Exception:
                    break
            # Terminate flushes the open turn and stops the billing clock. Streaming is
            # billed on connection duration, not audio sent, so an abandoned socket on a
            # battery-powered device costs money for nothing.
            try:
                ws.send(json.dumps({"type": "Terminate"}))
            except Exception:
                pass

        threading.Thread(target=pump, daemon=True).start()

    def _on_message(self, ws, raw: str) -> None:
        msg = json.loads(raw)
        kind = msg.get("type")

        if kind == "Begin":
            print(f"[session] {msg.get('id')}")
            # Verify the server applied what we asked for. Catching a defaulted model here
            # takes one line and saves a support ticket later.
            if cfg := msg.get("configuration"):
                print(f"[applied] {cfg}")

        elif kind == "SpeechStarted":
            self._speech_ended_at = None

        elif kind == "Turn":
            transcript = (msg.get("transcript") or "").strip()
            if not transcript:
                return

            if not msg.get("end_of_turn"):
                print(f"\r  ...{transcript[-60:]}", end="", flush=True)
                return

            self._speech_ended_at = self._speech_ended_at or time.monotonic()
            self._handle_final(msg, transcript)

        elif kind == "Termination":
            print(f"\n[terminated] audio={msg.get('audio_duration_seconds')}s "
                  f"session={msg.get('session_duration_seconds')}s")

    def _handle_final(self, msg: dict, transcript: str) -> None:
        t = TurnTiming()
        t.stt_final_ms = 400.0   # approximate; exact value needs a device-side speech clock

        source = msg.get("language_code") or self.pair[0]
        confidence = msg.get("language_confidence")
        # Two-way device: whatever language was spoken, send it to the other one.
        target = self.pair[1] if source == self.pair[0] else self.pair[0]

        print("\r" + " " * 78 + "\r", end="")
        conf = f" ({confidence:.2f})" if isinstance(confidence, (int, float)) else ""
        print(f"  [{source}{conf}] {transcript}")

        try:
            t0 = time.monotonic()
            translated = translate(transcript, source, target, self.ctx)
            t.translate_ms = (time.monotonic() - t0) * 1000
        except Exception as e:
            print(f"  [translation failed] {e}")
            return

        print(f"  [{target}] {translated}")
        t.tts_ms = speak(translated, target)

        self.ctx.remember(transcript)
        self.turns += 1
        self.timings.append(t)
        print(f"  {t.render()}")
        print()

    def _on_close(self, ws, code, reason) -> None:
        self.stop.set()
        if code and code != 1000:
            print(f"\n[closed] code={code} reason={reason}")
        if self.timings:
            avg = sum(x.total_ms for x in self.timings) / len(self.timings)
            worst = max(x.total_ms for x in self.timings)
            print(f"\n{self.turns} turns | average {avg:.0f}ms | worst {worst:.0f}ms end to end")


# ---------------------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="iTranslate device simulator")
    ap.add_argument("--pair", default="en,es", help="two language codes, e.g. en,es")
    ap.add_argument("--file", help="stream a WAV instead of the microphone (16 kHz mono 16-bit)")
    ap.add_argument("--location", help="GPS-derived location, feeds the context prompt")
    ap.add_argument("--domain", help="travel | medical | business | legal")
    ap.add_argument("--names", default="", help="comma-separated names likely to be spoken")
    ap.add_argument("--keyterms", default="",
                    help="comma-separated vocabulary list; used instead of the context prompt")
    args = ap.parse_args()

    if not API_KEY:
        sys.exit("Set ASSEMBLYAI_API_KEY.")

    ctx = DeviceContext(
        location=args.location,
        domain=args.domain,
        known_names=[n.strip() for n in args.names.split(",") if n.strip()],
    )
    device = TranslationDevice(
        pair=[c.strip() for c in args.pair.split(",")],
        ctx=ctx,
        keyterms=[k.strip() for k in args.keyterms.split(",") if k.strip()],
    )

    try:
        if args.file:
            device.run_file(args.file)
        else:
            device.run_mic()
    except KeyboardInterrupt:
        device.stop.set()
        if device.ws:
            device.ws.close()


if __name__ == "__main__":
    main()
