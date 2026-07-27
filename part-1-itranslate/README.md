# Part 1: iTranslate demo

**The ask.** iTranslate makes a handheld translation device. No GPU, no on-device inference,
but it has wifi and cellular. It transcribes what you say, translates it, and speaks the result
out loud. They want better speech-to-text accuracy. Build a demo and document the approach.

---

## The short version

**They asked for better accuracy. I found something worth more than that.**

Their device transcribes one person at a time, which means it has to know which language is
about to be spoken before the person speaks. In practice that means a language button. Every
handoff between two people is a manual step, and a wrong setting produces a confidently wrong
transcript rather than an error.

Universal-3.5 Pro switches languages natively, mid-sentence, across 18 languages. Set
`language_codes=en,es`, turn on `language_detection`, and each turn comes back tagged with the
language it was spoken in.

**The language button can go away.** Two people pick up the device and talk. That is the demo.

The accuracy work is real too, and section 3 below covers it. But the largest single lever is
one nobody usually turns on: sending the model a description of the situation. AssemblyAI
measured a 21% reduction in word error rate and a 49% reduction in errors on person names from
a detailed context prompt. A handheld device knows its GPS location, the selected domain and
what was said thirty seconds ago, so it can build that prompt automatically on every session
with no user involvement.

---

## Documents

Read them in this order. The first one is the meeting, the other two are the engineering
behind it.

| File | Who it is for | What it covers |
|---|---|---|
| **[00-demo-brief.md](00-demo-brief.md)** | The account executive | The pitch, the demo beat by beat, what to ask for at the end, objection handling |
| **[01-approach.md](01-approach.md)** | Their engineers | **The documentation the brief asked for.** Problem, architecture, speed, bandwidth, cost, how to prove it, risks. Opens with a one-table summary |
| [02-accuracy-playbook.md](02-accuracy-playbook.md) | Their engineers | Eight accuracy levers ranked by return, with expected impact and how to verify each |

---

## Demo

Four pieces, in the two languages they use.

| Piece | Language | What it is |
|---|---|---|
| [`demo/dashboard/index.html`](demo/dashboard/index.html) | HTML/JS | The screen you show the customer. Live conversation, detected language per turn, latency, cost |
| [`demo/backend/src/server.ts`](demo/backend/src/server.ts) | TypeScript | Token broker, translation proxy and event bus. The device never holds a credential |
| [`demo/device/translator.py`](demo/device/translator.py) | Python | Simulates the handheld. Mic in, translated speech out, no language button |
| [`demo/bench/accuracy_bench.py`](demo/bench/accuracy_bench.py) | Python | Measures word error rate across configurations so accuracy claims are testable |

### Run it, no API key needed

Two commands and a browser. This is the version to open on a call.

```bash
cd demo/backend
npm install
npm run build && npm start
```

Open **http://localhost:8787** and press **Play sample conversation**.

The dashboard plays a scripted exchange between an English-speaking tourist and a Spanish
market vendor. A banner across the top says the data is scripted, so nobody can mistake it for
measured results. What it shows:

- **Every turn is tagged with the language AssemblyAI detected.** Nobody selected it. The
  header counts the switches. That is the argument for removing the language button, made
  visible instead of asserted.
- **The last turn switches language mid-sentence.** A language-pinned session cannot follow
  that. This one does.
- **Where the time goes,** split into recognition, translation and speech, per turn and as a
  running chart.
- **The exact parameters the device sent,** and the context prompt built from its GPS and
  itinerary. The accuracy claim is on screen, not in a slide.
- **A billing meter showing connection time against audio time.** Those two numbers come apart
  whenever the device is left connected, and streaming is billed on the first one.

### Run it live, with a key

Same dashboard, real audio. Start the backend as above with a key set, then point the device
simulator at it.

```bash
export ASSEMBLYAI_API_KEY=your_key

# terminal 1
cd demo/backend && npm start

# terminal 2
cd demo/device
pip install -r requirements.txt

# with a microphone
python3 translator.py --pair en,es --dashboard

# without a microphone, using the bilingual sample from Part 2
python3 translator.py --pair en,es --dashboard \
  --file ../../../part-2-spanglish/code/python/sample_bilingual.wav

# with device context, which is where the accuracy gain comes from
python3 translator.py --pair en,es --dashboard \
  --location "Mercado de San Miguel, Madrid" \
  --domain travel \
  --names "Elena,Hotel Catalonia"
```

Drop `--dashboard` and it runs standalone on the terminal. Each turn prints the detected
language, the transcript, the translation and a latency breakdown:

```
  [es (0.98)] Estaba en mi casa con mi hermana, preparando la cena.
  [en] I was at my house with my sister, making dinner.
  stt   400ms | translate   312ms | tts    98ms | total   810ms
```

