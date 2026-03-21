import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { walletAddress, email } = body;

    // 1. Guard: wallet address is required
    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json(
        { error: "walletAddress is required." },
        { status: 400 }
      );
    }

    // 2 & 3 & 4. Upsert: update email if user exists, create row if new
    const user = await prisma.user.upsert({
      where: { walletAddress },
      update: {
        // Only overwrite email if the social login actually provided one
        ...(email ? { email } : {}),
      },
      create: {
        walletAddress,
        ...(email ? { email } : {}),
      },
    });

    // 5. Return the full User object so the frontend knows who is logged in
    return NextResponse.json(user, { status: 200 });
  } catch (error: unknown) {
    console.error("[/api/users/sync] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}