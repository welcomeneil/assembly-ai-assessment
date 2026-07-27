# How I would approach this

**This is the documentation the brief asked for.** It covers the whole use case: the problem,
the design, the numbers, how to prove it, and what could go wrong.

Two related documents:

- [00-demo-brief.md](00-demo-brief.md) is the sales version, for the account executive.
- [02-accuracy-playbook.md](02-accuracy-playbook.md) is the accuracy detail, ranked by return.

---

## The whole thing in one table

| Question | Answer |
|---|---|
| What did they ask for? | Better speech-to-text accuracy |
| What do they need more? | To delete the language button on the device |
| Can we do it? | Yes. Universal-3.5 Pro detects language per turn and switches mid-sentence |
| Where does the audio go? | Device straight to AssemblyAI. Not through their servers |
| Where does the API key live? | Their server, never the device. Device gets a 60-second token |
| How fast? | About 0.9 to 1.3 seconds, end to end |
| Biggest accuracy win? | Send a description of the situation. 21% fewer word errors, 49% fewer name errors |
| Biggest cost decision? | When the device hangs up. Worth 6x. Bigger than model choice |
| Biggest bandwidth win? | Opus. 115 MB per hour down to 11 MB |
| What do we do first? | Benchmark their real audio. Everything else is a claim until then |

---

## 1. The problem

They asked for better accuracy. Real problem, we solve it, see the
[playbook](02-accuracy-playbook.md).

But there is a bigger one they did not ask about.

**Speech recognition normally has to be told the language before you talk.** For a translator
that means a button. Every time the conversation changes hands, somebody presses something.

When the button is wrong, the device does not error. It confidently transcribes the wrong
thing, translates the wrong thing, and says the wrong thing out loud. Neither person can tell,
because neither can read the other's language.

**Caveat:** I am inferring the button from the brief and from how similar devices work. I have
not seen their firmware. First question on the call. If I am wrong, the accuracy work still
stands.

---

## 2. The fix

Universal-3.5 Pro does not need to be told. Three settings:

| Setting | Value | What it does |
|---|---|---|
| `speech_model` | `universal-3-5-pro` | The only model that switches language mid-sentence |
| `language_codes` | `en,es` | Bias toward the pair, without blocking switches between them |
| `language_detection` | `true` | Tags every turn with the language it was spoken in |

The tag is how the device knows which way to translate. Nobody selects anything.

Covers 18 languages inside one connection.

**The button comes off.** That is a product change, not a config change.

---

## 3. Architecture

The device has no GPU. So everything except capture and playback is a network call.

That is a good fit, not a compromise: it means the whole pipeline can be tuned from a server
without shipping firmware.

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

### Five decisions, and why

**Audio goes device to AssemblyAI directly.**
Not through their backend. Their backend stays small no matter how many devices they sell, and
we drop a hop from the latency budget. Their servers handle two small JSON requests per
conversation and nothing else.

**No API key on the device.**
A handheld can be opened and its firmware read. A key on one device is a key on every device,
and revoking it bricks the fleet. Their server mints a token that works once and expires in 60
seconds. The device asks for one right before it connects.

**Settings come from the server, not the firmware.**
This matters more than it looks. Firmware takes months to reach a consumer fleet, so anything
baked into the device is frozen. Returning settings from `/v1/session` means they can change
the model, the noise handling and the turn thresholds for every device at once, or for 1%
first.

**Translation goes through the AssemblyAI LLM Gateway.**
OpenAI-compatible, routes to Gemini, Claude and GPT, no markup on provider pricing. One vendor,
one key, one DPA, one region setting for the whole pipeline. Changing translation model is a
config change.

**TTS stays theirs.**
We do not do text to speech. They already have an engine. The demo uses the macOS `say` command
so it makes noise. That is where their engine drops in.

### Why there is a dashboard

A handheld conversation is invisible to anyone not holding the device. For a demo, the customer
needs to watch the language detection happen, not be told about it.

In production the same event stream is what a support engineer wants when a device misbehaves
in the field: which model was applied, the confidence on each turn, and where the latency went.

