import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RouteContext } from "@/lib/types";

// ─── PATCH: Update an agent's status (PAUSED / REVOKED / EXPIRED) ─────────────
export async function PATCH(
  req: NextRequest,
  { params }: RouteContext 
) {
  try {
    const { agentId } = await params; // Await the promise
    const body = await req.json();
    const { status } = body;

    const validStatuses = ["PAUSED", "REVOKED", "EXPIRED", "RUNNING"];
    if (!status || !validStatuses.includes(status)) {
      return NextResponse.json(
        {
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Check the agent exists
    const existing = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true },
    });

    if (!existing) { 
      return NextResponse.json(
        { error: `Agent with id "${agentId}" not found.` },
        { status: 404 }
      );
    }

    const updatedAgent = await prisma.$transaction(async (tx) => {
      const agent = await tx.agent.update({
        where: { id: agentId },
        data: { status },
      });

      const auditMessages: Record<string, string> = {
        "PAUSED":  `User manually paused the agent. Trading halted until resumed.`,
        "REVOKED": `User revoked the session key. Agent permanently disabled and cannot trade.`,
        "EXPIRED": `Session key has expired. Agent stopped by system policy.`,
        "RUNNING": `User resumed the agent. Trading is now active.`,
      };

      await tx.tradeLog.create({
        data: {
          agentId,
          type: "INFO",
          message: auditMessages[status],
        },
      });

      return agent;
    });

    return NextResponse.json(updatedAgent, { status: 200 });
  } catch (error: unknown) {
    console.error("[PATCH /api/agents/[agentId]/status] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}