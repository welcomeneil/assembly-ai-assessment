"use client";

import { useEffect, useRef } from "react";
import TurnBubble from "./TurnBubble";
import type { Turn } from "@/lib/types";

type Props = {
  turns: Turn[];
  /** Left-hand language of the pair; decides which accent stripe a turn gets. */
  sideA: string;
  showDetails: boolean;
};

export default function Conversation({ turns, sideA, showDetails }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-3xl font-medium text-muted sm:text-4xl">Start, then just talk.</p>
        <p className="max-w-md text-lg text-faint">
          Either language, either person.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {turns.map((turn) => (
          <TurnBubble
            key={turn.id}
            turn={turn}
            tone={turn.sourceLang === sideA ? "a" : "b"}
            showDetails={showDetails}
          />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
