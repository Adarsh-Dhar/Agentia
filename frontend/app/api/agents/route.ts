import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";
import { RawKey } from "@initia/initia.js";
import { randomBytes } from "node:crypto";

function createBotWallet(): { walletAddress: string; encryptedPrivateKey: string } {
  const key = new RawKey(randomBytes(32));
  return {
    walletAddress: key.accAddress,
    encryptedPrivateKey: encryptEnvConfig(key.privateKey.toString("hex")),
  };
}

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

    const agents = await prisma.agent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        files: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        tradeLogs: {
          orderBy: { createdAt: "desc" },
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
      configuration,
      sessionKeyPriv,
    } = body;

    if (!userId || !name) {
      return NextResponse.json(
        { error: "Missing required fields: userId, name." },
        { status: 400 }
      );
    }

    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!userExists) {
      return NextResponse.json(
        { error: `User "${userId}" not found.` },
        { status: 404 }
      );
    }

    const { walletAddress, encryptedPrivateKey } = createBotWallet();

    const agent = await prisma.agent.create({
      data: {
        userId,
        name,
        status: "STOPPED",
        walletAddress,
        configuration: configuration ?? null,
        sessionKeyPriv: sessionKeyPriv ? encryptEnvConfig(String(sessionKeyPriv)) : encryptedPrivateKey,
      },
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