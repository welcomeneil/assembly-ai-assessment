/**
 * Wraps the PCM frames we already buffered for streaming into a WAV file.
 *
 * No MediaRecorder needed — the audio has been passing through the worklet all
 * along, so recording the conversation costs one 44-byte header. At 16 kHz mono
 * 16-bit that's ~32 KB/s, so a two-minute conversation is under 4 MB.
 */

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export function framesToWav(frames: Int16Array[]): Blob {
  const totalSamples = frames.reduce((n, f) => n + f.length, 0);
  const dataBytes = totalSamples * 2;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  return new Blob([header, ...frames.map((f) => f.buffer as ArrayBuffer)], {
    type: "audio/wav",
  });
}
