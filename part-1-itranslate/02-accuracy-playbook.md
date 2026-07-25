# iTranslate: STT accuracy playbook

The direct answer to "how do we improve speech-to-text accuracy on our device."

Levers are ordered by expected return for this specific product. Every figure attributed to
AssemblyAI is from published documentation and benchmarks. None of it has been measured on
iTranslate's audio, which is the point of section 8.

---

## Summary

| # | Lever | Expected effect | Effort | Firmware change |
|---|---|---|---|---|
| 1 | Move to `universal-3-5-pro` | Large. 4.1% WER on AssemblyAI's streaming benchmark | One parameter | No |
| 2 | Send a context `prompt` | Up to 21% lower WER, 49% fewer errors on person names | Backend work | No |
| 3 | `voice_focus=near-field` | Large in noisy environments, which is where the device lives | One parameter | No |
| 4 | Pin `language_codes` and stop pinning a single language | Removes an entire error class | One parameter | Possibly |
| 5 | `keyterms_prompt` for known vocabulary | Strong on proper nouns and domain terms | Backend work | No |
| 6 | Fix the audio capture path | Removes silent, hard-to-diagnose failures | Firmware | Yes |
| 7 | Tune the endpointer per language | Fewer truncated turns | Tuning cycle | No |
| 8 | Choose `mode` deliberately | Trades latency against accuracy | One parameter | No |

Items 1 through 5, 7 and 8 are server-side. Given the architecture in
[the approach doc](01-approach.md), where connection parameters are returned by
`/v1/session`, they can all ship without a firmware release.

---

## 1. Move to Universal-3.5 Pro

`speech_model=universal-3-5-pro` (alias `u3-rt-pro`).

AssemblyAI reports 4.1% word error rate on their streaming benchmark and roughly 0.4 seconds to
first final result. It covers 18 languages with native mid-sentence code-switching.

It is also a prerequisite for several later items: `prompt`, `keyterms_prompt` and
`language_codes` are Universal-3.5 Pro features and are not available on the cheaper
multilingual model.

**Do not rely on the account default.** AssemblyAI's own documentation is inconsistent about
what an omitted `speech_model` resolves to, and defaults are grandfathered by account creation
date. Specify it explicitly on every connection, and log the `configuration` object returned in
the `Begin` message to confirm what the server actually applied.

Cost: ~$0.45 per hour of open connection, against ~$0.15 for the multilingual model. See the
cost section of the approach doc. This is the one lever with a real price attached.

---

## 2. Send a context prompt

`prompt=<natural language description, max 1750 characters>`

This is the highest-return item that requires actual work, and it is the one most integrations
never use.

The `prompt` parameter takes a plain description of the situation. The model uses it to weight
vocabulary that the context makes likely. The transcription instruction itself is built in, so
there is no prompt engineering to do: describe the situation, not the task.

AssemblyAI benchmarked this across 20,000 real calls:

| Prompt specificity | Word error rate | Errors on person names | Errors on place names |
|---|---|---|---|
| Domain, 2 to 5 words | −5% | −5% | −9% |
| Scenario, 5 to 15 words | −10% | −16% | −21% |
| Detailed, 20 to 50 words | **−21%** | **−49%** | **−44%** |

The name and place figures are the ones that matter for a translation device. A traveller's
speech is dense with exactly the words a general model gets wrong: street names, restaurant
names, dish names, the name of the person they are meeting.

**Why iTranslate is unusually well placed to exploit this.** A prompt is only as good as the
context behind it, and most integrations have none. A handheld device has:

- **GPS.** Reverse-geocode to a neighbourhood or venue. "Mercado de San Miguel, Madrid" is a
  strong signal for the food vocabulary about to be spoken.
- **A domain selector**, if the product has one. Travel, medical, business.
- **Conversation history.** What was said thirty seconds ago predicts what comes next.
- **User data.** Contacts, calendar, saved phrases, itinerary.

