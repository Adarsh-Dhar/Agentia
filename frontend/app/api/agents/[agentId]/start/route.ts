// frontend/app/api/agents/[id]/start/route.ts
// Mirror this pattern for /stop as well (just change the worker endpoint)

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:4001";
const WORKER_SECRET = process.env.WORKER_SECRET ?? "dev-worker-secret";

export async function POST(
  _req: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = params;

  try {
    const workerRes = await fetch(`${WORKER_URL}/agents/${agentId}/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WORKER_SECRET}`,
      },
    });

    const data = await workerRes.json();

    if (!workerRes.ok) {
      return NextResponse.json(data, { status: workerRes.status });
    }

    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not reach worker: ${message}` },
      { status: 502 }
    );
  }
}