import { NextResponse } from "next/server";
import { isDisplayStoreConfigured, readDisplaySession } from "../../../lib/display-session";

export async function GET(request: Request) {
  try {
    if (!isDisplayStoreConfigured()) {
      return NextResponse.json({
        error: "Display sync is not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN.",
      }, { status: 503 });
    }
    const code = new URL(request.url).searchParams.get("code") ?? "";
    const session = await readDisplaySession(code);
    if (!session.exists) return NextResponse.json({ error: "Unknown display session." }, { status: 404 });
    return NextResponse.json({ snapshot: session.snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read display state.";
    const status = message.includes("Invalid") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