None of this requires the user to do anything. The backend assembles the prompt on every
session. Reference implementation: `buildPrompt()` in `demo/backend/src/server.ts` and
`DeviceContext` in `demo/device/translator.py`.

The model is trained to stay grounded in the audio, so context that turns out to be irrelevant
does not cause it to insert words that were not spoken. A stale or wrong prompt degrades
gracefully rather than producing hallucinated text.

---

## 3. Turn on voice focus

`voice_focus=near-field` and `voice_focus_threshold=0.7`

This isolates the primary speaker and suppresses background noise before the audio reaches the
recognition model.

`near-field` is the correct setting: it is intended for handsets, headsets and close-talking
microphones, which is exactly how a handheld translator is held. `far-field` is for conference
rooms and laptop microphones.

The relevance here is that iTranslate's device is used in the worst possible acoustic
environments. Airports, markets, train stations, restaurants, street corners. A meaningful
share of their accuracy problem is very likely environmental rather than linguistic, and this
lever addresses that directly while none of the others do.

`voice_focus_threshold` runs from 0.0 to 1.0, default 0.7, where higher suppresses more. Worth
sweeping during the pilot. Suppressing too aggressively can clip quiet speech, so this should
be measured rather than maximised.

---

## 4. Stop pinning a single language

`language_codes=en,es` and `language_detection=true`

If the device currently pins one language per session, it has an error class that has nothing
to do with acoustics: when the wrong language is selected, the model produces confident,
fluent, completely wrong output. That is worse than a low-confidence result, because nothing
downstream can detect it.

`language_codes` biases recognition toward the pair without preventing switching between them.
`language_detection=true` returns `language_code` and `language_confidence` on each turn, which
gives the device two things:

1. Which direction to translate, without asking the user
2. A confidence signal to act on when detection is uncertain

This is also the change that makes the language selector unnecessary. See section 1 of the
approach doc.

---

## 5. Keyterms prompting

`keyterms_prompt=<comma-separated list>`

An explicit vocabulary list, as opposed to the descriptive context of `prompt`. Limits for
streaming: **100 terms maximum, 50 characters per term.** Longer terms are ignored and
exceeding 100 returns an error.

Guidance from AssemblyAI:

- Use exact spelling and capitalisation as you want it to appear in output
- Include proper names, brands, technical terms and domain vocabulary
- **Avoid common words.** The model already handles them, and padding the list dilutes it

**Do not send `prompt` and `keyterms_prompt` together.** AssemblyAI advises against it
explicitly: combining them causes overprompting and unpredictable or degraded results. Pick
one. Both the demo device and the backend enforce this, defaulting to `prompt` and switching to
`keyterms_prompt` only when an explicit list is supplied.

For iTranslate, the natural source of keyterms is the user's own data: contacts, hotel name,
itinerary entries, saved phrases. That is a narrower and more reliable signal than a generic
travel vocabulary list.

**Which to choose.** The prompt benchmarks are stronger and the context is free to assemble, so
`prompt` should be the default. `keyterms_prompt` is the better tool when there is a short,
known, high-value vocabulary that must be exact, such as a medical device name or a specific
set of place names.

---

## 6. Fix the audio capture path

Less glamorous than the model levers and capable of undoing all of them.

| Requirement | Consequence of getting it wrong |
|---|---|
| Chunks between 50 and 1000 ms | Close code `3007`, session dies |
| Declared `encoding` matches the bytes actually sent | Connects, reports healthy, returns nothing |
| Send at real-time pace, never faster | Close code `3007`, transmission rate exceeded |
| Read a full chunk before sending | Short reads intermittently fall below 50 ms |
| Microphone buffer sized with headroom | Driver silently drops samples, words disappear |
| `KeepAlive` during silence | Close code `3006`, inactivity timeout |

