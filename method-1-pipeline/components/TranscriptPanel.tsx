"use client";

import { useEffect, useState } from "react";
import { LANGUAGES, lang } from "@/lib/languages";

export type TranscriptResult = {
  utterances: { speaker: string; text: string; translations: Record<string, string> }[];
  targets: string[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  onRun: (targets: string[], formal: boolean) => void;
  state: "idle" | "running" | "done" | "error";
  result: TranscriptResult | null;
  error: string | null;
  /** Pre-ticked from the live conversation's language pair. */
  defaultTargets: string[];
};

export default function TranscriptPanel({
  open,
  onClose,
  onRun,
  state,
  result,
  error,
  defaultTargets,
}: Props) {
  const [targets, setTargets] = useState<string[]>(defaultTargets);
  const [formal, setFormal] = useState(false);

  useEffect(() => setTargets(defaultTargets), [defaultTargets]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (code: string) =>
    setTargets((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-edge bg-ground">
        <header className="flex items-start justify-between gap-4 border-b border-edge px-6 py-5">
          <div>
            <h2 className="text-2xl font-semibold">Translated transcript</h2>
            <p className="mt-1 text-sm text-muted">
              The whole conversation, speaker-labelled, through AssemblyAI&apos;s Speech
              Understanding Translation.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full border border-edge px-3 py-1.5 text-muted transition-colors hover:text-ink"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <fieldset disabled={state === "running"} className="mb-5">
            <legend className="mb-2 text-sm font-medium text-muted">Translate into</legend>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((l) => {
                const on = targets.includes(l.code);
                return (
                  <button
                    key={l.code}
                    type="button"
                    onClick={() => toggle(l.code)}
                    aria-pressed={on}
                    className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                      on
                        ? "border-live bg-live/15 text-live"
                        : "border-edge text-muted hover:border-faint hover:text-ink"
                    }`}
                  >
                    <span aria-hidden className="mr-1.5">
                      {l.flag}
                    </span>
                    {l.name}
                  </button>
                );
              })}
            </div>

            <label className="mt-4 flex w-fit cursor-pointer items-center gap-2.5 text-sm text-muted">
              <input
                type="checkbox"
                checked={formal}
                onChange={(e) => setFormal(e.target.checked)}
                className="h-4 w-4 accent-[#3ddc97]"
              />
              Formal register
            </label>
          </fieldset>

          <button
            type="button"
            onClick={() => onRun(targets, formal)}
            disabled={state === "running" || targets.length === 0}
            className="rounded-full bg-live px-6 py-3 font-semibold text-ground transition-opacity disabled:opacity-40"
          >
            {state === "running" ? "Transcribing…" : "Run"}
          </button>

          {state === "running" && (
            <p className="mt-4 text-sm text-muted">
              uploading recording… transcribing speaker labels… translating…
            </p>
          )}

          {state === "error" && error && <p className="mt-4 text-warn">{error}</p>}

          {state === "done" && result && (
            <div className="mt-6 flex flex-col gap-4">
              {result.utterances.length === 0 && (
                <p className="text-muted">No speech was found in the recording.</p>
              )}
              {result.utterances.map((u, i) => (
                <div key={i} className="rounded-2xl border border-edge bg-surface px-5 py-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">
                    Speaker {u.speaker}
                  </p>
                  <p className="text-lg">{u.text}</p>
                  {/* The API omits a target that matches the detected source —
                      no point translating Spanish into Spanish — so render
                      only what actually came back. */}
                  <div className="mt-3 flex flex-col gap-1.5 border-t border-edge pt-3">
                    {result.targets
                      .filter((code) => u.translations[code])
                      .map((code) => (
                        <p key={code} className="flex items-start gap-2.5 text-base text-muted">
                          <span aria-hidden>{lang(code).flag}</span>
                          <span>{u.translations[code]}</span>
                        </p>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
