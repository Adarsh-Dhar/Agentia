import { NextRequest, NextResponse } from "next/server";

function normalizeGatewayBase(raw: string): string {
  let base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (!/\/mcp$/i.test(base)) base += "/mcp";
  return base;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ server: string; tool: string }> },
) {
  const { server, tool } = await ctx.params;
  const gateway = normalizeGatewayBase(
    process.env.MCP_GATEWAY_URL || process.env.NEXT_PUBLIC_MCP_GATEWAY_URL || "",
  );

  if (!gateway) {
    return NextResponse.json(
      {
        error: "MCP gateway not configured",
        hint: "Set MCP_GATEWAY_URL in frontend server environment.",
      },
      { status: 500 },
    );
  }

  const upstreamUrl = `${gateway}/${server}/${tool}`;

  let payload: unknown = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        "Bypass-Tunnel-Reminder": "true",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const contentType = upstream.headers.get("content-type") || "application/json";
    const bodyText = await upstream.text();

    return new NextResponse(bodyText, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: "Upstream MCP request failed",
        upstreamUrl,
        details: message,
      },
      { status: 502 },
    );
  }
}
