#!/usr/bin/env python3
"""The handheld, simulated.

This is the path iTranslate's firmware team would actually build, and the reason it is
separate from the demo server: in production the device holds the socket itself. Audio
goes from the microphone straight to AssemblyAI. It does not pass through iTranslate's
backend, which is what keeps their backend the same size at 100,000 devices as at 100.

Three things worth reading the code for:

  1. The device never holds an API key. It asks its own server for a single-use token
     immediately before connecting. A consumer handheld can be opened and its firmware
     dumped; a key on one device is a key on every device, and revoking it would brick
     the fleet.

  2. The connection parameters come back from that same call, not from firmware.
     Firmware takes months to roll across a consumer fleet, so anything compiled in is
     frozen for months. Served, it can change for every device at once -- or for 1% of
     them first.

  3. Translation happens inside the streaming session via the llm_gateway parameter,
     so a finished turn does not have to make a second round trip to a second service
     before the user hears anything.

Usage:

    # against the bundled sample, no microphone needed
    python3 device_sim.py --file ../demo/audio/herring1.wav --dashboard

    # with a microphone
    python3 device_sim.py --mic --dashboard

    # standalone, no dashboard
    python3 device_sim.py --file ../demo/audio/herring1.wav
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from typing import Any

try:
    import websockets
except ImportError:  # pragma: no cover
    sys.exit("websockets is not installed. pip install -r requirements.txt")

STREAMING_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws"

# 100 ms per chunk. The API accepts 50-1000 ms; below 50 ms the server closes the
# session with code 3007, and chunks have to arrive at roughly the speed they were
# spoken or the latency figures stop meaning anything.
CHUNK_MS = 100
SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2

DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


# ---------------------------------------------------------------------------
# Talking to the device's own server
# ---------------------------------------------------------------------------

def post(url: str, payload: dict[str, Any] | None = None, timeout: float = 10) -> dict:
    body = json.dumps(payload or {}).encode()
    request = urllib.request.Request(
        url, data=body, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def get_session(server: str) -> dict:
    """Ask the fleet server for a token and the parameters to connect with."""
    try:
        return post(f"{server}/api/token")
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        sys.exit(f"token request failed ({error.code}): {detail}")
    except urllib.error.URLError as error:
        sys.exit(f"cannot reach {server}: {error.reason}\nis the demo server running?")


def publish(server: str, event: dict) -> None:
    """Send an event to the dashboard. Best effort -- the device keeps working if the
    dashboard is not there, which is how it behaves in the field."""
    try:
        post(f"{server}/api/publish", event, timeout=2)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def read_wav(path: str) -> bytes:
    with wave.open(path, "rb") as source:
        if source.getsampwidth() != BYTES_PER_SAMPLE:
            sys.exit(f"{path}: expected 16-bit PCM")
        if source.getframerate() != SAMPLE_RATE or source.getnchannels() != 1:
            sys.exit(
                f"{path}: expected {SAMPLE_RATE} Hz mono, got "
                f"{source.getframerate()} Hz / {source.getnchannels()} channel(s).\n"
                f"Convert it: ffmpeg -i {path} -ac 1 -ar {SAMPLE_RATE} -c:a pcm_s16le out.wav")
        return source.readframes(source.getnframes())


async def file_chunks(path: str):
    """Yield a WAV file at the speed it was spoken."""
    pcm = read_wav(path)
    size = int(SAMPLE_RATE * CHUNK_MS / 1000) * BYTES_PER_SAMPLE
    started = time.monotonic()
    for index, offset in enumerate(range(0, len(pcm), size)):
        due = started + index * CHUNK_MS / 1000
        delay = due - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        yield pcm[offset:offset + size]


async def mic_chunks():
    """Yield microphone audio. sounddevice is only imported here so the file path
    works without PortAudio installed."""
    try:
        import sounddevice
    except ImportError:
        sys.exit("--mic needs sounddevice: pip install sounddevice")

    queue: asyncio.Queue[bytes] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def callback(indata, _frames, _time, status):
        if status:
            print(f"{DIM}audio: {status}{RESET}", file=sys.stderr)
        loop.call_soon_threadsafe(queue.put_nowait, bytes(indata))

    stream = sounddevice.RawInputStream(
        samplerate=SAMPLE_RATE, channels=1, dtype="int16",
        blocksize=int(SAMPLE_RATE * CHUNK_MS / 1000), callback=callback)
    with stream:
        print(f"{DIM}listening -- ctrl-c to stop{RESET}\n")
        while True:
            yield await queue.get()


# ---------------------------------------------------------------------------
# Text to speech
#
# AssemblyAI does not do TTS and iTranslate already has an engine, so this is the seam
# where theirs drops in. macOS `say` is here only so the demo makes a sound.
# ---------------------------------------------------------------------------

VOICES = {"es": "Monica", "en": "Samantha", "fr": "Amelie", "de": "Anna",
          "it": "Alice", "pt": "Luciana"}


def speak(text: str, language: str) -> int:
    """Play the translation. Returns milliseconds spent."""
    if not text or not shutil.which("say"):
        return 0
    started = time.monotonic()
    voice = VOICES.get(language)
    command = ["say"] + (["-v", voice] if voice else []) + [text]
    try:
        subprocess.run(command, check=False, timeout=20)
    except subprocess.TimeoutExpired:
        pass
    return int((time.monotonic() - started) * 1000)


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

async def run(args: argparse.Namespace) -> None:
    session = get_session(args.server)
    params = dict(session["params"])
    params["prompt"] = session["prompt"]
    params["keyterms_prompt"] = json.dumps(session["keyterms"])
    params["token"] = session["token"]

    query = "&".join(f"{key}={urllib.parse.quote(str(value))}" for key, value in params.items())
    url = f"{STREAMING_ENDPOINT}?{query}"

    print(f"\n{BOLD}iTranslate handheld{RESET}  {DIM}{params['speech_model']} · "
          f"{params['language_codes']} · detection on · {params['voice_focus']}{RESET}")
    print(f"{DIM}prompt: {session['prompt']}{RESET}\n")

    started = time.monotonic()
    def at() -> int:
        return int((time.monotonic() - started) * 1000)

    # Turn order -> when its final transcript arrived, so translation latency is
    # measured rather than guessed, and turn order -> its recognition latency, so the
    # summary line can print the whole budget once the turn has been spoken.
    finalised: dict[int, int] = {}
    recognition_ms: dict[int, int] = {}
    audio_ms = 0

    async with websockets.connect(url, max_size=None) as socket:

        async def send_audio() -> None:
            nonlocal audio_ms
            source = mic_chunks() if args.mic else file_chunks(args.file)
            async for chunk in source:
                await socket.send(chunk)
                audio_ms += CHUNK_MS
            # Let the last turn finalise, then hang up. Streaming bills on how long the
            # connection is open, so lingering here costs real money at fleet scale.
            await asyncio.sleep(2)
            await socket.send(json.dumps({"type": "Terminate"}))

        async def receive() -> None:
            async for raw in socket:
                message = json.loads(raw)
                kind = message.get("type")

                if kind == "Begin":
                    if args.dashboard:
                        publish(args.server, {
                            "type": "session.open", "at": at(), "mode": "live",
                            "audio": args.file.split("/")[-1] if args.file else "microphone",
                            "config": {"params": session["params"],
                                       "prompt": session["prompt"],
                                       "keyterms": session["keyterms"]},
                        })

                elif kind == "Turn" and message.get("end_of_turn"):
                    order = message["turn_order"]
                    now = at()
                    finalised[order] = now
                    words = message.get("words") or []
                    recognition_ms[order] = max(
                        0, now - (words[-1]["end"] if words else now))
                    audio_end = words[-1]["end"] if words else now
                    language = message.get("language_code") or "??"
                    confidence = message.get("language_confidence") or 0.0
                    stt_ms = max(0, now - audio_end)

                    print(f"  {BOLD}[{language} {confidence:.2f}]{RESET} {message['transcript']}")

                    if args.dashboard:
                        publish(args.server, {
                            "type": "turn.final", "at": now, "order": order,
                            "transcript": message["transcript"],
                            "words": [{"text": w["text"], "confidence": w["confidence"]}
                                      for w in words],
                            "languageCode": language, "languageConfidence": confidence,
                            "midTurnSwitch": confidence < 0.9,
                            "audioStartMs": words[0]["start"] if words else audio_end,
                            "audioEndMs": audio_end, "sttMs": stt_ms,
                        })

                elif kind in ("LlmGatewayResponse", "LLMGatewayResponse"):
                    order = message.get("turn_order", 0)
                    choices = (message.get("data") or {}).get("choices") or [{}]
                    text = (choices[0].get("message") or {}).get("content", "").strip()
                    now = at()
                    translate_ms = now - finalised.get(order, now)
                    print(f"  {DIM}→{RESET} {text}")

                    if args.dashboard:
                        publish(args.server, {
                            "type": "turn.translation", "at": now, "order": order,
                            "target": "", "text": text, "translateMs": translate_ms})

                    # The device speaks. This blocks, exactly as it does on the handheld:
                    # you cannot play two translations over each other.
                    tts_ms = await asyncio.to_thread(speak, text, args.speak_as)
                    if tts_ms and args.dashboard:
                        publish(args.server, {
                            "type": "turn.speech", "at": at(), "order": order,
                            "ttsMs": tts_ms})
                    stt_ms = recognition_ms.get(order, 0)
                    print(f"  {DIM}recognise {stt_ms} ms · translate {translate_ms} ms"
                          f"{f' · speak {tts_ms} ms' if tts_ms else ''}"
                          f" · total {stt_ms + translate_ms + tts_ms} ms{RESET}\n")

                elif kind == "Termination":
                    print(f"\n{DIM}session closed · {message['audio_duration_seconds']:.1f}s "
                          f"audio · {message['session_duration_seconds']:.1f}s billed{RESET}")
                    if args.dashboard:
                        publish(args.server, {
                            "type": "session.close", "at": at(),
                            "audioDurationSeconds": message["audio_duration_seconds"],
                            "sessionDurationSeconds": message["session_duration_seconds"]})
                    return

                elif kind == "Error":
                    print(f"server error: {message}", file=sys.stderr)
                    return

        async def meter() -> None:
            while True:
                await asyncio.sleep(1)
                if args.dashboard:
                    publish(args.server, {"type": "meter", "at": at(),
                                          "connectionMs": at(), "audioMs": audio_ms})

        pump = asyncio.create_task(send_audio())
        ticker = asyncio.create_task(meter())
        try:
            await receive()
        finally:
            for task in (pump, ticker):
                task.cancel()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Simulate the iTranslate handheld against AssemblyAI streaming.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="examples:\n"
               "  python3 device_sim.py --file ../demo/audio/herring1.wav --dashboard\n"
               "  python3 device_sim.py --mic --dashboard\n")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file", help="16 kHz mono WAV to stream")
    source.add_argument("--mic", action="store_true", help="stream from the microphone")
    parser.add_argument("--server", default="http://localhost:8787",
                        help="the fleet server that mints tokens (default: %(default)s)")
    parser.add_argument("--dashboard", action="store_true",
                        help="publish events to the dashboard as well as the terminal")
    parser.add_argument("--speak-as", default="es", metavar="LANG",
                        help="TTS voice language for the translation (default: %(default)s)")
    args = parser.parse_args()

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
