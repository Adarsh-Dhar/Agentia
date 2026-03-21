import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: { agentId: string };
};

// ─── GET: Fetch a single agent's full details ─────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: RouteContext
) {
  try {
    const { agentId } = params;

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

    // 3. 404 if the agent doesn't exist
    if (!agent) {
      return NextResponse.json(
        { error: `Agent with id "${agentId}" not found.` },
        { status: 404 }
      );
    }

    return NextResponse.json(agent, { status: 200 });
  } catch (error: unknown) {
    console.error("[GET /api/agents/[agentId]] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}

// ─── DELETE: Permanently destroy an agent ────────────────────────────────────
export async function DELETE(
  _req: NextRequest,
  { params }: RouteContext
) {
  try {
    const { agentId } = params;

    // Check the agent exists before trying to delete it
    const existing = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json(
        { error: `Agent with id "${agentId}" not found.` },
        { status: 404 }
      );
    }

    // Cascade delete is configured in the schema:
    // deleting the agent automatically wipes all associated TradeLogs.
    await prisma.agent.delete({ where: { id: agentId } });

    return NextResponse.json(
      { success: true, message: `Agent "${agentId}" and all associated logs have been deleted.` },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error("[DELETE /api/agents/[agentId]] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}