#!/usr/bin/env bash
# Build + run without Maven. Downloads the three jars into lib/ on first run.
#
#   ./build.sh          compile only
#   ./build.sh run      compile and run (needs ASSEMBLYAI_API_KEY and a microphone)
#   ./build.sh original compile the ORIGINAL customer file, to see it fail
#
set -euo pipefail
cd "$(dirname "$0")"

M2=https://repo1.maven.org/maven2
JARS=(
  "org/java-websocket/Java-WebSocket/1.5.7/Java-WebSocket-1.5.7.jar"
  "com/google/code/gson/gson/2.11.0/gson-2.11.0.jar"
  "org/slf4j/slf4j-api/2.0.13/slf4j-api-2.0.13.jar"
  "org/slf4j/slf4j-simple/2.0.13/slf4j-simple-2.0.13.jar"
)

mkdir -p lib out
for path in "${JARS[@]}"; do
  jar="lib/$(basename "$path")"
  [[ -f "$jar" ]] || { echo "fetching $(basename "$path")"; curl -sSL -o "$jar" "$M2/$path"; }
done

CP="lib/*"

if [[ "${1:-}" == "original" ]]; then
  # Demonstrates defect #1: the file as sent does not compile.
  ORIGINAL=../../reference/original/com/assemblyai/Spanglish.java
  # Checked explicitly: a missing file also makes javac exit non-zero, and the point of
  # this command is to show a *compile* error, not to be satisfied by any failure at all.
  [[ -f "$ORIGINAL" ]] || { echo "error: $ORIGINAL not found" >&2; exit 1; }

  echo "Compiling the ORIGINAL customer file, this is expected to FAIL:"
  echo
  javac -cp "$CP" -d /tmp/spanglish-original "$ORIGINAL" \
    && { echo "UNEXPECTED: the original compiled."; exit 1; } \
    || { echo; echo "^ Expected. Defect #1: main() instantiates StreamingTranscription, which does not exist."; exit 0; }
fi

echo "Compiling fixed client.."
javac -Xlint:all -cp "$CP" -d out src/main/java/com/assemblyai/Spanglish.java
echo "OK -> out/com/assemblyai/Spanglish.class"

if [[ "${1:-}" == "run" ]]; then
  : "${ASSEMBLYAI_API_KEY:?Set ASSEMBLYAI_API_KEY first}"
  echo "Running (Ctrl+C to stop).."
  java -cp "out:$CP" com.assemblyai.Spanglish
fi
