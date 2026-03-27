import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { VALID_STRATEGIES } from "@/lib/constant";

// ─── GET: List all agents for a user ─────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId query parameter is required." },
        { status: 400 }
      );
    }

    // Query all agents for the user, newest first
    const agents = await prisma.agent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        // Include the last log entry so the dashboard card has something to show
        logs: {
          orderBy: { timestamp: "desc" },
          take: 1,
        },
      },
    });

    return NextResponse.json(agents, { status: 200 });
  } catch (error: unknown) {
    console.error("[GET /api/agents] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}

// ─── POST: Deploy a new agent ─────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      userId,
      name,
      strategy,
      targetPair,
      spendAllowance,
      sessionExpiresAt,
      sessionKeyPub,
      sessionKeyPriv,
    } = body;

    // Guard: validate required fields
    if (!userId || !name || !strategy || !targetPair || spendAllowance == null || !sessionExpiresAt) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: userId, name, strategy, targetPair, spendAllowance, sessionExpiresAt.",
        },
        { status: 400 }
      );
    }

    if (!VALID_STRATEGIES.includes(strategy)) {
      return NextResponse.json(
        { error: `Invalid strategy. Must be one of: ${VALID_STRATEGIES.join(", ")}` },
        { status: 400 }
      );
    }

    // 2. Write the new Agent row and its boot log in a single transaction
    const agent = await prisma.$transaction(async (tx) => {
      const newAgent = await tx.agent.create({
        data: {
          userId,
          name,
          strategy, // Prisma accepts the string literal directly
          status: "RUNNING", 
          targetPair,
          spendAllowance: Number(spendAllowance),
          sessionExpiresAt: new Date(sessionExpiresAt),
          sessionKeyPub: sessionKeyPub ?? null,
          sessionKeyPriv: sessionKeyPriv ?? null,
        },
      });

      await tx.tradeLog.create({
        data: {
          agentId: newAgent.id,
          type: "INFO",
          message: `System Boot: Agent "${newAgent.name}" deployed securely on Initia. Session key active. Awaiting first market signal.`,
        },
      });

      return newAgent;
    });

    return NextResponse.json(agent, { status: 201 });
  } catch (error: unknown) {
    console.error("[POST /api/agents] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}