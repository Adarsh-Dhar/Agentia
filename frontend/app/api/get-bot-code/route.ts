/**
 * frontend/app/api/get-bot-code/route.ts
 *
 * Serves the Base Sepolia MCP arbitrage bot files so the WebContainer
 * can install deps and run them.  The Python bot talks to 1inch / Webacy /
 * GOAT-EVM via MCP servers that the user must supply credentials for.
 *
 * All file content is inlined here so the route works without filesystem
 * access to the /agents directory in production.
 */

import { NextResponse } from "next/server";
import { assembleBotFiles } from "./bot-files";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";

export async function POST(req: Request) {
  // If called with a body, use envConfig/configuration from the request, else just save files
  let envConfig = undefined;
  let configuration = undefined;
  let name = "Base Sepolia Arbitrage Bot";
  try {
    if (req && typeof req.json === "function") {
      try {
        const body = await req.json();
        if (body) {
          envConfig = body.envConfig;
          configuration = body.configuration;
          if (body.name) name = body.name;
        }
      } catch {}
    }
  } catch {}

  const files = assembleBotFiles();
  console.log(`[GET /api/get-bot-code]`, files);

  // Save to DB (same as save-bot logic)
  try {
    const userId = "public-user";

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
          { error: `File \"${f.filepath}\" is missing content.` },
          { status: 400 }
        );
      }
    }

    // Build the configuration object stored in the DB.
    // envConfig is encrypted; nothing sensitive lands in plaintext.
    let mergedConfiguration = { ...(configuration ?? {}) };

    if (envConfig && typeof envConfig === "object") {
      // Strip empty values so we don't encrypt "" for optional fields
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(envConfig)) {
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
        configuration: mergedConfiguration,
        files: {
          create: files.map(
            (f) => ({
              filepath: f.filepath,
              content: f.content,
              language: f.filepath?.split(".").pop() ?? "plaintext",
            })
          ),
        },
      },
      include: { files: true },
    });

    return NextResponse.json({
      thoughts:
        "Base Sepolia MCP arbitrage bot: borrows USDC via Aave flash loan, " +
        "swaps USDC→WETH→USDC via 1inch, repays loan + 0.09 % fee. " +
        "Token risk checked with Webacy before every execution. " +
        "Set SIMULATION_MODE=true to disable sending transactions.",
      files,
      verified: true,
      agentId: agent.id,
      agent,
      saved: true,
    });
  } catch (error) {
    const err = error;
    console.error("[POST /api/get-bot-code] Error:", err);
    return NextResponse.json(
      { error: err|| String(error)|| null },
      { status: 500 }
    );
  }
}