"use client";

import { lang } from "@/lib/languages";
import type { Turn } from "@/lib/types";

type Props = {
  turn: Turn;
  /** Which side of the conversation this came from, for the accent stripe. */
  tone: "a" | "b";
  showDetails: boolean;
};

function ms(value: number | undefined): string | null {
  return value === undefined ? null : `${Math.round(value)}ms`;
}

export default function TurnBubble({ turn, tone, showDetails }: Props) {
  const source = lang(turn.sourceLang);
  const target = lang(turn.targetLang);
  const pending = turn.translation === null && !turn.error;

  const stripe = tone === "a" ? "border-dir-a" : "border-dir-b";

  const stages = [
    ["transcript", ms(turn.stages.stt)],
    ["translate", ms(turn.stages.translate)],
    ["speech", ms(turn.stages.tts)],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <article className={`rise border-l-4 ${stripe} rounded-r-2xl bg-surface px-5 py-4 sm:px-6`}>
      {/* What was actually said. Small and quiet — it's the input, not the output. */}
      <p className="flex items-start gap-3 text-lg text-muted">
        <span aria-hidden className="mt-0.5 text-xl leading-none">
          {source.flag}
        </span>
        <span>{turn.original}</span>
      </p>

      {/* The translation. This is the thing the other person reads. */}
      <p className="mt-2.5 flex items-start gap-3 text-2xl font-semibold leading-snug sm:text-3xl">
        <span aria-hidden className="mt-1 text-2xl leading-none">
          {target.flag}
        </span>
        {pending ? (
          <span className="breathe text-muted">…</span>
        ) : turn.error ? (
          <span className="text-warn text-xl font-normal">{turn.error}</span>
        ) : (
          <span>{turn.translation}</span>
        )}
      </p>

      {(turn.totalMs !== null || showDetails) && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm text-faint">
          {showDetails &&
            stages.map(([label, value]) => (
              <span key={label} className="font-mono">
                {label} {value}
              </span>
            ))}
          {showDetails && turn.voice === "browser" && (
            <span className="font-mono">browser voice</span>
          )}
          {showDetails && !target.canSpeak && (
            <span className="font-mono">no voice for {target.name}</span>
          )}
          {turn.totalMs !== null && (
            <span className="font-mono text-muted">{(turn.totalMs / 1000).toFixed(1)} s</span>
          )}
        </div>
      )}
    </article>
  );
}
