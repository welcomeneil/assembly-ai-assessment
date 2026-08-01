/**
 * Microphone capture worklet: Float32 at whatever rate the browser gave us,
 * out as Int16 PCM at exactly the rate the API wants.
 *
 * Two things here are load-bearing:
 *
 * 1. Resampling. Chrome honours `new AudioContext({sampleRate})` and hands us
 *    audio at the target rate already, so the ratio is 1 and this is a copy.
 *    Safari ignores that option and runs at the hardware rate (usually 48k).
 *    Without resampling, Safari audio arrives at 3x speed and transcribes as
 *    garbage. Linear interpolation is enough for speech at these rates.
 *
 * 2. Muting. When our own TTS is playing through the laptop speakers, the mic
 *    hears it, it gets transcribed, and that triggers another translation —
 *    forever. So we emit *silence* rather than stopping: the socket stays open
 *    and the server's turn detection sees a normal pause instead of a stall.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 16000;
    // `sampleRate` is a global in AudioWorkletGlobalScope: the real context rate.
    this.ratio = sampleRate / this.targetRate;
    this.frameSize = Math.round(this.targetRate * 0.1); // 100ms frames

    this.muted = false;
    this.acc = new Float32Array(0); // input samples not yet consumed
    this.readPos = 0; // fractional read head into `acc`
    this.out = new Int16Array(this.frameSize);
    this.outLen = 0;
    this.peak = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "mute") this.muted = !!e.data.value;
    };
  }

  /** Append a block to the pending-input buffer. */
  push(block) {
    const merged = new Float32Array(this.acc.length - Math.floor(this.readPos) + block.length);
    const keepFrom = Math.floor(this.readPos);
    merged.set(this.acc.subarray(keepFrom), 0);
    merged.set(block, this.acc.length - keepFrom);
    this.acc = merged;
    this.readPos -= keepFrom; // keep only the fractional part
  }

  emitFrame() {
    // Copy out: the buffer is reused for the next frame.
    const pcm = this.out.slice(0, this.outLen);
    this.port.postMessage({ type: "frame", pcm: pcm.buffer, level: this.peak }, [pcm.buffer]);
    this.outLen = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const block = input[0];

    for (let i = 0; i < block.length; i++) {
      const a = Math.abs(block[i]);
      if (a > this.peak) this.peak = a;
    }

    this.push(block);

    // Pull output samples until we run out of interpolable input.
    while (this.readPos + 1 < this.acc.length) {
      let s;
      if (this.muted) {
        s = 0;
      } else {
        const i0 = Math.floor(this.readPos);
        const frac = this.readPos - i0;
        s = this.acc[i0] * (1 - frac) + this.acc[i0 + 1] * frac;
      }
      // Asymmetric clamp: Int16 range is -32768..32767.
      const clamped = Math.max(-1, Math.min(1, s));
      this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.readPos += this.ratio;

      if (this.outLen === this.frameSize) this.emitFrame();
    }

    if (this.muted) this.peak = 0;
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