The second row is the one to test explicitly. Declaring a compressed encoding while sending raw
PCM produces a session that connects normally and never returns a transcript, with no error at
any point. It is the hardest failure to diagnose from the client side. This is not
hypothetical: it is precisely what broke another AssemblyAI customer, documented in
`../part-2-spanglish/01-root-cause.md`, and it took weeks to identify.

If iTranslate adopts Opus for the bandwidth saving described in the approach doc, this becomes
the highest-risk change in the project and needs an integration test that asserts transcripts
actually arrive.

---

## 7. Tune the endpointer per language

`min_turn_silence` controls how long the model waits after speech stops before deciding the
turn has ended. Range 50 to 10000 ms.

Too low and the device interrupts people mid-sentence, producing truncated turns that
translate badly. Too high and the conversation feels sluggish. The effect on measured accuracy
is indirect but real: a truncated turn is a deletion in the word error rate, and it produces a
translation of half a thought.

Pause behaviour varies substantially by language and by speaker. A threshold tuned on English
speakers will cut off speakers of languages with different rhythm. **Tune per language pair
during the pilot** rather than shipping one global value.

Watch the deletion count in the benchmark output. A rising deletion rate with stable
substitutions usually means the endpointer, not the acoustic model.

---

## 8. Choose the mode deliberately

`mode` accepts `min_latency`, `balanced` (default) and `max_accuracy`.

The demo uses `min_latency`, on the reasoning that a conversation device should answer quickly
and recover accuracy through context rather than through decode time. That is a defensible
default and it is also a hypothesis, not a finding. It should be A/B tested against `balanced`
on real audio, measuring both word error rate and end-to-end latency, because the right answer
depends on how much the context levers in sections 2 and 5 are already recovering.

---

## 9. Measure it, do not assume it

Everything above is a hypothesis until it is measured on iTranslate's audio. Different corpora
rank these levers differently, and a device used mostly in quiet hotel lobbies will get a very
different result from one used mostly in markets.

`demo/bench/accuracy_bench.py` streams one audio file through each configuration in turn and
reports word error rate against a reference transcript, with the edit types broken out.

```bash
export ASSEMBLYAI_API_KEY=...
python3 demo/bench/accuracy_bench.py their_audio.wav reference.txt --pair en,es
```

Output:

```
config                  WER       vs baseline   1st final  detail
baseline_english_only    24.3%                    1.12s    S31 D12 I4
u3_5_pro                 11.8%     -51%           0.94s    S14 D6  I2
language_biased           9.1%     -63%           0.91s    S11 D5  I1
voice_focus               7.4%     -70%           0.93s    S9  D4  I1
prompt_detailed           5.9%     -76%           0.95s    S7  D3  I1
```

Those numbers are illustrative formatting, not results. I had no API key while building this,
so nothing here has been run against the live service.

**Read the edit types, not just the total.** They point at different causes:

- **Deletions** usually mean dropped audio or an endpointer cutting turns short. Look at
  section 6 and section 7.
- **Substitutions** usually mean vocabulary or accent. Look at sections 2 and 5.
- **Insertions** usually mean background noise being transcribed as speech. Look at section 3.

---

## 10. Suggested sequence

**Week 1.** Collect 20 to 50 real recordings including known failures. Human-transcribe them.
Establish the baseline. Without this number nothing later is provable.

**Week 2.** Server-side levers only, no firmware: model, `language_codes`, `voice_focus`,
`prompt`. Run the benchmark after each. Expect most of the total gain here.

**Week 3.** Endpointer and mode tuning per language pair. Add `keyterms_prompt` for one
vertical and compare against `prompt` on the same audio.

**Week 4.** Pilot on 1% of the fleet. Track word error rate, end-to-end latency, session
duration and cost per conversation together, because the last two move in the opposite
direction from the first two.

**Later, as its own project.** Opus encoding for the bandwidth and battery saving. Separate
change, separate measurement, and an integration test that asserts transcripts actually arrive.