The dashboard only observes. No credentials, never talks to AssemblyAI.

---

## 4. Speed

Judged on the gap between someone finishing a sentence and the device speaking.

- Under 1 second feels like an interpreter.
- Over 2 seconds feels like a tool, and people talk over it.

| Stage | Expected |
|---|---|
| Capture and chunk | 50 ms |
| Device to AssemblyAI over cellular | 20 to 80 ms |
| End of speech to final transcript | ~400 ms |
| Translation | 250 to 500 ms |
| First audio out | 150 to 300 ms |
| **Total** | **0.9 to 1.3 s** |

### If that is not fast enough

1. **Stream the translation.** Start speaking on the first complete clause instead of waiting
   for the whole thing. Saves 150 to 300 ms. Cheapest win available.
2. **`mode=min_latency`.** Three modes exist. The demo uses this one, on the theory that a
   conversation device should answer fast and get accuracy back from context rather than decode
   time. Worth A/B testing against `balanced`.
3. **Tune the endpointer.** `min_turn_silence` sets how long the model waits before calling a
   turn finished. Lower is faster and cuts people off more. Tune per language, because pause
   habits differ.

### One thing I would not do

**Do not translate partial transcripts.** It sounds like free speed. It is not. Partials get
revised as more audio arrives. So either the device speaks a translation the model then
corrects, and cannot unsay it, or you buffer it and gain nothing.

---

## 5. Bandwidth and battery

Battery-powered and cellular. So the audio format is a hardware decision, not a formatting
detail.

| Format | Bitrate | Per hour of connection |
|---|---|---|
| `pcm_s16le` at 16 kHz | 256 kbit/s | ~115 MB |
| `opus` at 24 kbit/s | 24 kbit/s | ~11 MB |

**Roughly ten times less data.** On a metered plan that is the difference between a device
people use freely and one they ration. The radio is also a top power draw, so less data means
less transmit time means longer battery.

We support Opus natively: `encoding=opus` for raw packets, `encoding=ogg_opus` for Ogg-framed.

### Two ways to get this wrong

Both are the exact failure from the Spanglish escalation in Part 2.

- With `encoding=opus`, **one Opus packet per binary message.** Not a buffer of packets. Not
  part of one.
- **`sample_rate` is ignored for Opus and AAC.** Those formats carry their own rate. Sending it
  is harmless but misleading.

Declaring a compressed format while sending raw audio gives you a session that connects,
reports healthy, and returns nothing. Hardest failure to diagnose from the client side. Give it
its own integration test.

### Recommendation

Start the pilot on `pcm_s16le`. Do not make audio format a variable while accuracy is being
tuned. Move to Opus afterward as its own change with its own measurement.

Cost of Opus is CPU to encode. Opus was designed for this class of hardware and runs fine on an
ARM application processor. Measure it on their actual silicon before committing.

---

## 6. Cost

**We bill on how long the connection stays open, not how much audio goes through it.** An idle
connection costs the same as a busy one.

That makes this the dominant cost decision for a handheld, because usage is bursty. A 40-second
exchange, then ten minutes of walking, then another exchange. Hold the session open through the
walk and they pay for the walk.

| Model | Rate | Languages |
|---|---|---|
| `universal-3-5-pro` | ~$0.45/hr | 18, switches mid-sentence |
| `universal-streaming-multilingual` | ~$0.15/hr | 6: en, es, de, fr, pt, it |
| `universal-streaming-english` | ~$0.15/hr | English only |

Illustrative, using round numbers rather than their real fleet:

| Session policy | Open time per device per day | 100,000 devices |
|---|---|---|
| Close after 20 s of silence | ~10 min | ~$7,500/day |
| Hold open for the whole outing | ~60 min | ~$45,000/day |

**Same conversations. Six times the bill.** Session policy deserves more engineering attention
than model choice.

### Recommendation

Open the session when the user wakes the device or when on-device voice detection fires. Hold
it through an active conversation. Close it after a short silence timeout.

Reconnecting costs a 200 to 400 ms handshake. Fine between conversations. Not fine
mid-conversation.

### On the cheaper model

