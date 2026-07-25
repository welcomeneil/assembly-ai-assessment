#!/usr/bin/env python3
"""
Accuracy benchmark for the iTranslate use case.

iTranslate's stated goal is better STT accuracy. This measures it instead of asserting it.

The script streams one audio file through a series of configurations, each adding a single
accuracy lever on top of the previous one, and reports word error rate against a reference
transcript. The output is a table an account executive can put in front of the customer, and
a harness iTranslate can re-run on their own audio.

    export ASSEMBLYAI_API_KEY=...
    python3 accuracy_bench.py sample.wav reference.txt

    # measure one lever in isolation
    python3 accuracy_bench.py sample.wav reference.txt --only baseline,prompt_detailed

Requires: pip install websocket-client
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import unicodedata
import wave
from dataclasses import dataclass
from urllib.parse import urlencode

import websocket

API_KEY = os.environ.get("ASSEMBLYAI_API_KEY")
HOST = os.environ.get("AAI_STREAMING_HOST", "streaming.assemblyai.com")
SAMPLE_RATE = 16_000
CHUNK_MS = 50
CHUNK_BYTES = SAMPLE_RATE * 2 * CHUNK_MS // 1000


# ---------------------------------------------------------------------------------------
# Configurations under test
# ---------------------------------------------------------------------------------------
#
# Each entry adds one lever. Ordering matters: read the table top to bottom to see where the
# accuracy actually comes from for this audio. On a different corpus the ranking will differ,
# which is the reason to hand this script to the customer rather than quote a number at them.

def configs(pair: str, prompt: str, keyterms: str) -> dict[str, dict]:
    base = {"encoding": "pcm_s16le", "sample_rate": SAMPLE_RATE}
    return {
        # What a language-pinned integration typically looks like today.
        "baseline_english_only": {
            **base,
            "speech_model": "universal-streaming-english",
            "_note": "English-only model, no context, no noise handling",
        },
        # Model upgrade alone.
        "u3_5_pro": {
            **base,
            "speech_model": "universal-3-5-pro",
            "_note": "Universal-3.5 Pro, no other changes",
        },
        # Tell the model which languages are in play.
        "language_biased": {
            **base,
            "speech_model": "universal-3-5-pro",
            "language_codes": pair,
            "language_detection": "true",
            "_note": f"+ language_codes={pair}",
        },
        # Handheld device held close to the mouth in a noisy public space.
        "voice_focus": {
            **base,
            "speech_model": "universal-3-5-pro",
            "language_codes": pair,
            "language_detection": "true",
            "voice_focus": "near-field",
            "voice_focus_threshold": "0.7",
            "_note": "+ voice_focus=near-field",
        },
        # Situational context. AssemblyAI's published benchmark on 20,000 calls puts a
        # detailed prompt at 21% lower WER and 49% lower error on person names.
        "prompt_detailed": {
            **base,
            "speech_model": "universal-3-5-pro",
            "language_codes": pair,
            "language_detection": "true",
            "voice_focus": "near-field",
            "prompt": prompt,
            "_note": "+ prompt (situational context)",
        },
        # Explicit vocabulary list. Mutually exclusive with prompt: AssemblyAI advises against
        # sending both, because overprompting degrades results.
        "keyterms": {
            **base,
            "speech_model": "universal-3-5-pro",
            "language_codes": pair,
            "language_detection": "true",
            "voice_focus": "near-field",
            "keyterms_prompt": keyterms,
            "_note": "+ keyterms_prompt (instead of prompt)",
        },
    }


# ---------------------------------------------------------------------------------------
# Word error rate
# ---------------------------------------------------------------------------------------

def normalize(text: str) -> list[str]:
    """Lowercase, strip accents and punctuation, collapse whitespace.

    Standard WER preprocessing. Without it, punctuation and casing differences inflate the
    error rate and hide the change you are actually trying to measure.
    """
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^\w\s]", " ", text)
    return text.split()


@dataclass
class WerResult:
    wer: float
    substitutions: int
    deletions: int
    insertions: int
    ref_words: int

    def render(self) -> str:
        return (f"{self.wer * 100:5.1f}%  "
                f"(S{self.substitutions} D{self.deletions} I{self.insertions} "
                f"/ {self.ref_words} words)")


def word_error_rate(reference: str, hypothesis: str) -> WerResult:
    """Levenshtein distance over words, with the edit types broken out.

    The breakdown matters for diagnosis. Deletions usually mean audio was dropped or the
    endpointer cut a turn short. Substitutions usually mean vocabulary or accent. Insertions
    usually mean noise being transcribed as speech, which is what voice_focus addresses.
    """
    ref, hyp = normalize(reference), normalize(hypothesis)
    n, m = len(ref), len(hyp)

    # d[i][j] = (cost, substitutions, deletions, insertions)
    d = [[(0, 0, 0, 0)] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        d[i][0] = (i, 0, i, 0)
    for j in range(1, m + 1):
        d[0][j] = (j, 0, 0, j)

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                d[i][j] = d[i - 1][j - 1]
                continue
            sub = d[i - 1][j - 1]
            dele = d[i - 1][j]
            ins = d[i][j - 1]
            best = min(sub[0], dele[0], ins[0]) + 1
            if sub[0] <= dele[0] and sub[0] <= ins[0]:
                d[i][j] = (best, sub[1] + 1, sub[2], sub[3])
            elif dele[0] <= ins[0]:
                d[i][j] = (best, dele[1], dele[2] + 1, dele[3])
            else:
                d[i][j] = (best, ins[1], ins[2], ins[3] + 1)

    cost, s, dl, ins = d[n][m]
    return WerResult(cost / n if n else 0.0, s, dl, ins, n)


# ---------------------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------------------

def read_pcm(path: str) -> bytes:
    with wave.open(path, "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, SAMPLE_RATE):
            sys.exit(f"{path} must be 16 kHz mono 16-bit. Convert with:\n"
                     f"  ffmpeg -i {path} -ac 1 -ar 16000 -sample_fmt s16 out.wav")
        return w.readframes(w.getnframes())


def run_config(name: str, params: dict, pcm: bytes) -> tuple[str, float]:
    """Stream the audio once. Returns the concatenated transcript and time to first final."""
    note = params.pop("_note", "")
    url = f"wss://{HOST}/v3/ws?{urlencode(params)}"
    print(f"\n{name}")
    print(f"  {note}")

    turns: list[str] = []
    first_final: list[float] = []
    done = threading.Event()
    started = time.monotonic()

    def on_open(ws):
        def pump():
            for i in range(0, len(pcm), CHUNK_BYTES):
                if done.is_set():
                    return
                ws.send(pcm[i:i + CHUNK_BYTES], websocket.ABNF.OPCODE_BINARY)
                time.sleep(CHUNK_MS / 1000)   # real-time pacing avoids close code 3007
            try:
                ws.send(json.dumps({"type": "Terminate"}))
            except Exception:
                pass
        threading.Thread(target=pump, daemon=True).start()

    def on_message(ws, raw):
        msg = json.loads(raw)
        if msg.get("type") == "Turn" and msg.get("end_of_turn"):
            text = (msg.get("transcript") or "").strip()
            if text:
                if not first_final:
                    first_final.append(time.monotonic() - started)
                turns.append(text)
                lang = msg.get("language_code", "")
                print(f"    [{lang}] {text}" if lang else f"    {text}")

    def on_close(ws, code, reason):
        if code and code not in (1000, None):
            print(f"    [closed {code}] {reason}")
        done.set()

    ws = websocket.WebSocketApp(
        url, header={"Authorization": API_KEY},
        on_open=on_open, on_message=on_message,
        on_error=lambda w, e: print(f"    [error] {e}"), on_close=on_close,
    )
    threading.Thread(target=ws.run_forever, daemon=True).start()
    done.wait(timeout=len(pcm) / 32000.0 + 25)
    try:
        ws.close()
    except Exception:
        pass

    return " ".join(turns), (first_final[0] if first_final else 0.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav", help="16 kHz mono 16-bit WAV")
    ap.add_argument("reference", help="text file containing the ground-truth transcript")
    ap.add_argument("--pair", default="en,es")
    ap.add_argument("--only", help="comma-separated config names to run")
    ap.add_argument("--prompt",
                    default="Two travellers having a face-to-face conversation through a "
                            "handheld translation device in a busy public place. They are "
                            "asking for directions, ordering food and discussing prices.")
    ap.add_argument("--keyterms", default="",
                    help="comma-separated vocabulary list, max 100 terms of 50 chars each")
    args = ap.parse_args()

    if not API_KEY:
        sys.exit("Set ASSEMBLYAI_API_KEY.")

    pcm = read_pcm(args.wav)
    reference = open(args.reference, encoding="utf-8").read().strip()

    all_configs = configs(args.pair, args.prompt, args.keyterms)
    if not args.keyterms:
        all_configs.pop("keyterms")   # nothing to boost, so the run would be meaningless
    if args.only:
        wanted = {n.strip() for n in args.only.split(",")}
        all_configs = {k: v for k, v in all_configs.items() if k in wanted}

    print(f"Audio:     {args.wav} ({len(pcm) / 32000:.1f}s)")
    print(f"Reference: {len(normalize(reference))} words")
    print("=" * 76)

    results: list[tuple[str, WerResult, float]] = []
    for name, params in all_configs.items():
        hypothesis, ttff = run_config(name, dict(params), pcm)
        results.append((name, word_error_rate(reference, hypothesis), ttff))

    print("\n" + "=" * 76)
    print("RESULTS")
    print("=" * 76)
    print(f"{'config':<24}{'WER':<10}{'vs baseline':<14}{'1st final':<11}detail")
    print("-" * 76)

    baseline = results[0][1].wer if results else 0.0
    for name, wer, ttff in results:
        delta = ""
        if baseline > 0 and name != results[0][0]:
            change = (wer - baseline) / baseline * 100
            delta = f"{change:+.0f}%"
        print(f"{name:<24}{wer.wer * 100:>5.1f}%    {delta:<14}{ttff:>6.2f}s    "
              f"S{wer.substitutions} D{wer.deletions} I{wer.insertions}")

    print("\nRead deletions as dropped audio or an endpointer cutting turns short, "
          "\nsubstitutions as vocabulary or accent, and insertions as noise being "
          "\ntranscribed as speech.")


if __name__ == "__main__":
    main()
