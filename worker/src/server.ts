import express from "express";
import { startAgent, stopAgent, getAgentStatus, listRunningAgents } from "./engine.js";

const app = express();
app.use(express.json());

const SECRET = process.env.WORKER_SECRET ?? "dev-worker-secret";

// Simple auth middleware — frontend must send the same secret
function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Health check (no auth needed) ────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", running: listRunningAgents() });
});

// ── Start an agent ────────────────────────────────────────────────────────────
app.post("/agents/:id/start", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await startAgent(id.toString());
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] startAgent error for ${id}:`, message);
    res.status(500).json({ success: false, error: message });
  }
});

// ── Stop an agent ─────────────────────────────────────────────────────────────
app.post("/agents/:id/stop", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await stopAgent(id.toString());
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] stopAgent error for ${id}:`, message);
    res.status(500).json({ success: false, error: message });
  }
});

// ── Agent status ──────────────────────────────────────────────────────────────
app.get("/agents/:id/status", requireAuth, (req, res) => {
  res.json(getAgentStatus(req.params.toString()));
});

export function startServer(port: number) {
  app.listen(port, () => {
    console.log(`🌐 Worker HTTP server listening on port ${port}`);
  });
}