### Backend endpoints

- `POST /v1/session` mints a single-use 60-second streaming token and returns the full
  connection parameters
- `POST /v1/translate` proxies a finished turn through the LLM Gateway
- `WS /v1/events` event bus. The device publishes, the dashboard subscribes
- `POST /v1/demo/replay` starts the scripted conversation
- `GET /v1/health` also reports whether an API key is configured

### Run the accuracy benchmark

```bash
cd demo/bench
pip install -r requirements.txt
export ASSEMBLYAI_API_KEY=your_key
python3 accuracy_bench.py sample.wav reference.txt --pair en,es
```

Streams the same audio through each configuration in turn, adding one lever at a time, and
reports word error rate with substitutions, deletions and insertions broken out separately.
That breakdown matters: deletions point at the endpointer, substitutions at vocabulary,
insertions at background noise.

---

## Key decisions and why

**Audio goes device to AssemblyAI directly.** It does not route through iTranslate's backend.
That keeps the backend small regardless of fleet size and removes a hop from the latency
budget. Only session setup and translation touch their servers.

**The device holds no API key.** A consumer handheld can be opened and its firmware dumped. An
API key on the device is a key on every device, and revoking it bricks the fleet. The backend
mints single-use tokens valid for 60 seconds, requested immediately before connecting.

**Connection parameters come from the server, not the firmware.** Firmware rolls out slowly
across a consumer fleet, so anything baked into the device is frozen for months. Returning
parameters from `/v1/session` means the model, noise settings and turn thresholds can change
for every device at once, or for 1% of them first.

**Translation uses the AssemblyAI LLM Gateway.** OpenAI-compatible, routes to Gemini, Claude
and GPT, passes provider pricing through with no markup. One vendor, one key, one DPA, one
region setting for the whole pipeline.

**TTS stays theirs.** AssemblyAI does not do text to speech, and iTranslate already has an
engine. The demo uses the macOS `say` command so it makes sound. That is the seam where their
engine drops in.

**The dashboard has no build step.** One HTML file, no bundler, no framework install, no CDN,
no web fonts. It is served by the backend that already exists. A demo shown to a customer
should not be able to fail at compile time or because the venue wifi cannot reach a CDN, and
the whole thing is small enough to read in one sitting.

**The dashboard observes and nothing more.** It subscribes to events the device publishes. It
holds no credentials and never contacts AssemblyAI. The same stream is what a support engineer
would want when a device in the field misbehaves: which model was actually applied, the
confidence on each turn, and where the latency went.

---

## Two things they did not ask about

**Billing is based on how long the connection stays open, not how much audio is sent.** A
translation device is bursty: a 40-second exchange, then ten minutes of walking. Holding the
session open through the walk means paying for the walk. At 100,000 devices the difference
between closing after 20 seconds of silence and holding the session open for a whole outing is
roughly $7,500 a day against roughly $45,000 a day, for identical conversations. The session
policy deserves more engineering attention than the model choice.

**Opus cuts bandwidth about tenfold**, from ~115 MB to ~11 MB per hour of connection. On a
metered cellular plan that is the difference between a device people use freely and one they
ration, and the radio is a major power draw. AssemblyAI supports it natively. The catch is that
declaring a compressed encoding while sending raw PCM produces a session that connects, reports
healthy, and silently returns nothing. That exact mistake is what broke the customer in Part 2.
I would ship this as its own change with its own integration test, after accuracy is settled.

---

## What I verified and what I did not

**Verified locally, by running it:**
- The backend builds and serves. `npm install && tsc --noEmit` is clean under strict mode.
- The dashboard works end to end. I ran the backend, subscribed to `/v1/events`, triggered the
  replay and confirmed the full stream: 1 session event, 40 partials, 8 turns with 7 language
  switches, 33 meter ticks, clean close.
- `translator.py` and `accuracy_bench.py` compile, and the device CLI runs.

**Not verified:** I had no AssemblyAI API key, so nothing here has run against the live
service. The parameters, endpoints and limits come from AssemblyAI's published documentation.
The scripted conversation in the dashboard is written, not recorded, and its latency figures
are plausible values inside AssemblyAI's published ranges rather than measurements. The
dashboard says so on screen. The benchmark harness exists so that anyone with a key can produce
real numbers rather than relying on mine.

**Not visually checked:** I built the dashboard without a browser available to me, so I
verified its structure programmatically (every element the script references exists, the
JavaScript parses, there are no external resource requests) but I have not seen it rendered.
Open it before the call.

**Assumption worth flagging:** the language-button argument is inferred from the brief and from
how comparable devices work. I have not seen iTranslate's firmware. It is the first question I
would ask on the call, and if I am wrong about it, the accuracy work stands on its own.
