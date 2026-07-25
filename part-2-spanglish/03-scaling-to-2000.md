# Scaling to 2,000 concurrent streams. Spanglish Inc.

> Customer-facing. Attach to the email in [`02-customer-email.md`](02-customer-email.md).

---

## The one thing to internalise first

**AssemblyAI does not cap the number of concurrent streaming sessions.** There is no ceiling at
2,000, or at any number. Nothing needs to be "unlocked" for you to run 2,000 streams at once.

What is governed is **how many *new* sessions you can open per minute**, and that budget
auto-scales:

| Utilisation of your per-minute budget | What happens next minute |
|---|---|
| ≥ 70% | Budget increases ~10% |
| 50–69% | Unchanged |
| < 50% | Scales back toward your account's baseline |

Defaults: **5 new sessions/min** on free, **100+/min** on paid. Exceed it and the connection is
refused with close code **`3009`, "Unauthorized Connection: Too many concurrent sessions."**
The wording says "concurrent," but the limit being enforced is the new-session rate.

This changes the shape of your problem entirely. **Your steady state is easy. Only your cold
start is hard.**

---

## 1. Model your actual load before you provision anything

The number that matters is not peak concurrency, it's **session churn**:

```
new sessions per minute  =  concurrent streams ÷ average session length in minutes
```

| Scenario | Concurrent | Avg session | New sessions/min | Inside a 100/min budget? |
|---|---|---|---|---|
| Long hearings | 2,000 | 120 min | ~17 | Yes, comfortably |
| Typical mixed docket | 2,000 | 30 min | ~67 | Yes |
| Short depositions | 2,000 | 10 min | 200 | **No, pre-provision** |
| Cold start (all at once) | 0 → 2,000 | n/a | *see below* | **No, this is the real constraint** |

Long court proceedings are the friendliest possible workload here: high concurrency, very low
churn. If your average session is 30+ minutes, steady state at 2,000 streams needs no special
handling at all.

## 2. The cold start is your only genuine constraint

Docket start at 9:00 a.m. is the worst case: near-zero streams, then everything at once.
Modelled with the +10%/min auto-scale (run it yourself:
`python3 code/python/production_client.py`):

**Default paid budget, 100/min:**

```
minute  1: budget= 100/min  cumulative_open=  100
minute  3: budget= 121/min  cumulative_open=  331
minute  6: budget= 161/min  cumulative_open=  771
minute  9: budget= 214/min  cumulative_open= 1356
minute 12: budget= 285/min  cumulative_open= 2135   <- ~12 minutes to 2,000
```

**Pre-provisioned 500/min budget:**

```
minute  1: budget= 500/min  cumulative_open=  500
minute  2: budget= 550/min  cumulative_open= 1050
minute  4: budget= 665/min  cumulative_open= 2320   <- ~4 minutes to 2,000
```

**Action:** tell us your target concurrency and go-live date and we'll raise your baseline
before you need it. Custom rate limits carry **no additional cost**. Contact your AE or
support@assemblyai.com; give them your peak concurrency, expected average session length, and
your ramp window.

## 3. Two things you must build before you ramp

### 3a. Retry `3009` with backoff **and jitter**

Non-negotiable. When a rate limit trips, it trips for many streams in the same instant. Without
jitter every client retries in lockstep and re-trips the limit indefinitely, a brief throttle
becomes a self-inflicted outage.

```python
async def backoff_sleep(attempt, base=0.5, cap=30.0):
    # FULL jitter: uniform in [0, delay], not delay ± noise.
    await asyncio.sleep(random.uniform(0, min(cap, base * (2 ** attempt))))
```

Which codes to retry, and which not to:

| Code | Meaning | Retry? |
|---|---|---|
| `3009` | New-session rate limit | **Yes**, backoff + jitter |
| `1011` | Server-side internal error | Yes, backoff |
| `3005` | Session cancelled, catch-all server error | Yes, backoff |
| `1006` | Abnormal close (network) | Yes, backoff |
| `3008` | 3-hour session cap | Yes, but as a *rollover*, see below |
| `1008` | Unauthorized / account issue | **No.** Retrying burns rate budget and never succeeds |
| `3006` | Invalid message or inactivity timeout | **No.** Fix the client |
| `3007` | Chunk duration or transmission rate violation | **No.** Fix the client |

Reset the attempt counter on a *successful connect*, not on a successful send.

### 3b. Session rollover before the 3-hour cap

**Sessions hard-close at 3 hours with code `3008`.** Court proceedings routinely run longer.
Do not let the server pick that moment for you.

Roll over on your own schedule, open the next session at ~2h58m, fan audio to both sockets for
a couple of seconds, then retire the old one. The overlap is what keeps words from falling into
the seam. Reference implementation:
[`code/python/production_client.py`](code/python/production_client.py) (`ROLLOVER_AT_SECONDS`).

Stitch the two transcripts on your side using `turn_order` plus wall-clock offsets. Expect a
small chance of a duplicated turn at the boundary; de-duplicate on text + timestamp.

## 4. Client architecture at 2,000 streams

**One WebSocket per audio stream.** There is no multiplexing and you should not build one.

**Do not use thread-per-stream.** 2,000 JVM threads is 2,000 stacks and a scheduler that spends
its time context-switching. Use async I/O:

- **Python:** `asyncio` + `websockets`. Budget ~250–400 streams per process and run multiple
  processes to get past the GIL. 2,000 streams ≈ 6–8 processes.
- **Java:** Netty or the JDK 11+ `HttpClient` WebSocket, not `Java-WebSocket` thread-per-client.
  On JDK 21+, virtual threads make the simple blocking model viable again, worth benchmarking
  before you invest in a rewrite.
- **Node/TypeScript:** `ws` on a handful of processes behind a supervisor.

**Bound your queues.** Every stream needs a fixed-size buffer between audio capture and the
socket, with an explicit drop policy and a counter. An unbounded queue does not remove
backpressure, it converts it into an OOM kill at 2 a.m. Drop oldest, increment a metric, alert
on the rate.

**Spread across processes and hosts.** Don't put 2,000 streams behind one process, one NIC, or
one NAT gateway. Ephemeral port exhaustion is a real failure at this scale.

**Separate API keys per environment.** Prod, staging, and load tests must not share a rate
budget. A load test should never be able to throttle a live hearing.

## 5. Reliability

**Use streaming webhooks for durable transcript delivery.** Add `webhook_url` to the connection
and we POST the complete finalised transcript when the session ends. This decouples your system
of record from the live socket, if a UI process dies mid-hearing you still get the transcript.
Retries up to 10 times; your endpoint must return 2xx within 10 seconds; 4xx suppresses retries.
Source IPs are fixed (`44.238.19.20` US, `54.220.25.36` EU) if you need firewall rules.

**Enable `session_heartbeat=true`.** You get a liveness message every 5 seconds carrying
`realtime_factor`, the earliest signal that a stream is falling behind.

**Send `KeepAlive` during silence.** Recesses and sidebars produce long silences; without
KeepAlive an inactivity timeout closes the session with `3006`.

**Log the `Begin` message for every session.** Two fields matter:
- `id`, the session ID. This is the correlation ID our support team needs. A bug report
  without it is close to unactionable.
- `configuration`, the settings we *actually applied*. Assert it matches what you requested.
  Logging this from day one would have surfaced the English-only model issue in the first
  200 ms of your first test run instead of weeks later.

**Pin your Data Zone.** `streaming.us.assemblyai.com` or `streaming.eu.assemblyai.com` guarantee
regional residency. The bare `streaming.assemblyai.com` host edge-routes for lowest latency and
gives **no residency guarantee**, for court audio, take the few milliseconds and pin the zone.

## 6. Cost, please read before go-live

**Streaming is billed on WebSocket open-to-close duration, not on audio sent.** A socket that is
open and silent bills identically to one carrying speech.

At 2,000 concurrent streams:

| Model | Rate | 2,000 streams | 8-hour court day |
|---|---|---|---|
| `universal-3-5-pro` | ~$0.45/hr | ~$900/hr | ~$7,200 |
| `universal-streaming-multilingual` | ~$0.15/hr | ~$300/hr | ~$2,400 |
| `universal-streaming-english` | ~$0.15/hr | n/a | not viable for you |

**A 3× cost decision sits in one query parameter.** Both `universal-3-5-pro` and
`universal-streaming-multilingual` handle English + Spanish. The Pro model has stronger
mid-sentence code-switching (18 languages vs 6), lower latency, and supports `keyterms_prompt`
and `prompt`. The multilingual model switches per turn rather than mid-sentence.

**Recommendation:** benchmark both on your own courtroom audio before committing. Interpreter
speech with dense mid-utterance switching is where the Pro model earns its premium, but that's
a claim you should verify on your data, not accept from a doc. Send us 10–20 representative
recordings and we'll run the comparison with you. If the multilingual model holds up on your
audio, that's ~$4,800/day back.

**Three cost controls to build in now:**

1. **Close sockets immediately** at recess and adjournment. Do not hold them open "just in
   case."
2. **Never let a session reach the 3-hour timeout by accident**, an abandoned socket bills for
   the full 3 hours. Roll over deliberately (§3b) and terminate deliberately.
3. **Alert on open-socket-seconds vs. audio-seconds.** A widening gap is a leak, and at 2,000
   streams a leak is expensive within hours.

## 7. Pre-go-live checklist

- [ ] Peak concurrency, average session length, and ramp window shared with AssemblyAI
- [ ] Rate budget pre-provisioned for your cold start
- [ ] Backoff **with jitter** implemented; non-retryable codes explicitly not retried
- [ ] Session rollover implemented and tested past the 3-hour boundary
- [ ] Bounded queues with drop counters and alerts
- [ ] `Begin.configuration` asserted against requested parameters on every session
- [ ] Data Zone endpoint pinned (`streaming.us.` / `streaming.eu.`)
- [ ] Webhooks configured for durable transcript delivery
- [ ] Separate API keys for prod / staging / load test
- [ ] Load test as a **ramp**, not a step, a step function tests our throttle, not your system
- [ ] Cost alerting on open-socket-seconds
- [ ] Model choice validated on your own bilingual audio

---

**Load-test with us, not at us.** Tell us the window and we'll watch it from our side in real
time. A coordinated ramp finds problems in an hour that an uncoordinated one turns into a
support ticket.