`universal-streaming-multilingual` is a third of the price and covers English and Spanish.

But it switches language per turn, not mid-sentence, and it does not support `prompt` or
`keyterms_prompt`. Those are the two biggest accuracy levers in the playbook.

For a device whose whole value is two people talking naturally, I expect Universal-3.5 Pro
wins. **That is a claim to verify on their audio, not to assert.** The benchmark harness exists
to settle it.

---

## 7. Accuracy

Full detail in the [playbook](02-accuracy-playbook.md). The short version:

| Lever | Effort | Expected return |
|---|---|---|
| Context prompt from GPS, topic and itinerary | Low, server-side only | 21% fewer word errors, 49% fewer name errors |
| `universal-3-5-pro` instead of the default | One parameter | Mid-sentence switching, better baseline |
| `voice_focus=near-field` | One parameter | Isolates the speaker in noisy places, no device battery cost |
| `language_codes` biasing | One parameter | Fewer confusions between the two languages in play |
| `keyterms_prompt` | Low | Better on a fixed vocabulary list. Do not combine with `prompt` |
| Endpointer tuning | Medium, needs measurement | Fewer cut-off sentences |

The first one is the largest and almost nobody turns it on. The device already knows where it
is, what it is being used for, and what was said thirty seconds ago. It can build that
description automatically every session. The user types nothing.

---

## 8. How to prove it

Nothing above should be taken on faith, including by them.

| Step | What happens | Why |
|---|---|---|
| 1 | Get 20 to 50 real recordings, with what was actually said | Airports and markets, not studio samples. Ask specifically for the failures |
| 2 | Measure their current setup | Without a baseline every later claim is unfalsifiable |
| 3 | Add one lever at a time | `demo/bench/accuracy_bench.py` does this and reports the delta |
| 4 | Pilot on 1% of the fleet | Server-side settings mean no firmware release. Watch accuracy, latency, session length, cost per conversation |
| 5 | Expand the language matrix | Each new pair needs its own endpointer tuning. Pause habits differ by language |

The benchmark reports substitutions, deletions and insertions separately, not just one word
error rate. That split tells you where to work:

- **Deletions** point at the endpointer cutting people off.
- **Substitutions** point at vocabulary.
- **Insertions** point at background noise.

Ranking will differ on their corpus. That is the point. They should run it on their audio
rather than accept a number from us.

---

## 9. Risks

| Risk | Why it matters | How to resolve |
|---|---|---|
| The language button might not exist | The headline claim is an inference | Ask on the first call |
| Languages beyond 18 | Streaming covers 18. If they sell 40 pairs, the tail is uncovered | Get their real language matrix, find another path for the tail |
| Opus encode cost on their chip | Decides whether the 10x bandwidth saving is free or expensive | Measure on real hardware |
| Endpointer tuned once for all languages | Will cut off speakers of some languages | Tune per pair during the pilot |
| Data residency | The default endpoint edge-routes with no residency guarantee. Consumer voice across borders is a live regulatory issue | Pin `streaming.us.` or `streaming.eu.` per market from day one |
| Retention | Consumer conversations, sometimes medical or legal | Streaming keeps no audio or transcripts when opted out of training. Confirm in the contract |
| No offline fallback | No GPU means nothing works without signal | Product decision, but raise it before they find it in reviews |

---

## 10. What I send after the first call

1. This document, with the language-button question answered instead of assumed
2. A benchmark on **their** audio, baseline included
3. A latency measurement from real hardware on cellular, not a laptop on wifi
4. A cost model using their actual fleet size and session policy
5. A pilot plan scoped to one language pair and one market

---

## What was verified and what was not

**Ran locally:** the backend builds and serves, TypeScript typechecks strict, the dashboard
event stream works end to end, the Python compiles.

**Not run:** nothing has touched the live AssemblyAI API. No key was available. Every parameter,
limit and rate here comes from AssemblyAI's published documentation.

**Not measured:** the latency figures are published ranges, not observations. The scripted
conversation in the dashboard is written, not recorded, and says so on screen.

The benchmark harness exists so their numbers replace mine.
