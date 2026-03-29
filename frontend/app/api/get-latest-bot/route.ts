/**
 * frontend/app/api/get-latest-bot/route.ts
 *
 * Returns the most recently generated bot's files from the DB.
 * Prefers bots created by the Bot Configurator (source=bot-configurator*),
 * falls back to any bot.
 *
 * GET /api/get-latest-bot?agentId=xxx   (optional specific agent)
 * GET /api/get-latest-bot               (latest bot)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const agentId = req.nextUrl.searchParams.get("agentId");
    const userId  = "public-user";

    let agent;

    if (agentId) {
      agent = await prisma.agent.findUnique({
        where:   { id: agentId },
        include: { files: { orderBy: { createdAt: "asc" } } },
      });
    } else {
      // Get the latest bot — prefer configurator-generated ones
      agent = await prisma.agent.findFirst({
        where:   { userId },
        orderBy: { createdAt: "desc" },
        include: { files: { orderBy: { createdAt: "asc" } } },
      });
    }

    if (!agent) {
      return NextResponse.json({ error: "No bot found." }, { status: 404 });
    }

    const config = agent.configuration as Record<string, unknown> | null;

    console.log(`[GET /api/get-latest-bot] Returning bot ${agent.id} with ${agent.files.length} files. with code: ${agent.files.map(f => f.filepath).join(", ")}`);

    return NextResponse.json({
      agentId:   agent.id,
      name:      agent.name,
      status:    agent.status,
      config:    config ?? {},
      createdAt: agent.createdAt,
      files: agent.files.map(f => ({
        filepath: f.filepath,
        content:  f.content,
        language: f.language,
      })),
    });

  } catch (err) {
    console.error("[GET /api/get-latest-bot]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error." },
      { status: 500 }
    );
  }
}