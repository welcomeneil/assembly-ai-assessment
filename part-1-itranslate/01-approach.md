# iTranslate: approach

How I would take this account from first call to production.

---

## 1. What they asked for, and what I think they actually need

iTranslate asked us to improve the speech-to-text accuracy of their handheld translator. That
is a real and solvable problem, and section 3 of the
[accuracy playbook](02-accuracy-playbook.md) addresses it directly.

There is a second opportunity in the brief that they have not asked about, and it is worth
more to them than a few points of word error rate.

Their device transcribes one person, translates, and speaks the result. For that to work with
a language-pinned recogniser, the device has to know which language is about to be spoken
before the person speaks. In practice that means a language selector: a button, a toggle, or a
per-speaker mode. Every handoff between two people is a manual step, and every mis-set toggle
produces a confidently wrong transcript rather than an error.

Universal-3.5 Pro switches languages natively inside a single session, mid-sentence, across 18
languages. `language_codes=en,es` biases toward the pair without preventing switching between
them, and `language_detection=true` reports which language each turn was so the device knows
which way to translate.

**The language selector can be removed.** Two people pick the device up and talk. That is a
product change, not a configuration change, and it is the demo I would lead with.

I want to be careful about one thing: I am inferring the language selector from the brief and
from how comparable devices work. I have not seen their firmware. The first question on the
call is what their current language handling actually does, and if I am wrong about this, the
accuracy work stands on its own.

---

## 2. Architecture

The binding constraint is that the device has no GPU and cannot run inference. Everything
except audio capture and playback is a network call. That is a good fit, not a compromise,
because it also means the entire pipeline can be tuned server-side without a firmware update.

```
   HANDHELD DEVICE                iTRANSLATE BACKEND              ASSEMBLYAI
   (no GPU, cellular)             (small, stateless)

   microphone
       |
       |  1. POST /v1/session  -------->  mint single-use token
       |                                  build context prompt
       |  <----- token + params --------  return connection params
       |
       |  2. audio over WebSocket  ------------------------->  Universal-3.5 Pro
       |                                                        streaming STT
       |  <---- Turn: transcript + language_code -------------
       |
       |  3. POST /v1/translate -------->  proxy to LLM Gateway  --->  Gemini / Claude / GPT
       |  <----- translated text --------  <-----------------------
       |
       |  4. events over WebSocket ----->  fan out to dashboards
       v                                            |
   TTS + speaker                                    v
   (iTranslate's existing TTS)               browser dashboard
                                             (read-only observer)
```

**Audio goes directly from device to AssemblyAI.** It does not pass through iTranslate's
backend. That keeps the backend small and cheap no matter how many devices are in the field,
and it removes a hop from the latency budget. The backend only handles session setup and
translation, which are two small JSON requests per conversation.

**The device holds no credentials.** A consumer handheld can be opened, its firmware dumped
and its traffic intercepted. An API key on the device is an API key on every device, and
revoking it bricks the fleet. Instead the backend mints a single-use streaming token valid for
60 seconds, and the device requests one immediately before it connects. There is nothing on
the device worth extracting.

**Connection parameters come from the server, not the firmware.** This matters more than it
looks. Firmware rolls out slowly across a consumer fleet, so anything baked into the device is
frozen for months. Returning the parameters from `/v1/session` means the model, the noise
settings and the turn-detection thresholds can be changed for every device at once, including
rolling a change out to 1% of the fleet first.

**Translation runs through the AssemblyAI LLM Gateway.** It is OpenAI-compatible, passes
provider pricing through with no markup, and routes to Gemini, Claude, GPT and others behind
one interface. Practically, it means iTranslate has one vendor, one key, one DPA and one region
setting for the whole pipeline, and they can change translation model without changing code.

**TTS stays theirs.** AssemblyAI does not do text to speech. iTranslate already has a TTS model
in the product, and the demo uses the macOS `say` command as a stand-in so it makes sound. That
is the seam where their engine drops in.

