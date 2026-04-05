/**
 * frontend/app/api/signing-relay/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { addRequest, getPending } from "@/lib/signing-relay-store";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { network, moduleAddress, moduleName, functionName, typeArgs = [], args = [] } = body;

    if (!moduleAddress || !moduleName || !functionName) {
      return NextResponse.json({ error: "moduleAddress, moduleName, and functionName are required." }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const request = addRequest(id, {
      network: network ?? "initia-testnet",
      moduleAddress,
      moduleName,
      functionName,
      typeArgs,
      args,
    });

    return NextResponse.json({ requestId: id, status: request.status }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  const pending = getPending();
  return NextResponse.json({ requests: pending }, { headers: { "Cache-Control": "no-store" } });
}
