import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ─── POST /api/agents/save-bot ────────────────────────────────────────────────
// Creates an Agent with associated AgentFile records for the WebContainer bot.
export async function POST(req: Request) {
  try {

    // Use a default userId for all saves (no auth)
    const userId = "public-user";

    const body = await req.json();
    const { name = "Base Sepolia Arbitrage Bot", files, configuration } = body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files provided." }, { status: 400 });
    }

    // Validate each file entry
    for (const f of files) {
      if (!f.filepath || typeof f.filepath !== "string") {
        return NextResponse.json(
          { error: "Each file must have a filepath string." },
          { status: 400 }
        );
      }
      if (typeof f.content !== "string") {
        return NextResponse.json(
          { error: `File "${f.filepath}" is missing content.` },
          { status: 400 }
        );
      }
    }

    // Ensure the User row exists (Clerk may not have triggered the sync webhook yet)
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: `${userId}@placeholder.agentia`,
        walletAddress: "", // Patch: add required field
      },
    });

    const agent = await prisma.agent.create({
      data: {
        name,
        userId,
        status: "STOPPED",
        configuration: configuration ?? null,
        files: {
          create: files.map(
            (f: { filepath: string; content: string; language?: string }) => ({
              filepath: f.filepath,
              content: f.content,
              language: f.language ?? "plaintext",
            })
          ),
        },
      },
      include: { files: true },
    });

    return NextResponse.json({ success: true, agentId: agent.id, agent });
  } catch (error) {
    const err = error as Error;
    console.error("[POST /api/agents/save-bot] Error:", err, err.stack);
    return NextResponse.json({
      error: err.message || String(error),
      stack: err.stack || null
    }, { status: 500 });
  }
}