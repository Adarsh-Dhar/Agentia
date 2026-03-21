import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { LogType } from "@prisma/client";

// Map incoming action strings to the correct LogType enum
const ACTION_LOG_TYPE_MAP: Record<string, LogType> = {
  BUY:            LogType.EXECUTION_BUY,
  SELL:           LogType.EXECUTION_SELL,
  PROFIT_SECURED: LogType.PROFIT_SECURED,
  ERROR:          LogType.ERROR,
  INFO:           LogType.INFO,
};

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
      return NextResponse.json(
        {
          error: `Invalid action "${action}". Must be one of: ${Object.keys(ACTION_LOG_TYPE_MAP).join(", ")}`,
        },
        { status: 400 }
      );
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
      // Only adjust PnL when a real profit/loss figure is reported
      if (typeof profit === "number" && profit !== 0) {
        await tx.agent.update({
          where: { id: agentId },
          data: { currentPnl: { increment: profit } },
        });
      }

      // Build a human-readable log message if the worker didn't supply one
      const logMessage =
        message ??
        buildDefaultMessage(action.toUpperCase(), txHash, profit);

      await tx.tradeLog.create({
        data: {
          agentId,
          type: logType,
          message: logMessage,
          txHash:  txHash  ?? null,
          price:   typeof price  === "number" ? price  : null,
          amount:  typeof amount === "number" ? amount : null,
        },
      });
    });

    // ── 5. Acknowledge receipt ────────────────────────────────────────────────
    return NextResponse.json(
      { success: true, message: "Trade report received and logged." },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error("[POST /api/internal/webhooks] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDefaultMessage(
  action: string,
  txHash?: string,
  profit?: number
): string {
  const txPart = txHash
    ? ` | TX: ${txHash}`
    : "";

  const profitPart =
    typeof profit === "number" && profit !== 0
      ? ` | PnL Δ: ${profit >= 0 ? "+" : ""}${profit.toFixed(4)} USDC`
      : "";

  switch (action) {
    case "BUY":
      return `Execution: BUY order placed on Initia.${txPart}${profitPart}`;
    case "SELL":
      return `Execution: SELL order placed on Initia.${txPart}${profitPart}`;
    case "PROFIT_SECURED":
      return `Profit secured on Initia.${txPart}${profitPart}`;
    case "ERROR":
      return `Worker reported an error.${txPart}`;
    default:
      return `Worker update: ${action}.${txPart}${profitPart}`;
  }
}