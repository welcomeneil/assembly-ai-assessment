# Sample audio and transcript

The demo runs on the **Bangor Miami corpus** — 35 hours of spontaneous conversation
between bilingual English/Spanish speakers in Miami, recorded 2008–2011, transcribed by
hand with word-level language tags.

> Deuchar, M., Davies, P., Herring, J., Parafita Couto, M. C., & Carter, D.
> *Bangor Miami Corpus.* ESRC Centre for Research on Bilingualism, Bangor University.
> https://bangortalk.org.uk/ · https://talkbank.org/biling/access/Bangor/Miami.html

Licensed under GPL-3 / AGPL-3, with the TalkBank code of ethics. **The audio is not
committed to this repository** — `../audio/fetch_sample.sh` downloads it at run time.
The short transcript excerpt in `herring1-excerpt.json` is quoted with attribution.

## Why this recording

The task is a translation device, so the demo needed organic conversational speech
rather than anything synthesised. This corpus is the closest public match to what the
device actually has to survive:

- **Genuinely spontaneous** — overlapping speech, false starts, retracings, laughter
- **Real code-switching**, including mid-sentence: `porque se llama Paige the girl`
- **A human reference transcript**, so word error rate is measured against something
  real rather than asserted
- **Dense proper nouns and spoken numbers** — Fort Lauderdale, Kingston, Nicaragua,
  Paige, Fernando, "one oh nine" — which is exactly what `keyterms_prompt` addresses

It is also harder than what the device meets in the field: a 2008 restaurant recording
of two people talking over each other is a stress test, not a demo-friendly clip.

## The window

Utterances 262–292 of `herring1`, 408.503s–453.296s, 44.8 seconds, 24 turns. Two
friends planning a trip. `build_fixture.py` reads those numbers and regenerates both
the fixture and `reference.txt` from the corpus file, so nothing here is hand-typed.

## What the fixture adds

Two things in `build_fixture.py` are editorial rather than derived, and both are marked
in the source:

1. **Turn grouping** — a CHAT utterance is not an ASR turn. Quoted speech split across
   CHAT lines is merged, because an endpointer hears it as one turn.
2. **The simulated recogniser output** — the transcript the tuned configuration is
   shown returning, at about 7% word error rate. Deliberately not perfect: a flawless
   transcript of this audio would be a tell that the fixture was invented.

Everything else — timings, language labels, the reference text, and the English
translations of the Spanish turns — comes from the corpus.
