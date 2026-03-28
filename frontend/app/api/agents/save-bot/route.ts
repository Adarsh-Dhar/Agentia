import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { name = "Base Sepolia Arbitrage Bot", files } = body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    // Ensure the User exists in our DB (handles cases where sync hasn't occurred)
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, email: "placeholder@email.com", name: "User" },
    });

    // Create the Agent and save all associated files
    const agent = await prisma.agent.create({
      data: {
        name,
        userId,
        status: "STOPPED",
        files: {
          create: files.map((f: { filepath: string; content: string; language: string }) => ({
            filepath: f.filepath,
            content: f.content,
            language: f.language || "plaintext",
          })),
        },
      },
    });

    return NextResponse.json({ success: true, agentId: agent.id });
  } catch (error) {
    console.error("Failed to save bot:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}