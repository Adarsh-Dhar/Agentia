import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptEnvConfig, encryptEnvConfig } from "@/lib/crypto-env";
import { RawKey } from "@initia/initia.js";
import { randomBytes } from "node:crypto";

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
      agent = await prisma.agent.findFirst({
        where:   { userId },
        orderBy: { createdAt: "desc" },
        include: { files: { orderBy: { createdAt: "asc" } } },
      });
    }

    if (!agent) {
      return NextResponse.json({ error: "No bot found." }, { status: 404 });
    }

    if (!(agent as { walletAddress?: string }).walletAddress) {
      const key = new RawKey(randomBytes(32));
      agent = await prisma.agent.update({
        where: { id: agent.id },
        data: {
          walletAddress: key.accAddress,
          sessionKeyPriv: (agent as { sessionKeyPriv?: string | null }).sessionKeyPriv ?? encryptEnvConfig(key.privateKey.toString("hex")),
        },
        include: { files: { orderBy: { createdAt: "asc" } } },
      });
    }

    const config = agent.configuration as Record<string, unknown> | null;

    // 2. Map the standard code files
    const mappedFiles = agent.files.map(f => ({
      filepath: f.filepath,
      content:  f.content,
      language: f.language,
    }));

    // 3. Decrypt the database credentials and inject the .env file!
    if (agent.envConfig) {
      try {
        const decryptedEnv = decryptEnvConfig(agent.envConfig);
        mappedFiles.push({
          filepath: ".env",
          content: decryptedEnv,
          language: "plaintext"
        });
      } catch {
        console.error("Failed to decrypt envConfig for agent:", agent.id);
      }
    }

    return NextResponse.json({
      agentId:   agent.id,
      name:      agent.name,
      status:    agent.status,
      walletAddress: (agent as { walletAddress?: string }).walletAddress ?? "",
      config:    config ?? {},
      createdAt: agent.createdAt,
      files:     mappedFiles, // <-- 4. This now safely contains the .env file
    });

  } catch (err) {
    console.error("get-latest-bot Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}