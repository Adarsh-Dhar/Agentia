/**
 * frontend/lib/signing-relay-store.ts
 *
 * In-memory store for bot → browser signing requests.
 * Lives in the Next.js server process (shared across API routes in dev/prod).
 *
 * Flow:
 *   1. Bot POSTs move_execute args → relay stores request, returns requestId
 *   2. Bot polls GET /result/{id} waiting for the browser to sign
 *   3. Browser GET /pending → receives queued requests
 *   4. Browser calls submitTxBlock, POSTs txHash/result back
 *   5. Bot poll resolves with the result
 */

export interface SigningRequest {
  id: string;
  createdAt: number;
  status: "pending" | "signed" | "failed" | "timeout";
  // move_execute args from the bot
  network: string;
  moduleAddress: string;
  moduleName: string;
  functionName: string;
  typeArgs: string[];
  args: string[];
  // filled in by the browser after signing
  result?: SigningResult;
}

export interface SigningResult {
  txHash?: string;
  error?: string;
}

const REQUEST_TTL_MS = 60_000; // 1 minute

// Single shared store (Next.js module singleton in dev and prod)
const store = new Map<string, SigningRequest>();

// Cleanup old requests on each access
function cleanup() {
  const now = Date.now();
  for (const [id, req] of store) {
    if (now - req.createdAt > REQUEST_TTL_MS) {
      if (req.status === "pending") {
        store.set(id, { ...req, status: "timeout" });
      } else {
        // Remove stale completed/failed requests after 2× TTL
        if (now - req.createdAt > REQUEST_TTL_MS * 2) {
          store.delete(id);
        }
      }
    }
  }
}

export function addRequest(
  id: string,
  params: Omit<SigningRequest, "id" | "createdAt" | "status">
): SigningRequest {
  cleanup();
  const req: SigningRequest = {
    id,
    createdAt: Date.now(),
    status: "pending",
    ...params,
  };
  store.set(id, req);
  return req;
}

export function getPending(): SigningRequest[] {
  cleanup();
  return [...store.values()].filter((r) => r.status === "pending");
}

export function getRequest(id: string): SigningRequest | undefined {
  cleanup();
  return store.get(id);
}

export function resolveRequest(id: string, result: SigningResult): boolean {
  const req = store.get(id);
  if (!req || req.status !== "pending") return false;
  store.set(id, {
    ...req,
    status: result.error ? "failed" : "signed",
    result,
  });
  return true;
}
