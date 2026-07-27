#!/usr/bin/env bash
#
# Fetch the demo audio.
#
# The demo needs organic bilingual conversation, so it uses a real recording rather than
# anything synthesised: the Bangor Miami corpus, 35 hours of spontaneous English/Spanish
# speech from bilingual speakers in Miami, with transcripts made by hand at Bangor
# University.
#
# The corpus is GPL-3/AGPL-3 licensed and carries the TalkBank code of ethics, so it is
# downloaded here rather than committed to this repository. This script pulls the one
# conversation the demo uses, cuts the 45-second window, converts it to what the device
# microphone path produces, and rebuilds the fixture from the same source.
#
# Requires: curl, python3, and either ffmpeg or afconvert (macOS built-in).
#
#   ./fetch_sample.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

AUDIO_URL="http://bangortalk.bangor.ac.uk/sastre8.mp3"
CHAT_URL="https://bangortalk.org.uk/downloads/miami_chats.tar.gz"

# The window used by the demo, in milliseconds into sastre8. These are the corpus's own
# timings for utterances 849-874; build_reference.py reads the same numbers.
#
# A family talking about a cruise to France and a day in Paris, switching between Spanish
# and English throughout, with landmark names a recogniser has to get right. Chosen after
# an earlier clip failed live -- see ../fixtures/MEASUREMENTS.md.
START_MS=1538922
END_MS=1594655

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required" >&2; exit 1; }
}
need curl
need python3

if command -v ffmpeg >/dev/null 2>&1; then
  CONVERTER=ffmpeg
elif command -v afconvert >/dev/null 2>&1; then
  CONVERTER=afconvert
else
  echo "error: need ffmpeg or afconvert to decode MP3" >&2
  echo "  macOS ships afconvert; elsewhere: apt install ffmpeg / brew install ffmpeg" >&2
  exit 1
fi

echo "==> downloading audio (~24 MB)"
curl -fL --progress-bar "$AUDIO_URL" -o "$WORK/source.mp3"

echo "==> downloading transcripts"
curl -fL --progress-bar "$CHAT_URL" -o "$WORK/miami_chats.tar.gz"
tar xzf "$WORK/miami_chats.tar.gz" -C "$WORK"

CHA="$WORK/miami/sastre8.cha"
[ -f "$CHA" ] || { echo "error: sastre8.cha not found in the archive" >&2; exit 1; }

# 16 kHz mono signed 16-bit PCM: what the handheld's microphone path produces, and what
# the streaming session is configured for (encoding=pcm_s16le, sample_rate=16000).
echo "==> decoding with $CONVERTER"
if [ "$CONVERTER" = ffmpeg ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$WORK/source.mp3" \
    -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/full.wav"
else
  afconvert -f WAVE -d LEI16@16000 -c 1 "$WORK/source.mp3" "$WORK/full.wav"
fi

# Trimming happens here rather than in the decoder so it works identically under either
# converter, and needs nothing beyond the Python standard library.
echo "==> cutting ${START_MS}ms-${END_MS}ms"
python3 - "$WORK/full.wav" "$HERE/paris.wav" "$START_MS" "$END_MS" <<'PY'
import sys, wave

source_path, target_path, start_ms, end_ms = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

with wave.open(source_path, "rb") as source:
    rate = source.getframerate()
    start = int(rate * start_ms / 1000)
    frames = int(rate * (end_ms - start_ms) / 1000)
    source.setpos(min(start, source.getnframes()))
    pcm = source.readframes(frames)
    params = source.getparams()

with wave.open(target_path, "wb") as target:
    target.setnchannels(params.nchannels)
    target.setsampwidth(params.sampwidth)
    target.setframerate(params.framerate)
    target.writeframes(pcm)

print(f"    {len(pcm) / (rate * params.sampwidth * params.nchannels):.1f}s, "
      f"{params.framerate} Hz, {params.nchannels} channel(s), "
      f"{params.sampwidth * 8}-bit")
PY

echo "==> building the reference transcript from the same file"
python3 "$HERE/../fixtures/build_reference.py" "$CHA"

cat <<EOF

Done.

  audio      demo/audio/paris.wav
  reference  demo/fixtures/reference.txt  (+ reference.json)

Source: Bangor Miami corpus, Deuchar, M. et al., ESRC Centre for Research on
Bilingualism, Bangor University. Distributed under GPL-3 with the TalkBank code of
ethics. Please cite the corpus if you use this beyond running the demo.

  https://bangortalk.org.uk/  ·  https://talkbank.org/biling/access/Bangor/Miami.html

The demo already ships a recorded real session, so `npm start` works as-is. With a key
you can record a fresh one:

  export ASSEMBLYAI_API_KEY=...   # or put it in demo/.env
  npm run capture                 # records into fixtures/session.json
  npm start

EOF