**The dashboard observes, it does not participate.** It subscribes to a small event stream the
device publishes and renders it. It holds no credentials and never contacts AssemblyAI. Two
reasons it exists. For this demo, a handheld conversation is invisible to everyone who is not
holding the device, and a customer needs to see the language detection happening rather than
be told about it. For iTranslate in production, the same event stream is what a support
engineer needs when a device in the field is misbehaving: which model was applied, what
confidence each turn came back with, and where the latency went.

---

## 3. Latency budget

A conversation device is judged on the gap between someone finishing a sentence and the device
speaking. Below about one second it feels like an interpreter. Above about two it feels like a
tool, and people start talking over it.

| Stage | Expected | Notes |
|---|---|---|
| Audio capture and chunking | 50 ms | One 50 ms chunk, the minimum the API accepts |
| Device to AssemblyAI over cellular | 20 to 80 ms | Varies with radio conditions |
| End of speech to final transcript | ~400 ms | Universal-3.5 Pro, published figure |
| Translation, LLM Gateway | 250 to 500 ms | Short conversational fragment, flash-tier model |
| TTS to first audio | 150 to 300 ms | iTranslate's existing engine |
| **Total** | **~0.9 to 1.3 s** | |

Three levers if that is not fast enough:

1. **Stream the translation.** The Gateway supports streamed responses. Starting TTS on the
   first complete clause rather than waiting for the full translation removes 150 to 300 ms.
   This is the cheapest win available.
2. **`mode=min_latency`.** Universal-3.5 Pro has three modes. The demo uses `min_latency`
   because a translation device should answer quickly and recover accuracy through context
   instead of decode time. Worth A/B testing against `balanced`.
3. **Tune the endpointer.** `min_turn_silence` controls how long the model waits before
   deciding a turn is over. Lowering it cuts latency and raises the risk of cutting people
   off mid-sentence. This should be tuned per language, because pause behaviour differs.

One thing I would not do: translate partial transcripts speculatively. It sounds like it should
help, but partials are revised as more audio arrives, so you either speak a translation of text
the model then corrects, or you buffer it and gain nothing.

---

## 4. Bandwidth and battery

This device is battery-powered and cellular, which makes the audio format a hardware decision
rather than a formatting detail.

| Format | Bitrate | Per hour of open connection |
|---|---|---|
| `pcm_s16le` at 16 kHz | 256 kbit/s | ~115 MB |
| `opus` at 24 kbit/s | 24 kbit/s | ~11 MB |

That is roughly a tenfold reduction. On a metered cellular plan it is the difference between a
device people use freely and a device people ration. The radio is also one of the largest power
draws in a handheld, and less data sent means less transmit time.

AssemblyAI accepts `encoding=opus` for raw Opus packets and `encoding=ogg_opus` for Ogg-framed
streams, so this is supported natively.

Two things to get right, both of which are the exact failure mode from the Spanglish
escalation in Part 2:

- With `encoding=opus`, **every binary WebSocket message must contain exactly one Opus packet.**
  Not a buffer of packets, not a partial packet.
- **`sample_rate` is ignored for Opus and AAC.** Those formats describe their own rate. Sending
  it is harmless but misleading.

Declaring a compressed encoding while sending raw PCM produces a session that connects
normally, reports healthy, and returns nothing. It is the single hardest failure to diagnose
from the client side, and it is worth an explicit integration test.

The cost is CPU on the device to run the Opus encoder. Opus was designed for exactly this class
of hardware and runs comfortably on an ARM application processor without acceleration, but the
encode time and power draw should be measured on their actual silicon before committing.

**My recommendation:** start the pilot on `pcm_s16le` so audio format is not a variable while
accuracy is being tuned, then move to Opus as a separate change with its own measurement.

---

## 5. Cost

Streaming is billed on **how long the WebSocket stays open, not how much audio is sent**. An
idle connection costs the same as an active one.

For a handheld translator this is the dominant cost decision, because usage is bursty. People
have a 40-second exchange, then walk for ten minutes, then have another one. If the device
holds a session open for the whole outing, iTranslate pays for the walking.

