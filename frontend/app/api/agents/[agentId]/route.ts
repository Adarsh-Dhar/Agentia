import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RouteContext } from "@/lib/types";

// ─── GET: Fetch a single agent's full details ─────────────────────────────────
export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params; // Await the promise here!

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        // Include the owning user and recent logs for the detail page
        user: { select: { walletAddress: true, email: true } },
        logs: {
          orderBy: { timestamp: "desc" },
          take: 50,
        },
      },
    });

    if (!agent) {
      return NextResponse.json({ error: `Agent with id "${agentId}" not found.` }, { status: 404 });
    }

    return NextResponse.json(agent, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

// ─── DELETE: Permanently destroy an agent ────────────────────────────────────
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params; // Await the promise here!

    const existing = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: `Agent with id "${agentId}" not found.` }, { status: 404 });
    }

    await prisma.agent.delete({ where: { id: agentId } });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}