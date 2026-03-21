import 'dotenv/config';
console.log("DATABASE_URL:", process.env.DATABASE_URL);
import { PrismaClient } from "./lib/generated/prisma/client.ts";
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as any);

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET ?? "dev-secret";

const prisma = new PrismaClient({ adapter });

// ─── Colour helpers ───────────────────────────────────────────────────────────

const c = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ─── Test runner state ────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  process.stdout.write(`  ${c.dim("›")} ${name} ... `);
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(c.green("PASS") + c.dim(` (${ms}ms)`));
    results.push({ name, passed: true, durationMs: ms });
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(c.red("FAIL"));
    console.log(`     ${c.red("↳")} ${msg}`);
    results.push({ name, passed: false, error: msg, durationMs: ms });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// ─── Shared state (filled in as tests run) ────────────────────────────────────

let userId   = "";
let agentId  = "";

// ─── Test Suite ───────────────────────────────────────────────────────────────

async function runAll() {
  console.log();
  console.log(c.bold(c.cyan("━━━ API Route Test Suite ━━━")));
  console.log(c.dim(`  Target : ${BASE_URL}`));
  console.log(c.dim(`  DB     : ${process.env.DATABASE_URL ?? "(using .env)"}`));
  console.log();

  // ── Cleanup stale test data from previous runs ──────────────────────────────
  await prisma.user.deleteMany({
    where: { walletAddress: { startsWith: "0xTEST" } },
  });
  console.log(c.dim("  ✓ Wiped stale test data from previous runs\n"));

  // ════════════════════════════════════════════════════════════════════════════
  console.log(c.bold("1 · POST /api/users/sync"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("creates a new user with wallet + email", async () => {
    const { status, data } = await api("POST", "/api/users/sync", {
      walletAddress: "0xTEST_WALLET_001",
      email: "test@hackathon.dev",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const user = data as { id: string; walletAddress: string; email: string };
    assert(user.walletAddress === "0xTEST_WALLET_001", "walletAddress mismatch");
    assert(user.email === "test@hackathon.dev", "email mismatch");
    userId = user.id;

    // Verify it's actually in the DB
    const dbUser = await prisma.user.findUnique({ where: { id: userId } });
    assert(dbUser !== null, "User not found in DB after upsert");
  });

  await test("upserts — updates email on second call with same wallet", async () => {
    const { status, data } = await api("POST", "/api/users/sync", {
      walletAddress: "0xTEST_WALLET_001",
      email: "updated@hackathon.dev",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const user = data as { email: string };
    assert(user.email === "updated@hackathon.dev", "Email was not updated");

    const dbUser = await prisma.user.findUnique({
      where: { walletAddress: "0xTEST_WALLET_001" },
    });
    assert(dbUser?.email === "updated@hackathon.dev", "DB email not updated");
  });

  await test("returns 400 when walletAddress is missing", async () => {
    const { status } = await api("POST", "/api/users/sync", { email: "no-wallet@test.dev" });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("2 · POST /api/agents (deploy)"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("deploys a new agent with status RUNNING", async () => {
    const payload = {
      userId,
      name:             "INIT Sniffer Test Bot",
      strategy:         "MEME_SNIPER",
      targetPair:       "INIT/USDC",
      spendAllowance:   500,
      sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), // +1 day
      sessionKeyPub:    "0xSESSION_KEY_PUB_001",
    };
    const { status, data } = await api("POST", "/api/agents", payload);
    assert(status === 201, `Expected 201, got ${status}`);
    const agent = data as { id: string; status: string; name: string };
    assert(agent.status === "RUNNING", `Expected RUNNING, got ${agent.status}`);
    agentId = agent.id;

    // Verify agent row in DB
    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent !== null, "Agent not found in DB");
    assert(dbAgent!.spendAllowance === 500, "spendAllowance mismatch");

    // Verify the boot TradeLog was created in the same transaction
    const bootLog = await prisma.tradeLog.findFirst({
      where: { agentId, type: "INFO" },
    });
    assert(bootLog !== null, "Boot TradeLog was not created");
    assert(bootLog!.message.includes("System Boot"), "Boot message content wrong");
  });

  await test("returns 400 when required fields are missing", async () => {
    const { status } = await api("POST", "/api/agents", {
      userId,
      name: "Incomplete Bot",
      // missing strategy, targetPair, spendAllowance, sessionExpiresAt
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test("returns 400 for an invalid strategy enum", async () => {
    const { status } = await api("POST", "/api/agents", {
      userId,
      name:             "Bad Strategy Bot",
      strategy:         "MOON_MATH",
      targetPair:       "INIT/USDC",
      spendAllowance:   100,
      sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("3 · GET /api/agents (list)"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("returns an array of agents for the user", async () => {
    const { status, data } = await api("GET", `/api/agents?userId=${userId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    const agents = data as unknown[];
    assert(Array.isArray(agents), "Response is not an array");
    assert(agents.length >= 1, "Expected at least 1 agent");
  });

  await test("returns an empty array for a user with no agents", async () => {
    const { status, data } = await api("GET", "/api/agents?userId=00000000-0000-0000-0000-000000000000");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data) && (data as unknown[]).length === 0, "Expected empty array");
  });

  await test("returns 400 when userId is missing", async () => {
    const { status } = await api("GET", "/api/agents");
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("4 · GET /api/agents/[agentId]"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("returns the correct agent by ID", async () => {
    const { status, data } = await api("GET", `/api/agents/${agentId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    const agent = data as { id: string; name: string };
    assert(agent.id === agentId, "Returned wrong agent ID");
    assert(agent.name === "INIT Sniffer Test Bot", "Agent name mismatch");
  });

  await test("returns 404 for a non-existent agent ID", async () => {
    const { status } = await api("GET", "/api/agents/00000000-0000-0000-0000-000000000000");
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("5 · PATCH /api/agents/[agentId]/status"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("pauses the agent and writes an audit log", async () => {
    const { status, data } = await api("PATCH", `/api/agents/${agentId}/status`, {
      status: "PAUSED",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const agent = data as { status: string };
    assert(agent.status === "PAUSED", `Expected PAUSED, got ${agent.status}`);

    // Verify DB
    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent?.status === "PAUSED", "DB status not updated to PAUSED");

    // Verify audit log
    const auditLog = await prisma.tradeLog.findFirst({
      where: { agentId, message: { contains: "paused" } },
    });
    assert(auditLog !== null, "Pause audit log not written to DB");
  });

  await test("resumes the agent back to RUNNING", async () => {
    const { status, data } = await api("PATCH", `/api/agents/${agentId}/status`, {
      status: "RUNNING",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const agent = data as { status: string };
    assert(agent.status === "RUNNING", `Expected RUNNING, got ${agent.status}`);
  });

  await test("revokes the agent's session key", async () => {
    const { status, data } = await api("PATCH", `/api/agents/${agentId}/status`, {
      status: "REVOKED",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const agent = data as { status: string };
    assert(agent.status === "REVOKED", `Expected REVOKED, got ${agent.status}`);

    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent?.status === "REVOKED", "DB status not updated to REVOKED");
  });

  await test("returns 400 for an invalid status value", async () => {
    const { status } = await api("PATCH", `/api/agents/${agentId}/status`, {
      status: "YOLO",
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test("returns 404 for a non-existent agent", async () => {
    const { status } = await api("PATCH", "/api/agents/00000000-0000-0000-0000-000000000000/status", {
      status: "PAUSED",
    });
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("6 · GET /api/agents/[agentId]/logs"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("returns an array of logs (boot log + audit logs)", async () => {
    const { status, data } = await api("GET", `/api/agents/${agentId}/logs`);
    assert(status === 200, `Expected 200, got ${status}`);
    const logs = data as unknown[];
    assert(Array.isArray(logs), "Response is not an array");
    // We've created: boot log + pause audit + resume audit + revoke audit = 4 logs minimum
    assert(logs.length >= 4, `Expected ≥4 logs, got ${logs.length}`);
  });

  await test("respects the ?limit= query param (cap at 50)", async () => {
    const { status, data } = await api("GET", `/api/agents/${agentId}/logs?limit=2`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert((data as unknown[]).length <= 2, "limit param was not respected");
  });

  await test("returns 404 for a non-existent agent", async () => {
    const { status } = await api("GET", "/api/agents/00000000-0000-0000-0000-000000000000/logs");
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("7 · POST /api/internal/webhooks"));
  // ════════════════════════════════════════════════════════════════════════════

  const authHeader = { Authorization: `Bearer ${WEBHOOK_SECRET}` };

  await test("rejects requests with no auth header (401)", async () => {
    const { status } = await api("POST", "/api/internal/webhooks", {
      agentId, action: "BUY",
    });
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test("rejects requests with a wrong secret (401)", async () => {
    const { status } = await api("POST", "/api/internal/webhooks",
      { agentId, action: "BUY" },
      { Authorization: "Bearer totally-wrong-secret" }
    );
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test("records a BUY execution and writes a trade log", async () => {
    const { status } = await api(
      "POST", "/api/internal/webhooks",
      {
        agentId,
        action:  "BUY",
        txHash:  "0xABC123DEF456",
        price:   1.45,
        amount:  100,
        profit:  0,
      },
      authHeader
    );
    assert(status === 200, `Expected 200, got ${status}`);

    const log = await prisma.tradeLog.findFirst({
      where: { agentId, type: "EXECUTION_BUY" },
    });
    assert(log !== null, "BUY trade log not found in DB");
    assert(log!.txHash === "0xABC123DEF456", "txHash not stored correctly");
  });

  await test("records a SELL + updates PnL correctly", async () => {
    // Get baseline PnL
    const before = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { currentPnl: true },
    });
    const basePnl = before!.currentPnl;

    const { status } = await api(
      "POST", "/api/internal/webhooks",
      {
        agentId,
        action:  "SELL",
        txHash:  "0xSELL_TX_789",
        price:   1.52,
        amount:  100,
        profit:  7.0,
      },
      authHeader
    );
    assert(status === 200, `Expected 200, got ${status}`);

    // Verify PnL incremented in DB
    const after = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { currentPnl: true },
    });
    assert(
      Math.abs(after!.currentPnl - (basePnl + 7.0)) < 0.0001,
      `PnL mismatch — expected ${basePnl + 7.0}, got ${after!.currentPnl}`
    );

    // Verify trade log
    const log = await prisma.tradeLog.findFirst({
      where: { agentId, type: "EXECUTION_SELL" },
    });
    assert(log !== null, "SELL trade log not written to DB");
  });

  await test("returns 400 for an invalid action string", async () => {
    const { status } = await api(
      "POST", "/api/internal/webhooks",
      { agentId, action: "HODL" },
      authHeader
    );
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test("returns 404 when agentId doesn't exist", async () => {
    const { status } = await api(
      "POST", "/api/internal/webhooks",
      { agentId: "00000000-0000-0000-0000-000000000000", action: "BUY" },
      authHeader
    );
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log();
  console.log(c.bold("8 · DELETE /api/agents/[agentId]  (cascade check)"));
  // ════════════════════════════════════════════════════════════════════════════

  await test("deletes the agent and cascades to all trade logs", async () => {
    // Count logs before deletion
    const logCountBefore = await prisma.tradeLog.count({ where: { agentId } });
    assert(logCountBefore > 0, "Sanity check: should have logs before delete");

    const { status, data } = await api("DELETE", `/api/agents/${agentId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    const body = data as { success: boolean };
    assert(body.success === true, "success flag not true");

    // Agent gone from DB
    const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(dbAgent === null, "Agent still exists in DB after DELETE");

    // All associated logs gone too (cascade)
    const logCountAfter = await prisma.tradeLog.count({ where: { agentId } });
    assert(logCountAfter === 0, `${logCountAfter} orphaned logs remain after cascade delete`);
  });

  await test("returns 404 when deleting a non-existent agent", async () => {
    const { status } = await api("DELETE", `/api/agents/${agentId}`); // already deleted
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ─── Final cleanup ─────────────────────────────────────────────────────────
  await prisma.user.deleteMany({
    where: { walletAddress: { startsWith: "0xTEST" } },
  });

  // ─── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log();
  console.log(c.bold("━━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(
    `  ${c.green(`${passed} passed`)}  ${failed > 0 ? c.red(`${failed} failed`) : c.dim("0 failed")}  ${c.dim(`(${totalMs}ms total)`)}`
  );

  if (failed > 0) {
    console.log();
    console.log(c.red("  Failed tests:"));
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  ${c.red("✗")} ${r.name}`);
        console.log(`    ${c.dim(r.error ?? "")}`);
      });
  }

  console.log();
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(async (err) => {
  console.error(c.red("\n  Fatal error running test suite:"), err);
  await prisma.$disconnect();
  process.exit(1);
});