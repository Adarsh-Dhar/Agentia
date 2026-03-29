// frontend/app/api/agents/save-bot/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";

// ─── POST /api/agents/save-bot ────────────────────────────────────────────────
// Creates an Agent with:
//   - AgentFile records for the WebContainer bot code
//   - configuration.encryptedEnv: AES-256-GCM encrypted envConfig JSON
//
// The worker decrypts encryptedEnv at runtime to get the API keys / RPC URL.
// Keys are NEVER stored in plaintext in the database.
export async function POST(req: Request) {
  try {
    const userId = "public-user";

    const body = await req.json();
    const {
      name = "Base Sepolia Arbitrage Bot",
      files,
      configuration,
      envConfig, // BotEnvConfig — encrypted before storage
    } = body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files provided." }, { status: 400 });
    }

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

    // Build the configuration object stored in the DB.
    // envConfig is encrypted; nothing sensitive lands in plaintext.
    let mergedConfiguration: Record<string, unknown> = { ...(configuration ?? {}) };

    if (envConfig && typeof envConfig === "object") {
      // Strip empty values so we don't encrypt "" for optional fields
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(envConfig as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim().length > 0) {
          sanitized[k] = v.trim();
        }
      }

      if (Object.keys(sanitized).length > 0) {
        mergedConfiguration.encryptedEnv = encryptEnvConfig(JSON.stringify(sanitized));
      }
    }

    // Ensure the public user row exists
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: `${userId}@placeholder.agentia`,
        walletAddress: "",
      },
    });

    const agent = await prisma.agent.create({
      data: {
        name,
        userId,
        status: "STOPPED",
        configuration: mergedConfiguration as any, 
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
    return NextResponse.json(
      { error: err.message || String(error), stack: err.stack || null },
      { status: 500 }
    );
  }
}