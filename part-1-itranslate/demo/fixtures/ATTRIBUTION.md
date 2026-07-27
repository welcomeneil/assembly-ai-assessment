# Sample audio and transcript

The demo runs on the **Bangor Miami corpus** — 35 hours of spontaneous conversation
between bilingual English/Spanish speakers in Miami, recorded 2008–2011, transcribed by
hand with word-level language tags.

> Deuchar, M., Davies, P., Herring, J., Parafita Couto, M. C., & Carter, D.
> *Bangor Miami Corpus.* ESRC Centre for Research on Bilingualism, Bangor University.
> https://bangortalk.org.uk/ · https://talkbank.org/biling/access/Bangor/Miami.html

Licensed under GPL-3 / AGPL-3, with the TalkBank code of ethics. **The audio is not
committed to this repository** — `../audio/fetch_sample.sh` downloads it at run time.
The short reference transcript in `reference.txt` is quoted with attribution.

## Why this recording

The task is a translation device, so the demo needed organic conversational speech
rather than anything synthesised. This corpus is the closest public match to what the
device actually has to survive:

- **Genuinely spontaneous** — false starts, retracings, real conversational pacing
- **Real code-switching**, sentence to sentence and inside sentences
- **A human reference transcript**, so word error rate is measured against something
  real rather than asserted
- **Landmark and place names** — Torre Eiffel, Notre Dame, Arco del Triunfo, Louvre,
  río Sena — which is exactly what `keyterms_prompt` addresses
- **Travel content**, which is what a handheld translator is bought for

## The window

Utterances 849–874 of `sastre8`, 1538.922s–1594.655s, 55.7 seconds. A family talking
about a cruise from England to France and a day trip to Paris. 18 Spanish utterances,
8 English, 6 switches between them. `build_reference.py` reads those numbers and
regenerates `reference.txt` from the corpus file, so nothing here is hand-typed.

An earlier version of this demo used `herring1` and it failed live — one turn for the
whole clip, no Spanish detected. Why, and what that taught, is in
[MEASUREMENTS.md](MEASUREMENTS.md).

## What is in session.json

A recording of a real AssemblyAI session, captured by `../src/capture.ts`. Every
transcript, confidence, language label and timing in it came off the wire. Nothing in
this directory is constructed — regenerate it with `npm run capture`.
