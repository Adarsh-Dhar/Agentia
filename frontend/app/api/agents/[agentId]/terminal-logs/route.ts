// frontend/app/api/agents/[agentId]/terminal-logs/route.ts
//
// Proxies to the worker's GET /agents/:id/logs endpoint.
// Accepts optional ?since=<epoch_ms> query param for polling.

import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";

const WORKER_URL    = process.env.WORKER_URL    ?? "http://localhost:4001";
const WORKER_SECRET = process.env.WORKER_SECRET ?? "dev-worker-secret";

export async function GET(req: NextRequest, { params }: RouteContext) {
  const { agentId } = await params;
  const since       = req.nextUrl.searchParams.get("since");

  const url = new URL(`${WORKER_URL}/agents/${agentId}/logs`);
  if (since) url.searchParams.set("since", since);

  try {
    const workerRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${WORKER_SECRET}` },
      // Short timeout so the dashboard doesn't hang
      signal: AbortSignal.timeout(5000),
    });

    if (!workerRes.ok) {
      return NextResponse.json(
        { error: `Worker returned ${workerRes.status}` },
        { status: workerRes.status },
      );
    }

    const data = await workerRes.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Return empty entries rather than an error — UI degrades gracefully
    return NextResponse.json(
      { agentId, entries: [], error: message },
      { status: 200 },
    );
  }
}