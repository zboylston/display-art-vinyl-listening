import { NextResponse } from "next/server";
import { isDisplayStoreConfigured, publishDisplaySnapshot } from "../../../lib/display-session";
import { parseDisplaySnapshot } from "../../../lib/display-snapshot";

export async function POST(request: Request) {
  try {
    if (!isDisplayStoreConfigured()) {
      return NextResponse.json({
        error: "Display sync is not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN.",
      }, { status: 503 });
    }
    const body = await request.json().catch(() => ({})) as { code?: unknown; snapshot?: unknown };
    const code = typeof body.code === "string" ? body.code : "";
    const snapshot = parseDisplaySnapshot(body.snapshot);
    if (!snapshot) return NextResponse.json({ error: "A valid display snapshot is required." }, { status: 400 });
    await publishDisplaySnapshot(code, snapshot);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not publish display state.";
    const status = message.includes("Unknown display session") || message.includes("Invalid") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
