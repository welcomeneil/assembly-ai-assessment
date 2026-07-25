#!/usr/bin/env python3
"""
Spanglish Inc. — reproduction harness.

Streams the SAME audio file through four configurations so you can watch each bug
fire in isolation and then watch the fixed config work. This is the artifact that
turns "your product doesn't work" into a specific, agreed-upon root cause.

    export ASSEMBLYAI_API_KEY=...
    python3 repro.py sample_bilingual.wav              # run all four
    python3 repro.py sample_bilingual.wav --only broken

Configs:
  1. broken        exactly what Spanglish sent us: encoding=opus + 25 ms chunks + no model
  2. fix_encoding  pcm_s16le, but still 25 ms chunks      -> isolates the chunk-size bug
  3. fix_chunks    pcm_s16le + 50 ms chunks, no model      -> isolates the language bug
  4. fixed         pcm_s16le + 50 ms + universal-3-5-pro + language_codes=en,es

Expected results:
  1. Begin arrives, then the socket dies. No Turn messages, ever.
  2. Close 3007 "Input duration violation: 25 ms. Expected between 50 and 1000 ms".
  3. Transcripts appear, but Spanish is mangled into English-looking tokens.
  4. Clean bilingual transcript with per-turn language codes.

Requires: pip install websocket-client
"""

import argparse
import json
import os
import sys
import threading
import time
import wave
from urllib.parse import urlencode

import websocket  # websocket-client

API_KEY = os.environ.get("ASSEMBLYAI_API_KEY")
HOST = os.environ.get("AAI_STREAMING_HOST", "streaming.assemblyai.com")

# The four configurations under test. Only the values in here differ between runs.
CONFIGS = {
    # ---- 1. Verbatim from the customer's Java file -------------------------------------
    "broken": {
        "label": "AS-SENT (encoding=opus, 25 ms chunks, no speech_model)",
        "params": {
            "sample_rate": 16000,
            "encoding": "opus",        # BUG: we send raw PCM, not Opus packets
            "format_turns": "true",    # deprecated on U3.5 Pro
        },
        "chunk_ms": 25,                # BUG: below the 50 ms floor
        "expect": "Begin, then silence or an abrupt close. No Turn messages.",
    },
    # ---- 2. Fix the encoding only ------------------------------------------------------
    "fix_encoding": {
        "label": "encoding=pcm_s16le, still 25 ms chunks",
        "params": {"sample_rate": 16000, "encoding": "pcm_s16le"},
        "chunk_ms": 25,
        "expect": "Close 3007: Input duration violation: 25 ms. Expected between 50 and 1000 ms.",
    },
    # ---- 3. Fix encoding + chunk size, leave the model defaulted -----------------------
    "fix_chunks": {
        "label": "pcm_s16le + 50 ms chunks, speech_model left at the account default",
        "params": {"sample_rate": 16000, "encoding": "pcm_s16le"},
        "chunk_ms": 50,
        "expect": "Transcripts flow, but Spanish is transliterated badly (English-only default).",
    },
    # ---- 4. The recommended production configuration -----------------------------------
    "fixed": {
        "label": "pcm_s16le + 50 ms + universal-3-5-pro + language_codes=en,es",
        "params": {
            "sample_rate": 16000,
            "encoding": "pcm_s16le",
            "speech_model": "universal-3-5-pro",
            "language_codes": "en,es",
            "language_detection": "true",
            "speaker_labels": "true",
        },
        "chunk_ms": 50,
        "expect": "Clean bilingual transcript, per-turn language_code, speaker labels.",
    },
}

CLOSE_CODES = {
    1000: "Normal closure.",
    1008: "Unauthorized: bad/missing key, or an account issue.",
    1011: "Server-side internal error.",
    3005: "Session cancelled (catch-all server error).",
    3006: "Invalid message / invalid JSON / inactivity timeout.",
    3007: "Input duration violation (chunk outside 50-1000 ms) or audio sent faster than real time.",
    3008: "Session expired: 3-hour max session duration.",
    3009: "Too many concurrent sessions (new-session rate limit).",
}


