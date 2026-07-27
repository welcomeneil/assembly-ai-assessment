/**
 * WAV file to real-time PCM chunks.
 *
 * The chunk size and the pacing both matter. AssemblyAI requires 50-1000 ms per chunk
 * and expects them at roughly the speed the audio was spoken. Sending too small a chunk
 * closes the socket with code 3007; sending a file as fast as it can be read makes the
 * latency numbers meaningless, because the server is no longer keeping up with a
 * conversation, it is racing a disk.
 */

export const TARGET_SAMPLE_RATE = 16_000;
export const CHUNK_MS = 100;

export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
  durationMs: number;
}

/**
 * Decode a WAV file to 16 kHz mono 16-bit PCM.
 *
 * `fetch_sample.sh` already produces exactly that with ffmpeg, so the downmix and
 * resample paths here are for whatever file the customer drops in.
 */
export function decodeWav(buffer: Buffer): Pcm {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | undefined;

  // Walk the chunk list rather than assuming fmt is first and data is second -- files
  // from real recorders carry LIST/fact/bext chunks in between.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (data === undefined) throw new Error("no data chunk in WAV file");
  // 0xFFFE is WAVE_FORMAT_EXTENSIBLE, which is still PCM for our purposes.
  if (format !== 1 && format !== 0xfffe) {
    throw new Error(`expected uncompressed PCM, got format ${format}`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`expected 16-bit samples, got ${bitsPerSample}`);
  }

  const interleaved = new Int16Array(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.length - (data.length % 2)),
  );

  const mono = channels > 1 ? downmix(interleaved, channels) : interleaved;
  const resampled = sampleRate === TARGET_SAMPLE_RATE
    ? mono
    : resample(mono, sampleRate, TARGET_SAMPLE_RATE);

  return {
    samples: resampled,
    sampleRate: TARGET_SAMPLE_RATE,
    durationMs: (resampled.length / TARGET_SAMPLE_RATE) * 1000,
  };
}

function downmix(interleaved: Int16Array, channels: number): Int16Array {
  const frames = Math.floor(interleaved.length / channels);
  const mono = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += interleaved[frame * channels + channel]!;
    }
    mono[frame] = Math.round(sum / channels);
  }
  return mono;
}

/**
 * Linear resampling.
 *
 * Adequate for a demo and for downsampling speech; a production device would use its
 * codec's own resampler, which it already has in the microphone path.
 */
function resample(input: Int16Array, from: number, to: number): Int16Array {
  const ratio = from / to;
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = Math.round(a + (b - a) * fraction);
  }
  return output;
}

/** Slice PCM into CHUNK_MS buffers. */
export function chunk(pcm: Pcm, chunkMs: number = CHUNK_MS): Buffer[] {
  const samplesPerChunk = Math.floor((pcm.sampleRate * chunkMs) / 1000);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcm.samples.length; offset += samplesPerChunk) {
    const slice = pcm.samples.subarray(offset, offset + samplesPerChunk);
    chunks.push(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
  }
  return chunks;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Yield chunks at the speed they were spoken.
 *
 * Compensates against a wall clock rather than sleeping a fixed interval, so the stream
 * does not drift ahead of real time over a long file.
 */
export async function* pace(
  chunks: Buffer[],
  chunkMs: number = CHUNK_MS,
): AsyncGenerator<{ chunk: Buffer; index: number; elapsedMs: number }> {
  const start = Date.now();
  for (let index = 0; index < chunks.length; index++) {
    const due = start + index * chunkMs;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    yield { chunk: chunks[index]!, index, elapsedMs: Date.now() - start };
  }
}
