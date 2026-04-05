/**
 * src/mcp_bridge.ts
 *
 * MCP gateway client for the bot.
 *
 * Read-only tools (move_view, etc.) call the MCP gateway directly.
 *
 * move_execute is signed by the browser via the AutoSign Ghost Wallet
 * using InterwovenKit's submitTxBlock — the bot NEVER holds a private key.
 *
 * Signing flow:
 *   1. callMcpTool("initia", "move_execute", args)
 *   2. Bot POSTs args to /api/signing-relay (Next.js)
 *   3. Browser's SigningRelayConsumer picks it up, calls submitTxBlock
 *   4. Bot polls /api/signing-relay/{id} until the result arrives
 *   5. Returns { txHash } on success
 */

const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp";
const MCP_GATEWAY_UPSTREAM_URL = process.env.MCP_GATEWAY_UPSTREAM_URL ?? "";

// Base URL for the signing relay (same origin as MCP_GATEWAY_URL when using
// the Next.js mcp-proxy, i.e. http://localhost:3000/api/mcp-proxy → localhost:3000)
function deriveRelayBase(): string {
  const raw = String(MCP_GATEWAY_URL ?? "").trim();
  // If it's the Next.js proxy path, extract origin
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    // Relative path or localhost fallback
    return "http://localhost:3000";
  }
}

const RELAY_BASE = deriveRelayBase();

// ── Read-only gateway call ────────────────────────────────────────────────────

function normalizeGatewayBase(raw: string): string {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  return /\/mcp$/i.test(value) ? value : `${value}/mcp`;
}

function buildCandidateUrls(base: string, server: string, tool: string): string[] {
  const withMcp = /\/mcp$/i.test(base) ? base : base + "/mcp";
  const withoutMcp = withMcp.replace(/\/mcp$/i, "");
  return [
    withMcp + "/" + server + "/" + tool,
    withoutMcp + "/" + server + "/" + tool,
  ];
}

async function callGateway(
  server: string,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const base = normalizeGatewayBase(MCP_GATEWAY_URL);
  const urls = buildCandidateUrls(base, server, tool);

  let lastError = "unknown error";
  for (const url of urls) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        "Bypass-Tunnel-Reminder": "true",
        ...(MCP_GATEWAY_UPSTREAM_URL
          ? { "x-mcp-upstream-url": MCP_GATEWAY_UPSTREAM_URL }
          : {}),
      },
      body: JSON.stringify(args ?? {}),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      if (res.status === 404) continue;
      throw new Error(`MCP ${server}/${tool} ${lastError}`);
    }

    return res.json();
  }

  throw new Error(`MCP ${server}/${tool} ${lastError}`);
}

// ── Signing relay (move_execute only) ────────────────────────────────────────

const RELAY_POLL_INTERVAL_MS = 600;
const RELAY_TIMEOUT_MS = 90_000; // 90 s — allow time for AutoSign to sign

async function callSigningRelay(
  args: Record<string, unknown>
): Promise<unknown> {
  // 1. Submit the signing request
  const submitUrl = `${RELAY_BASE}/api/signing-relay`;
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      network: args.network ?? "initia-testnet",
      moduleAddress: args.address,
      moduleName: args.module,
      functionName: args.function,
      typeArgs: args.type_args ?? [],
      args: args.args ?? [],
    }),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => "");
    throw new Error(
      `Signing relay submit failed (${submitRes.status}): ${errText.slice(0, 200)}`
    );
  }

  const { requestId } = (await submitRes.json()) as { requestId: string };
  if (!requestId) throw new Error("Signing relay did not return a requestId.");

  console.log(`[MCP] move_execute queued for browser signing (requestId=${requestId})`);

  // 2. Poll for result
  const deadline = Date.now() + RELAY_TIMEOUT_MS;
  const resultUrl = `${RELAY_BASE}/api/signing-relay/${requestId}`;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RELAY_POLL_INTERVAL_MS));

    const pollRes = await fetch(resultUrl, {
      headers: { "Cache-Control": "no-store" },
    });

    if (!pollRes.ok) {
      throw new Error(`Signing relay poll failed (${pollRes.status}).`);
    }

    const data = (await pollRes.json()) as {
      status: string;
      result?: { txHash?: string; error?: string };
    };

    if (data.status === "signed" && data.result?.txHash) {
      console.log(`[MCP] move_execute signed: ${data.result.txHash}`);
      return { txHash: data.result.txHash, success: true };
    }

    if (data.status === "failed") {
      throw new Error(
        `Signing failed: ${data.result?.error ?? "unknown error"}`
      );
    }

    if (data.status === "timeout") {
      throw new Error(
        "Signing request timed out. Ensure AutoSign is enabled in the browser."
      );
    }
    // status === "pending" → keep polling
  }

  throw new Error(
    `Signing relay timed out after ${RELAY_TIMEOUT_MS / 1000}s. ` +
    "Check that the Agentia browser tab is open with AutoSign enabled."
  );
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // move_execute is always routed through the browser signing relay.
  // The bot never signs transactions itself — AutoSign Ghost Wallet handles it.
  if (server === "initia" && tool === "move_execute") {
    return callSigningRelay(args);
  }

  // All other tools (read-only) go directly through the MCP gateway.
  return callGateway(server, tool, args);
}
