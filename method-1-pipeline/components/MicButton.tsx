"use client";

import type { Status } from "@/lib/types";

type Props = {
  status: Status;
  /** 0..1 peak amplitude from the worklet. */
  level: number;
  onToggle: () => void;
};

const LABEL: Record<Status, string> = {
  idle: "Start",
  connecting: "Connecting",
  listening: "Listening",
  error: "Try again",
};

export default function MicButton({ status, level, onToggle }: Props) {
  const live = status === "listening";
  const busy = status === "connecting";

  // The ring tracks the mic so the room can see it's alive during silence.
  // Square-rooted because raw peak amplitude barely moves for normal speech.
  const ringScale = 1 + Math.sqrt(Math.min(level, 1)) * 0.35;

  return (
    <div className="relative flex items-center justify-center">
      {live && (
        <span
          aria-hidden
          className="breathe pointer-events-none absolute rounded-full border-2 border-live"
          style={{
            width: 128,
            height: 128,
            transform: `scale(${ringScale})`,
            transition: "transform 90ms linear",
          }}
        />
      )}

      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-pressed={live}
        className={`relative z-10 flex h-32 w-32 flex-col items-center justify-center gap-1.5 rounded-full border-2 text-lg font-semibold transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-live/40 ${
          live
            ? "border-live bg-live/15 text-live"
            : busy
              ? "cursor-wait border-edge bg-surface text-muted"
              : "border-edge bg-surface text-ink hover:border-faint"
        }`}
      >
        <span
          aria-hidden
          className={`h-3 w-3 rounded-full ${live ? "bg-live" : "bg-faint"}`}
        />
        {LABEL[status]}
      </button>
    </div>
  );
}
