import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AgentStatus, LogType } from "@prisma/client";

type RouteContext = {
  params: { agentId: string };
};

// ─── PATCH: Update an agent's status (PAUSED / REVOKED / EXPIRED) ─────────────
export async function PATCH(
  req: NextRequest,
  { params }: RouteContext
) {
  try {
    const { agentId } = params;
    const body = await req.json();
    const { status } = body;

    // Validate the incoming status value against the enum
    const validStatuses: AgentStatus[] = [
      AgentStatus.PAUSED,
      AgentStatus.REVOKED,
      AgentStatus.EXPIRED,
      AgentStatus.RUNNING, // Allow resuming a paused bot
    ];

    if (!status || !validStatuses.includes(status as AgentStatus)) {
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

    // 2 & 3. Update status and write audit log in a single transaction.
    // The background AI worker will read the new status on its next cycle
    // and mathematically stop trading — no direct kill switch needed.
    const updatedAgent = await prisma.$transaction(async (tx) => {
      const agent = await tx.agent.update({
        where: { id: agentId },
        data: { status: status as AgentStatus },
      });

      // Build a human-readable audit message based on the new status
      const auditMessages: Record<AgentStatus, string> = {
        [AgentStatus.PAUSED]:  `User manually paused the agent. Trading halted until resumed.`,
        [AgentStatus.REVOKED]: `User revoked the session key. Agent permanently disabled and cannot trade.`,
        [AgentStatus.EXPIRED]: `Session key has expired. Agent stopped by system policy.`,
        [AgentStatus.RUNNING]: `User resumed the agent. Trading is now active.`,
      };

      await tx.tradeLog.create({
        data: {
          agentId,
          type: LogType.INFO,
          message: auditMessages[status as AgentStatus],
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