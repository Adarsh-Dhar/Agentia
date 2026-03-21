import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: { agentId: string };
};

// ─── GET: Fetch the last 50 trade logs for the terminal UI ───────────────────
// The frontend polls this endpoint every 2 seconds to keep the terminal live.
// We cap at 50 logs to prevent the app from melting during a demo.
export async function GET(
  req: NextRequest,
  { params }: RouteContext
) {
  try {
    const { agentId } = params;

    // Optional: allow the caller to request fewer logs via ?limit=N
    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 50;

    // 1. Confirm the agent exists before querying its logs
    const agentExists = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });

    if (!agentExists) {
      return NextResponse.json(
        { error: `Agent with id "${agentId}" not found.` },
        { status: 404 }
      );
    }

    // 2 & 3 & 4. Fetch logs — newest first, hard cap at 50
    const logs = await prisma.tradeLog.findMany({
      where: { agentId },
      orderBy: { timestamp: "desc" },
      take: limit,
    });

    // Return with cache-control headers to prevent stale data in the terminal
    return NextResponse.json(logs, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error: unknown) {
    console.error("[GET /api/agents/[agentId]/logs] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}