| Model | Rate | Languages |
|---|---|---|
| `universal-3-5-pro` | ~$0.45 per hour | 18, native mid-sentence switching |
| `universal-streaming-multilingual` | ~$0.15 per hour | 6: en, es, de, fr, pt, it |
| `universal-streaming-english` | ~$0.15 per hour | English only |

Illustrative scale, using round numbers rather than their real fleet size:

| Session policy | Open time per device per day | 100,000 devices, `u3-5-pro` |
|---|---|---|
| Open on wake, close after 20 s of silence | ~10 min | ~$7,500 per day |
| Open for the whole outing | ~60 min | ~$45,000 per day |

Same conversations, six times the bill. The session policy is worth more engineering attention
than the model choice.

**Recommendation:** open the session when the user wakes the device or when on-device voice
activity detection fires, hold it open through an active conversation, and close it after a
short silence timeout. Reconnecting costs a 200 to 400 ms handshake, which is acceptable
between conversations and not acceptable mid-conversation.

**On model choice:** `universal-streaming-multilingual` is a third of the price and covers six
languages including English and Spanish. It switches language per turn rather than
mid-sentence, and it does not support `prompt` or `keyterms_prompt`, which are the two largest
accuracy levers in the playbook. For a device whose entire value proposition is handling two
people talking naturally, I would expect Universal-3.5 Pro to win. But that is a claim to
verify on their audio, not to assert. The benchmark harness in `demo/bench/` exists to settle
it.

---

## 6. How I would prove it

Nothing above should be taken on faith, including by iTranslate.

**Step 1: get their audio.** Twenty to fifty recordings from real devices in real conditions.
Airports, markets, restaurants, street noise. Not clean studio samples. Ask specifically for
recordings where their current system failed.

**Step 2: establish a baseline.** Run their current configuration and measure word error rate
against human transcripts. Without this number, every later claim is unfalsifiable.

**Step 3: add one lever at a time.** `demo/bench/accuracy_bench.py` runs the same audio through
each configuration in sequence and reports the word error rate delta and the edit-type
breakdown. Ranking will differ by corpus, which is why they should run it on their own audio
rather than accept a number from us.

**Step 4: pilot on real hardware.** Server-side parameters mean a pilot can run on 1% of the
fleet without a firmware release. Watch word error rate, end-to-end latency, session duration
and cost per conversation.

**Step 5: expand the language matrix.** Universal-3.5 Pro covers 18 languages. Each new pair
needs its own endpointer tuning, because pause behaviour varies by language and a threshold
tuned on English will cut off speakers of other languages.

---

## 7. Risks and open questions

| Item | Why it matters | How to resolve |
|---|---|---|
| Their current language handling | The language-selector removal is the headline, and it is an inference | Ask on the first call |
| Language coverage beyond 18 | Universal-3.5 Pro covers 18 languages. If they sell 40 pairs, some are not covered by streaming | Get their actual language matrix, check async or another path for the tail |
| Opus encode cost on their silicon | Determines whether the tenfold bandwidth saving is free or expensive | Measure on real hardware before committing |
| Endpointer tuning per language | A single threshold across all languages will cut off some speakers | Tune per pair during the pilot |
| Data residency | The default endpoint edge-routes and gives no residency guarantee. Consumer voice data across borders is a live regulatory issue | Pin `streaming.us.` or `streaming.eu.` per market from day one |
| Retention | Consumer conversations, potentially medical or legal in content | Streaming offers zero retention of audio and transcripts when the account is opted out of model training. Confirm contractually |
| Offline behaviour | No GPU means no fallback. What does the device do with no signal? | Product decision, but worth raising before they discover it in reviews |

---

## 8. What I would send after the first call

1. This document, with the language-selector question answered rather than assumed
2. A benchmark run on **their** audio, not mine, with the baseline included
3. A latency measurement from real hardware on cellular, not from a laptop on wifi
4. A cost model using their actual fleet size and session policy
5. A pilot plan scoped to one language pair and one market
