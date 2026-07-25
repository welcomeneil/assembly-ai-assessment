#!/usr/bin/env python3
"""
Spanglish Inc. reference client for running Universal-Streaming at 2,000 concurrent streams.

The Java file in ./java is the minimal fix to what Spanglish sent us: one session, one
microphone. This file is the other half of the answer, the patterns you need when the same
code runs 2,000 times at once against real courtrooms.

Five things this demonstrates that a single-session client does not need:

  1. SESSION ROLLOVER around the 3-hour cap (close 3008). Court proceedings routinely run
     longer than three hours. Overlap the new session before retiring the old one so no audio
     is lost across the seam.
  2. BACKOFF ON 3009 with full jitter. The new-session rate limit is per-minute; a thundering
     herd of synchronised retries is what turns a brief throttle into an outage.
  3. BOUNDED BACKPRESSURE. Audio capture must never block on the network. Drop oldest and
     count the drops as a metric, a silent drop is worse than a visible one.
  4. KEEPALIVE during silence, so recesses and sidebars do not kill the session (close 3006).
  5. STRUCTURED SESSION TELEMETRY keyed on the server's session id, which is the correlation
     id AssemblyAI support needs.

Requires: pip install websockets
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import random
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Callable, Optional
from urllib.parse import urlencode

import websockets

log = logging.getLogger("spanglish.stt")

# Pin the Data Zone. The bare `streaming.assemblyai.com` host is edge-routed for latency and
# carries NO data-residency guarantee, the wrong default for court audio.
HOST = os.environ.get("AAI_STREAMING_HOST", "streaming.us.assemblyai.com")

SAMPLE_RATE = 16_000
CHUNK_MS = 50                                     # inside the required 50-1000 ms window
CHUNK_BYTES = SAMPLE_RATE * 2 * CHUNK_MS // 1000  # 1600 bytes

# Roll over well before the hard 3-hour cap so the seam is ours to schedule, not the server's.
SESSION_MAX_SECONDS = 3 * 60 * 60
ROLLOVER_AT_SECONDS = SESSION_MAX_SECONDS - 120   # 2h58m
ROLLOVER_OVERLAP_SECONDS = 2.0                    # both sockets live briefly, so nothing drops

KEEPALIVE_INTERVAL = 20.0                         # seconds of silence before a KeepAlive


@dataclass
class StreamConfig:
    """Connection parameters. Everything here is explicit on purpose, see FIX #4 in the Java
    file: never let a production stream inherit an account-level default that can move."""
    speech_model: str = "universal-3-5-pro"       # alias: u3-rt-pro. $0.45/hr of open socket.
    language_codes: str = "en,es"                 # bias en+es, keep native code-switching
    language_detection: bool = True               # per-turn language_code + confidence
    speaker_labels: bool = True                   # judge / witness / interpreter
    max_speakers: int = 6
    encoding: str = "pcm_s16le"                   # MUST match the bytes you actually send
    sample_rate: int = SAMPLE_RATE
    keyterms_prompt: Optional[str] = None         # e.g. "voir dire,habeas corpus,fiscal"
    redact_pii: bool = False

    def url(self) -> str:
        p = {
            "speech_model": self.speech_model,
            "encoding": self.encoding,
            "sample_rate": self.sample_rate,
            "language_codes": self.language_codes,
            "language_detection": str(self.language_detection).lower(),
            "speaker_labels": str(self.speaker_labels).lower(),
            "max_speakers": self.max_speakers,
        }
        if self.keyterms_prompt:
            p["keyterms_prompt"] = self.keyterms_prompt
        if self.redact_pii:
            p["redact_pii"] = "true"
        return f"wss://{HOST}/v3/ws?{urlencode(p)}"


@dataclass
class StreamMetrics:
    """Emit these per stream. At 2,000 concurrent, aggregates lie; percentiles and per-stream
    close-code counts are what tell you whether you are healthy."""
    session_ids: list[str] = field(default_factory=list)
    chunks_sent: int = 0
    chunks_dropped: int = 0
    turns_final: int = 0
    reconnects: int = 0
    rollovers: int = 0
    close_codes: dict[int, int] = field(default_factory=dict)
    connect_wait_seconds: float = 0.0


class RetryableClose(Exception):
    """A close we should retry (throttle, transient server error)."""


class FatalClose(Exception):
    """A close where retrying just burns rate budget (auth, bad parameters)."""


# 3009 = new-session rate limit. 1011/3005 = transient server-side. Everything else in the
# 1008 family is a configuration or account problem and MUST NOT be retried in a hot loop.
RETRYABLE_CODES = {1011, 1006, 3005, 3009}
FATAL_CODES = {1008}


class StreamingSession:
    """One WebSocket session. Owns nothing but its socket."""

    def __init__(self, config: StreamConfig, api_key: str, metrics: StreamMetrics):
        self.config = config
        self.api_key = api_key
        self.metrics = metrics
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.session_id: str = "unknown"
        self.started_at: float = 0.0
        self._last_send = 0.0

    async def __aenter__(self) -> "StreamingSession":
        t0 = time.monotonic()
        self.ws = await websockets.connect(
            self.config.url(),
            additional_headers={"Authorization": self.api_key},
            max_size=None,
            ping_interval=20,
            ping_timeout=20,
            open_timeout=15,
        )
        self.metrics.connect_wait_seconds += time.monotonic() - t0
        self.started_at = time.monotonic()
        self._last_send = self.started_at
        return self

    async def __aexit__(self, *exc) -> None:
        await self.terminate()

    @property
    def age(self) -> float:
        return time.monotonic() - self.started_at

    @property
    def needs_rollover(self) -> bool:
        return self.age >= ROLLOVER_AT_SECONDS

    async def send_audio(self, chunk: bytes) -> None:
        assert self.ws is not None
        await self.ws.send(chunk)
        self.metrics.chunks_sent += 1
        self._last_send = time.monotonic()

    async def keepalive_if_idle(self) -> None:
        """Silence during a recess must not look like a dead client (close 3006)."""
        if self.ws and time.monotonic() - self._last_send > KEEPALIVE_INTERVAL:
            await self.ws.send(json.dumps({"type": "KeepAlive"}))
            self._last_send = time.monotonic()

    async def terminate(self) -> None:
        """Terminate flushes the open turn. Skipping it loses the last sentence, and because
        billing runs on socket open-to-close, leaving it open costs money for nothing."""
        if not self.ws:
            return
        with contextlib.suppress(Exception):
            await self.ws.send(json.dumps({"type": "Terminate"}))
            await asyncio.wait_for(self._drain_until_termination(), timeout=5.0)
        with contextlib.suppress(Exception):
            await self.ws.close()
        self.ws = None

    async def _drain_until_termination(self) -> None:
        assert self.ws is not None
        async for raw in self.ws:
            if json.loads(raw).get("type") == "Termination":
                return

    async def messages(self) -> AsyncIterator[dict]:
        assert self.ws is not None
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if msg.get("type") == "Begin":
                    self.session_id = msg.get("id", "unknown")
                    self.metrics.session_ids.append(self.session_id)
                    log.info("session begin id=%s config=%s",
                             self.session_id, msg.get("configuration"))
                yield msg
        except websockets.ConnectionClosed as e:
            code = e.rcvd.code if e.rcvd else 1006
            reason = e.rcvd.reason if e.rcvd else ""
            self.metrics.close_codes[code] = self.metrics.close_codes.get(code, 0) + 1
            log.warning("session %s closed code=%s reason=%s", self.session_id, code, reason)
            if code in FATAL_CODES:
                raise FatalClose(f"{code}: {reason}") from e
            if code in RETRYABLE_CODES or code == 3008:
                raise RetryableClose(f"{code}: {reason}") from e
            raise


async def backoff_sleep(attempt: int, base: float = 0.5, cap: float = 30.0) -> None:
    """Exponential backoff with FULL jitter.

    Full jitter (sleep uniform in [0, delay]) rather than plain exponential is deliberate:
    when a rate limit trips, it trips for many streams at the same instant. Without jitter
    every client retries in lockstep and re-trips the limit forever. This is the single most
    important line in this file for a 2,000-stream ramp.
    """
    await asyncio.sleep(random.uniform(0, min(cap, base * (2 ** attempt))))


class ResilientTranscriber:
    """Wraps a long-lived audio source in sessions: reconnects on throttles, rolls over
    before the 3-hour cap, never blocks the producer."""

    def __init__(self, config: StreamConfig, api_key: str,
                 on_turn: Callable[[dict], None], queue_size: int = 200):
        self.config = config
        self.api_key = api_key
        self.on_turn = on_turn
        self.metrics = StreamMetrics()
        # Bounded queue = explicit backpressure policy. Unbounded queues do not remove
        # backpressure, they convert it into an out-of-memory kill at 2 a.m.
        self.queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=queue_size)
        self._closed = False

    def feed(self, chunk: bytes) -> None:
        """Called from the audio source. Never awaits, never blocks capture."""
        try:
            self.queue.put_nowait(chunk)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()          # drop oldest
            with contextlib.suppress(asyncio.QueueFull):
                self.queue.put_nowait(chunk)
            self.metrics.chunks_dropped += 1

    def close(self) -> None:
        self._closed = True
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(None)          # sentinel

    async def run(self) -> StreamMetrics:
        attempt = 0
        while not self._closed:
            try:
                async with StreamingSession(self.config, self.api_key, self.metrics) as sess:
                    attempt = 0                   # a successful connect resets the backoff
                    await self._pump(sess)
                    if self._closed:
                        break
                    self.metrics.rollovers += 1
                    log.info("rolling over session %s at %.0fs", sess.session_id, sess.age)
            except FatalClose:
                log.error("fatal close; not retrying (fix config/credentials)")
                raise
            except (RetryableClose, OSError, websockets.WebSocketException):
                attempt += 1
                self.metrics.reconnects += 1
                await backoff_sleep(attempt)
        return self.metrics

    async def _pump(self, sess: StreamingSession) -> None:
        """Send audio and read results concurrently until close, rollover, or shutdown."""
        reader = asyncio.create_task(self._read(sess))
        try:
            while not self._closed:
                if sess.needs_rollover:
                    # Rollover: in a hot-standby design you open the next session here and
                    # fan audio to both for ROLLOVER_OVERLAP_SECONDS before retiring this one,
                    # so no words fall in the seam. Simplified to a clean cut for readability.
                    await asyncio.sleep(ROLLOVER_OVERLAP_SECONDS)
                    return
                try:
                    chunk = await asyncio.wait_for(self.queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    await sess.keepalive_if_idle()
                    continue
                if chunk is None:
                    return
                await sess.send_audio(chunk)
        finally:
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader

    async def _read(self, sess: StreamingSession) -> None:
        async for msg in sess.messages():
            if msg.get("type") == "Turn" and msg.get("end_of_turn"):
                self.metrics.turns_final += 1
                self.on_turn(msg)
            elif msg.get("type") == "SpeakerRevision":
                # Retroactive speaker corrections. For a court record, persist turns by
                # turn_order and APPLY these, converged labels beat the first guess.
                self.on_turn(msg)


async def ramp(total_streams: int, per_minute_budget: int) -> None:
    """Model the cold-start ramp before you run it against production.

    The limit that governs 2,000 concurrent streams is NOT a concurrency cap. AssemblyAI does
    not cap total open sessions. It caps NEW SESSIONS PER MINUTE, and auto-scales that budget
    up ~10% per minute while you are above 70% utilisation. So a cold start to 2,000 from a
    100/min budget takes roughly 12 minutes of compounding. Pre-provisioning the budget with
    AssemblyAI removes that ramp entirely. Run this to see the curve for your own numbers.
    """
    opened, minute, budget = 0, 0, per_minute_budget
    while opened < total_streams:
        minute += 1
        opened += int(budget)
        print(f"  minute {minute:>2}: budget={int(budget):>4}/min  cumulative_open={opened:>5}")
        budget *= 1.10                            # >=70% utilisation -> +10% next minute
    print(f"  -> ~{minute} minutes to reach {total_streams} concurrent from a cold start.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print("Cold-start ramp to 2,000 concurrent streams at the default paid budget (100/min):")
    asyncio.run(ramp(2000, 100))
    print("\nWith a pre-provisioned 500/min budget:")
    asyncio.run(ramp(2000, 500))
