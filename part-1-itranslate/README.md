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

| File | What it covers |
|---|---|
| [01-approach.md](01-approach.md) | Architecture, latency budget, bandwidth and battery, cost model, rollout plan, open risks |
| [02-accuracy-playbook.md](02-accuracy-playbook.md) | Eight accuracy levers ranked by return, with expected impact and how to verify each |

---

## Demo

Three pieces, in the two languages they use.

| Piece | Language | What it is |
|---|---|---|
| [`demo/device/translator.py`](demo/device/translator.py) | Python | Simulates the handheld. Mic in, translated speech out, no language button |
| [`demo/backend/src/server.ts`](demo/backend/src/server.ts) | TypeScript | Token broker and translation proxy. The device never holds a credential |
| [`demo/bench/accuracy_bench.py`](demo/bench/accuracy_bench.py) | Python | Measures word error rate across configurations so accuracy claims are testable |

### Run the device simulator

```bash
cd demo/device
pip install -r requirements.txt
export ASSEMBLYAI_API_KEY=your_key

# with a microphone
python3 translator.py --pair en,es

# without a microphone, using the bilingual sample from Part 2
python3 translator.py --pair en,es \
  --file ../../../part-2-spanglish/code/python/sample_bilingual.wav

# with device context, which is where the accuracy gain comes from
python3 translator.py --pair en,es \
  --location "Mercado de San Miguel, Madrid" \
  --domain travel \
  --names "Elena,Hotel Catalonia"
```

Each turn prints the detected language, the transcript, the translation, and a latency
breakdown:

```
  [es (0.98)] Estaba en mi casa con mi hermana, preparando la cena.
  [en] I was at my house with my sister, making dinner.
  stt   400ms | translate   312ms | tts    98ms | total   810ms
```

### Run the backend

```bash
cd demo/backend
npm install
export ASSEMBLYAI_API_KEY=your_key
npm run build && npm start
```

Endpoints:

- `POST /v1/session` mints a single-use 60-second streaming token and returns the full
  connection parameters
- `POST /v1/translate` proxies a finished turn through the LLM Gateway
- `GET /v1/health`

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

**Verified locally:**
- `translator.py` and `accuracy_bench.py` compile
- `server.ts` typechecks clean under TypeScript strict mode with `npm install && tsc --noEmit`

**Not verified:** I had no AssemblyAI API key, so nothing here has run against the live
service. The parameters, endpoints and limits come from AssemblyAI's published documentation.
The benchmark harness exists so that anyone with a key can produce real numbers rather than
relying on mine, and the example output in the accuracy playbook is illustrative formatting,
not measured results.

**Assumption worth flagging:** the language-button argument is inferred from the brief and from
how comparable devices work. I have not seen iTranslate's firmware. It is the first question I
would ask on the call, and if I am wrong about it, the accuracy work stands on its own.
