import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ACTION_LOG_TYPE_MAP } from "@/lib/constant";
import { LogType } from "@/lib/generated/prisma/enums";




// ─── POST: Receive trade reports from the off-chain AI worker ─────────────────
// This route is NEVER called by the frontend. It is the private channel
// through which the background worker pushes results back to the dashboard.
export async function POST(req: NextRequest) {
  try {
    // ── 1. Security Gate ──────────────────────────────────────────────────────
    // The worker must send the shared secret in the Authorization header.
    // Without this check, anyone could forge profitable trades on the dashboard.

    const authHeader = req.headers.get("authorization");
    const expectedToken = `Bearer ${process.env.INTERNAL_WEBHOOK_SECRET}`;
    console.log("Expected:", expectedToken);
    console.log("Received:", authHeader);

    if (!authHeader || authHeader !== expectedToken) {
      console.warn("[/api/internal/webhooks] Unauthorized attempt blocked.");
      return NextResponse.json(
        { error: "Unauthorized." },
        { status: 401 }
      );
    }

    // ── 2. Parse & validate payload ───────────────────────────────────────────
    const body = await req.json();
    const { agentId, action, txHash, profit, price, amount, message } = body;

    if (!agentId || !action) {
      return NextResponse.json(
        { error: "agentId and action are required." },
        { status: 400 }
      );
    }

    const logType = ACTION_LOG_TYPE_MAP[action.toUpperCase()];
    if (!logType) {
      return NextResponse.json({ error: `Invalid action "${action}".` }, { status: 400 });
    }

    // Confirm the agent exists before writing anything
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, currentPnl: true },
    });

    if (!agent) {
      return NextResponse.json(
        { error: `Agent with id "${agentId}" not found.` },
        { status: 404 }
      );
    }

    // ── 3 & 4. Update PnL and write the trade log atomically ─────────────────
    await prisma.$transaction(async (tx) => {
      if (typeof profit === "number" && profit !== 0) {
        await tx.agent.update({
          where: { id: agentId },
          data: { currentPnl: { increment: profit } },
        });
      }

      const logMessage = message ?? buildDefaultMessage(action.toUpperCase(), txHash, profit);

      await tx.tradeLog.create({
        data: {
          agentId,
          type: logType as LogType, // Passes the string directly to Prisma
          message: logMessage,
          txHash:  txHash  ?? null,
          price:   typeof price  === "number" ? price  : null,
          amount:  typeof amount === "number" ? amount : null,
        },
      });
    });

    // ── 5. Acknowledge receipt ────────────────────────────────────────────────
    return NextResponse.json({ success: true }, { status: 200 });
  } catch {
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDefaultMessage(action: string, txHash?: string, profit?: number): string {
  const txPart = txHash ? ` | TX: ${txHash}` : "";
  const profitPart = typeof profit === "number" && profit !== 0 
    ? ` | PnL Δ: ${profit >= 0 ? "+" : ""}${profit.toFixed(4)} USDC` : "";

  switch (action) {
    case "BUY": return `Execution: BUY order placed on Initia.${txPart}${profitPart}`;
    case "SELL": return `Execution: SELL order placed on Initia.${txPart}${profitPart}`;
    case "PROFIT_SECURED": return `Profit secured on Initia.${txPart}${profitPart}`;
    case "ERROR": return `Worker reported an error.${txPart}`;
    default: return `Worker update: ${action}.${txPart}${profitPart}`;
  }
}