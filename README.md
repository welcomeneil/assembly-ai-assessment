# AssemblyAI Applied AI Engineering Take-Home

**Loom walkthrough:** [add link here]

Two parts, both complete.

- **[Part 1: iTranslate demo](part-1-itranslate/)**, build a demo and document the approach for
  a handheld translation device that needs better speech-to-text accuracy.
- **[Part 2: Spanglish Inc.](part-2-spanglish/)**, a production customer says streaming
  "doesn't work at all." Fix it, explain it, and scale them to 2,000 streams.

---

## Part 1: iTranslate demo

**The ask.** A handheld translator with no GPU but with wifi and cellular. It transcribes
speech, translates it, and speaks the result. They want better transcription accuracy.

**What I found.** They asked for accuracy. The bigger opportunity is that their device needs a
language button, because a language-pinned recognizer has to be told what's coming before
someone speaks. Universal-3.5 Pro switches languages mid-sentence inside one session, so the
button can go away. Two people just pick it up and talk.

**The largest accuracy lever is one almost nobody turns on.** Sending the model a description of
the situation cuts word error rate 21% and errors on people's names 49%, per AssemblyAI's own
benchmark. A handheld knows its GPS location, the selected topic, and what was said 30 seconds
ago, so it can build that description automatically on every session.

| Deliverable | File |
|---|---|
| **Dashboard**, the screen you put in front of the customer | [index.html](part-1-itranslate/demo/dashboard/index.html) |
| Approach: architecture, latency, bandwidth, cost, rollout | [01-approach.md](part-1-itranslate/01-approach.md) |
| Accuracy playbook: 8 levers ranked by return | [02-accuracy-playbook.md](part-1-itranslate/02-accuracy-playbook.md) |
| Token broker, translation proxy and event bus (TypeScript) | [server.ts](part-1-itranslate/demo/backend/src/server.ts) |
| Device simulator (Python) | [translator.py](part-1-itranslate/demo/device/translator.py) |
| Accuracy benchmark harness (Python) | [accuracy_bench.py](part-1-itranslate/demo/bench/accuracy_bench.py) |

**The dashboard runs with no API key.** `npm install && npm run build && npm start`, open
http://localhost:8787, press Play. It plays a scripted bilingual conversation and shows the
language being detected per turn, where the latency goes, the exact parameters the device sent,
and a live billing meter. A banner says the data is scripted. With a key, the same dashboard
shows a real session.

Two things they didn't ask about: streaming bills on **connection time, not audio sent**, which
at fleet scale is a 6x cost difference depending on session policy. And Opus encoding cuts
bandwidth about **tenfold**, which matters a lot on a battery-powered cellular device.

---

## Part 2: Spanglish Inc. critical issue

**The situation.** A production customer building bilingual court transcription reported that
our streaming product "doesn't work at all." They sent a Java code snippet and nothing else.
Engineering suspected a bug on our side.

**The finding.** No bug on our side. Their client had four separate problems, and any one of
them alone would break the stream.

| Problem | What happens |
|---|---|
| The file doesn't compile | `main()` creates a class that doesn't exist |
| Wrong audio format declared | Says "compressed audio," sends raw audio. Connects fine, returns nothing, no error |
| Audio chunks too small | 25ms sent, 50ms minimum required. Server closes with code 3007 |
| No language model specified | Bilingual customer left on a default they never chose |

**The bigger issue.** Their code was throwing away every error message we sent. That's why the
report had no detail. They weren't being unhelpful, they genuinely couldn't see anything.

### The five deliverables

| # | What was asked for | File |
|---|---|---|
| 1 | Fixed code with comments explaining changes | [Spanglish.java](part-2-spanglish/code/java/src/main/java/com/assemblyai/Spanglish.java) |
| 2 | Customer email + how to scale to 2,000 streams | [Email](part-2-spanglish/02-customer-email.md) · [Scaling guide](part-2-spanglish/03-scaling-to-2000.md) |
| 3 | Data privacy and retention answers | [Privacy doc](part-2-spanglish/04-data-privacy.md) |
| 4 | Internal engineering summary | [Internal summary](part-2-spanglish/05-internal-eng-summary.md) |
| 5 | Handoff for the returning colleague | [Handoff](part-2-spanglish/06-handoff.md) |

### Supporting work

| File | What it is |
|---|---|
| [01-root-cause.md](part-2-spanglish/01-root-cause.md) | Full analysis. All 23 defects found, not just the 4 blockers |
| [repro.py](part-2-spanglish/code/python/repro.py) | Runs the same audio 4 ways: broken, each fix, working |
| [production_client.py](part-2-spanglish/code/python/production_client.py) | Reference client for running 2,000 streams |
| [reference/original/](part-2-spanglish/reference/original/) | The customer's file as received, for comparison |

---

## Running the code

### Part 1

**The dashboard, no API key needed.** This is the one to run first.

```bash
cd part-1-itranslate/demo/backend
npm install
npm run build && npm start
# open http://localhost:8787 and press "Play sample conversation"
```

**Live, with a key.** Start the backend as above with `ASSEMBLYAI_API_KEY` set, then in a
second terminal point the device simulator at it. The dashboard updates as it runs.

```bash
cd part-1-itranslate/demo/device
pip install -r requirements.txt
export ASSEMBLYAI_API_KEY=your_key

# no microphone needed, reuses the bilingual sample from Part 2
python3 translator.py --pair en,es --dashboard \
  --file ../../../part-2-spanglish/code/python/sample_bilingual.wav
```

### Part 2

**See the original fail, then see the fix compile:**

```bash
cd part-2-spanglish
./code/java/build.sh original    # 2 compile errors, on purpose
./code/java/build.sh             # compiles clean
```

**Run the four-way comparison** (needs an API key):

```bash
cd part-2-spanglish/code/python
pip install -r requirements.txt
./make_sample.sh                              # builds a 24s English/Spanish test clip (macOS)
export ASSEMBLYAI_API_KEY=your_key
python3 repro.py sample_bilingual.wav
```

**See the scaling math:**

```bash
python3 part-2-spanglish/code/python/production_client.py
```

---

## What I verified vs. what I inferred

Being upfront about this because it affects how much weight to put on each claim.

**Actually ran:**
- The original file does not compile. JDK 19, two errors. Output saved in
  [reference/](part-2-spanglish/reference/javac-original-output.txt)
- The fixed file compiles clean with all warnings enabled
- The scaling math, which produced the 12-minute and 4-minute ramp numbers
- The test audio generator

**Did not run:** I had no API key, so nothing was tested against the live AssemblyAI API. The
predicted behaviour comes from their published docs. `repro.py` exists so anyone with a key can
confirm or disprove all of it in about two minutes.

**One open question I couldn't answer:** AssemblyAI's own docs disagree about which model you
get when you don't pick one. The API reference says one thing, the migration guide says another.
I flagged it rather than guessing. The advice is the same either way: pick the model explicitly.

---

## Three things the customer didn't ask about

Raised anyway because they matter:

1. **Sessions cut off at 3 hours.** Court proceedings run longer. This is their most likely
   first-day production problem.
2. **Billing is based on how long the connection stays open, not how much audio is sent.** At
   2,000 streams that's roughly $300 to $900 per hour, and idle connections cost the same as
   active ones.
3. **Their existing async workload has weaker privacy guarantees than the streaming one they
   asked about.** Streaming keeps nothing. Async holds audio 24 to 48 hours and transcripts 72
   hours by default.
