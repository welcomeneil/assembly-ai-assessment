/**
 * Mints a short-lived, single-use streaming token.
 *
 * The API key lives here and never reaches the browser. This is the same thing
 * iTranslate's handheld should do: a consumer device can be opened and its
 * firmware dumped, so a key baked into one device is a key on every device, and
 * revoking it bricks the fleet. A 60-second token is worth nothing if leaked.
 *
 * Note the header format: `Authorization: <key>` with NO Bearer prefix. The
 * Voice Agent token endpoint (Method 2) *does* want Bearer. They disagree.
 */

export const dynamic = "force-dynamic";

const TOKEN_URL = "https://streaming.assemblyai.com/v3/token";

export async function GET() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ASSEMBLYAI_API_KEY is not set. Add it to .env.local and restart." },
      { status: 503 },
    );
  }

  const url = new URL(TOKEN_URL);
  url.searchParams.set("expires_in_seconds", "60");

  const res = await fetch(url, { headers: { Authorization: apiKey } });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return Response.json(
      { error: `AssemblyAI rejected the token request (${res.status}). ${detail}`.trim() },
      { status: 502 },
    );
  }

  const { token } = (await res.json()) as { token: string };
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
