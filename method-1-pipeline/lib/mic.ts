/**
 * Microphone → Int16 PCM frames, plus a level signal for the UI.
 *
 * Both demo apps use this; only `targetSampleRate` differs (16k for the
 * streaming STT socket, 24k for the Voice Agent).
 */

export type MicHandlers = {
  onFrame: (pcm: Int16Array) => void;
  /** 0..1 peak amplitude, for the ring around the mic button. */
  onLevel: (level: number) => void;
};

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(
    private readonly targetSampleRate: number,
    private readonly handlers: MicHandlers,
  ) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Without these the speaker output loops straight back into the mic.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    // Chrome honours this and hands us audio already at the target rate.
    // Safari ignores it; the worklet resamples to compensate.
    this.ctx = new AudioContext({ sampleRate: this.targetSampleRate });
    if (this.ctx.state === "suspended") await this.ctx.resume();

    await this.ctx.audioWorklet.addModule("/pcm-worklet.js");

    this.node = new AudioWorkletNode(this.ctx, "pcm-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetSampleRate: this.targetSampleRate },
    });

    this.node.port.onmessage = (e) => {
      const data = e.data;
      if (data?.type !== "frame") return;
      this.handlers.onFrame(new Int16Array(data.pcm));
      this.handlers.onLevel(data.level ?? 0);
    };

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
  }

  /**
   * Emit silence instead of live audio. Used while our own TTS plays, so the
   * device doesn't transcribe itself. The socket stays open throughout.
   */
  setMuted(muted: boolean): void {
    this.node?.port.postMessage({ type: "mute", value: muted });
    if (muted) this.handlers.onLevel(0);
  }

  async stop(): Promise<void> {
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
  }
}