def read_pcm(path: str) -> bytes:
    """Load a WAV and assert it is 16 kHz mono 16-bit — the format the URL will claim."""
    with wave.open(path, "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
            sys.exit(
                f"{path} is {w.getnchannels()}ch/{w.getsampwidth() * 8}bit/{w.getframerate()}Hz. "
                "Need mono/16-bit/16000Hz. Convert with:\n"
                f"  ffmpeg -i {path} -ac 1 -ar 16000 -sample_fmt s16 out.wav"
            )
        return w.readframes(w.getnframes())


def run_config(name: str, cfg: dict, pcm: bytes) -> dict:
    url = f"wss://{HOST}/v3/ws?{urlencode(cfg['params'])}"
    chunk_bytes = int(16000 * (cfg["chunk_ms"] / 1000.0)) * 2  # 16 kHz, 2 bytes/sample

    print("\n" + "=" * 78)
    print(f"CONFIG: {name}  —  {cfg['label']}")
    print(f"  url         {url}")
    print(f"  chunk       {cfg['chunk_ms']} ms / {chunk_bytes} bytes")
    print(f"  expecting   {cfg['expect']}")
    print("-" * 78)

    result = {"name": name, "turns": 0, "close_code": None, "close_reason": "", "began": False}
    done = threading.Event()

    def on_open(ws):
        def pump():
            # Pace at real time. Blasting a file at full speed also trips 3007
            # ("Audio Transmission Rate Exceeded"), which would confound the test.
            for i in range(0, len(pcm), chunk_bytes):
                if done.is_set():
                    return
                ws.send(pcm[i:i + chunk_bytes], websocket.ABNF.OPCODE_BINARY)
                time.sleep(cfg["chunk_ms"] / 1000.0)
            try:
                ws.send(json.dumps({"type": "Terminate"}))
            except Exception:
                pass

        threading.Thread(target=pump, daemon=True).start()

    def on_message(ws, raw):
        msg = json.loads(raw)
        t = msg.get("type")
        if t == "Begin":
            result["began"] = True
            print(f"  [Begin] session={msg.get('id')}")
            # The server echoes the configuration it actually applied. Logging this is
            # how you catch a wrong/defaulted model in the first 200 ms instead of in prod.
            if "configuration" in msg:
                print(f"  [Begin] server config={msg['configuration']}")
        elif t == "Turn":
            if msg.get("end_of_turn") and msg.get("transcript"):
                result["turns"] += 1
                lang = f" [{msg['language_code']}]" if msg.get("language_code") else ""
                spk = f"{msg['speaker_label']}: " if msg.get("speaker_label") else ""
                print(f"  [Turn] {spk}{msg['transcript']}{lang}")
        elif t == "Termination":
            print(f"  [Termination] audio={msg.get('audio_duration_seconds')}s "
                  f"session={msg.get('session_duration_seconds')}s")
        else:
            # Never swallow unknown types — this is where the server tells you what is wrong.
            print(f"  [{t}] {raw}")

    def on_error(ws, err):
        print(f"  [error] {err}")

    def on_close(ws, code, reason):
        result["close_code"], result["close_reason"] = code, reason or ""
        print(f"  [close] code={code} reason={reason}")
        print(f"          -> {CLOSE_CODES.get(code, 'unmapped code')}")
        done.set()

    ws = websocket.WebSocketApp(
        url,
        header={"Authorization": API_KEY},
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    threading.Thread(target=ws.run_forever, daemon=True).start()

    # Cap each config so a hung/broken run cannot stall the whole demo.
    done.wait(timeout=len(pcm) / 32000.0 + 20)
    try:
        ws.close()
    except Exception:
        pass

    print(f"  RESULT: began={result['began']} turns={result['turns']} "
          f"close={result['close_code']}")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav", help="16 kHz mono 16-bit WAV with English+Spanish speech")
    ap.add_argument("--only", choices=list(CONFIGS), help="run a single config")
    args = ap.parse_args()

    if not API_KEY:
        sys.exit("Set ASSEMBLYAI_API_KEY.")

    pcm = read_pcm(args.wav)
    print(f"Loaded {len(pcm)} bytes ({len(pcm) / 32000.0:.1f}s) from {args.wav}")

    names = [args.only] if args.only else list(CONFIGS)
    results = [run_config(n, CONFIGS[n], pcm) for n in names]

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    print(f"{'config':<14}{'began':<8}{'turns':<8}{'close':<8}reason")
    for r in results:
        print(f"{r['name']:<14}{str(r['began']):<8}{r['turns']:<8}"
              f"{str(r['close_code']):<8}{r['close_reason'][:40]}")


if __name__ == "__main__":
    main()
