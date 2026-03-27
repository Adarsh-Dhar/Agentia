import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RouteContext } from "@/lib/types";

// ─── GET: Fetch the last 50 trade logs for the terminal UI ────────────────
export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params; // Await the promise

    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 50;

    const agentExists = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });

    if (!agentExists) {
      return NextResponse.json({ error: `Agent not found.` }, { status: 404 });
    }

    const logs = await prisma.tradeLog.findMany({
      where: { agentId },
      orderBy: { timestamp: "desc" },
      take: limit,
    });

    return NextResponse.json(logs, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}