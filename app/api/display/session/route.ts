import { NextResponse } from "next/server";
import { createDisplaySession, isDisplayStoreConfigured } from "../../../lib/display-session";

export async function POST() {
  try {
    if (!isDisplayStoreConfigured()) {
      return NextResponse.json({
        error: "Display sync is not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN.",
      }, { status: 503 });
    }
    const code = await createDisplaySession();
    return NextResponse.json({ code });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not create a display session.",
    }, { status: 500 });
  }
}
