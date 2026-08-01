/**
 * Which credentials are present, and which gateway will actually translate.
 *
 * The UI reads this on load so it can say "browser voice" or name the active
 * translation provider up front, rather than the AE discovering either
 * mid-sentence on stage.
 */

import { resolveProvider } from "@/lib/translation-provider";

export const dynamic = "force-dynamic";

export async function GET() {
  const resolved = resolveProvider();

  return Response.json(
    {
      assemblyai: Boolean(process.env.ASSEMBLYAI_API_KEY),
      elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
      translation: resolved
        ? { provider: resolved.id, label: resolved.provider.label, model: resolved.model }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
