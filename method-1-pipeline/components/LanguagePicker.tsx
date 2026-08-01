"use client";

import { useEffect, useRef, useState } from "react";
import type { Language } from "@/lib/languages";

type Props = {
  languages: Language[];
  a: string;
  b: string;
  onChange: (a: string, b: string) => void;
  /** Return a reason string to grey an option out, or null if it's selectable. */
  unavailable?: (code: string, otherSide: string) => string | null;
};

function Pill({
  languages,
  value,
  otherSide,
  onSelect,
  unavailable,
  align,
}: {
  languages: Language[];
  value: string;
  otherSide: string;
  onSelect: (code: string) => void;
  unavailable?: (code: string, otherSide: string) => string | null;
  align: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = languages.find((l) => l.code === value) ?? languages[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-3 rounded-full border border-edge bg-surface px-5 py-3 text-xl font-medium transition-colors hover:border-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-live"
      >
        <span aria-hidden className="text-2xl leading-none">
          {current?.flag}
        </span>
        <span>{current?.name}</span>
        <span aria-hidden className="text-faint text-sm">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute z-20 mt-2 max-h-80 w-64 overflow-y-auto rounded-2xl border border-edge bg-raised p-1.5 shadow-2xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {languages.map((l) => {
            const reason = unavailable?.(l.code, otherSide) ?? null;
            const isCurrent = l.code === value;
            return (
              <button
                key={l.code}
                type="button"
                role="option"
                aria-selected={isCurrent}
                disabled={Boolean(reason)}
                title={reason ?? undefined}
                onClick={() => {
                  onSelect(l.code);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-base transition-colors ${
                  reason
                    ? "cursor-not-allowed text-faint"
                    : isCurrent
                      ? "bg-surface text-ink"
                      : "text-ink hover:bg-surface"
                }`}
              >
                <span aria-hidden className="text-xl leading-none">
                  {l.flag}
                </span>
                <span className="flex-1">{l.name}</span>
                {reason && <span className="text-xs text-faint">{reason}</span>}
                {!reason && !l.canSpeak && (
                  <span className="text-xs text-faint">text only</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function LanguagePicker({ languages, a, b, onChange, unavailable }: Props) {
  return (
    <div className="flex items-center justify-center gap-3 sm:gap-5">
      <Pill
        languages={languages}
        value={a}
        otherSide={b}
        align="left"
        unavailable={unavailable}
        onSelect={(code) => onChange(code, code === b ? a : b)}
      />

      <button
        type="button"
        onClick={() => onChange(b, a)}
        aria-label="Swap languages"
        className="rounded-full border border-edge bg-surface p-3 text-muted transition-colors hover:border-faint hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-live"
      >
        <span aria-hidden className="block text-lg leading-none">
          ⇄
        </span>
      </button>

      <Pill
        languages={languages}
        value={b}
        otherSide={a}
        align="right"
        unavailable={unavailable}
        onSelect={(code) => onChange(code === a ? b : a, code)}
      />
    </div>
  );
}
