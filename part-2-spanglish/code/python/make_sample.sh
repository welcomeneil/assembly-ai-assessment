#!/usr/bin/env bash
# Generate a bilingual EN/ES courtroom-with-interpreter sample for repro.py.
# macOS only (uses `say` + `afconvert`). Output: sample_bilingual.wav, 16 kHz mono 16-bit.
#
# The last line is the important one: it code-switches mid-sentence, which is exactly the
# interpreter pattern that the English-only default model mangles.
#
#   ./make_sample.sh
#   python3 repro.py sample_bilingual.wav
set -euo pipefail
cd "$(dirname "$0")"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# voice : text, a plausible direct examination with a Spanish-language interpreter
LINES=(
  "Samantha|Mister Reyes, where were you on the evening of March fourteenth?"
  "Paulina|Señor Reyes, ¿dónde estaba usted la noche del catorce de marzo?"
  "Jorge|Estaba en mi casa con mi hermana, preparando la cena."
  "Samantha|Let the record reflect the witness stated he was at home with his sister."
  "Samantha|Did anyone else visit the residence that evening?"
  "Jorge|No, nadie más. Solo my sister and me, that's all, nada más."
)

i=0
FILES=()
for line in "${LINES[@]}"; do
  voice="${line%%|*}"
  text="${line#*|}"
  out="$WORK/$(printf '%02d' "$i").wav"
  say -v "$voice" "$text" -o "$WORK/$i.aiff" 2>/dev/null \
    || say "$text" -o "$WORK/$i.aiff"          # fall back if a voice isn't installed
  afconvert -f WAVE -d LEI16@16000 -c 1 "$WORK/$i.aiff" "$out"
  FILES+=("$out")
  i=$((i + 1))
done

# Concatenate, then normalise once more to be certain of 16 kHz / mono / 16-bit,
# because repro.py hard-asserts that format (as it should, the whole bug class here
# is audio that isn't the format the URL claims it is).
python3 - "$@" <<'PY' "${FILES[@]}"
import sys, wave
outs = sys.argv[1:]
with wave.open("sample_bilingual.wav", "wb") as out:
    out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
    for path in outs:
        with wave.open(path, "rb") as w:
            assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000), path
            out.writeframes(w.readframes(w.getnframes()))
            out.writeframes(b"\x00\x00" * 4000)   # 250 ms gap -> clean turn boundaries
PY

python3 -c "
import wave
w = wave.open('sample_bilingual.wav')
print(f'sample_bilingual.wav: {w.getnframes()/w.getframerate():.1f}s, '
      f'{w.getframerate()} Hz, {w.getnchannels()}ch, {w.getsampwidth()*8}-bit')
"
