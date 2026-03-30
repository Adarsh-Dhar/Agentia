import { NextRequest, NextResponse } from "next/server";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${META_AGENT_URL}/classify-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: body.prompt }),
    });

    if (!res.ok) throw new Error("Failed to classify intent");
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
