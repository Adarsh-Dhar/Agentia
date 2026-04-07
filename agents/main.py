"""
main.py — Meta-Agent API server.
Start: uvicorn main:app --reload

New endpoints added for Planner Agent architecture:
  POST /create-bot-chat  — multi-turn Planner loop (sends/receives full history)

Existing endpoints preserved:
  POST /create-bot       — single-shot legacy entry
  GET  /health
  POST /mcp/{server}/{tool}
"""

import os
import json
import asyncio
import time
import traceback
from uuid import uuid4
from datetime import datetime, timezone
from urllib import request as urllib_request
from urllib.error import URLError, HTTPError
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from orchestrator import MetaAgent

app = FastAPI(title="DeFi Bot Meta-Agent", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

agent = MetaAgent()

CREATE_BOT_TIMEOUT_SECONDS = float(
    os.environ.get("META_AGENT_CREATE_BOT_TIMEOUT_SECONDS", "240")
)


# ─── Request / Response Models ────────────────────────────────────────────────

class PromptRequest(BaseModel):
    prompt: str


class ChatMessage(BaseModel):
    role: str       # "user" | "assistant" | "system"
    content: str


class ChatRequest(BaseModel):
    """
    Multi-turn Planner Agent request.
    The frontend sends the ENTIRE conversation history on every turn so the
    Planner has full context.
    """
    messages: List[ChatMessage]
    request_id: Optional[str] = None


class ChatResponse(BaseModel):
    """
    Three possible shapes:
      1. status="clarification_needed"  → show question to user, wait for reply
      2. status="ready"                 → bot generated successfully
      3. status="error"                 → surface to user
    """
    status: str          # "clarification_needed" | "ready" | "error"
    question: Optional[str] = None       # when status == "clarification_needed"
    agent_id: Optional[str] = None      # when status == "ready" (future DB save)
    bot_name: Optional[str] = None
    files: Optional[List[Dict[str, Any]]] = None
    intent: Optional[Dict[str, Any]] = None
    thoughts: Optional[str] = None
    message: Optional[str] = None       # when status == "error"


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _mcp_ok(payload: dict) -> dict:
    return {
        "result": {
            "isError": False,
            "content": [{"type": "text", "text": json.dumps(payload)}],
        }
    }


def _safe_json_get(url: str, timeout: float = 8.0) -> Optional[dict]:
    try:
        with urllib_request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, ValueError):
        return None


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "version": "3.0.0"}


@app.get("/mcp/health")
async def mcp_health():
    return {"status": "ok", "service": "mcp-http-compat"}


@app.post("/mcp/{server}/{tool}")
async def mcp_tool(server: str, tool: str, body: dict, request: Request):
    """HTTP MCP compatibility endpoint for generated bots."""
    server_l = server.strip().lower()
    tool_l   = tool.strip().lower()

    # Webacy / GoPlus risk compatibility
    if server_l in {"webacy", "goplus"} and tool_l in {"getrisk", "get_token_risk", "token_risk"}:
        address = str(body.get("address") or "")
        chain   = str(body.get("chain") or "unknown")
        return _mcp_ok({
            "address": address, "chain": chain,
            "risk": "medium", "riskScore": 35, "score": 35,
            "available": True, "source": "mcp-http-compat",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    if server_l == "initia" and tool_l == "move_execute":
        session_key = (
            str(request.headers.get("x-session-key") or "").strip()
            or str(body.get("sessionKey") or body.get("session_key") or "").strip()
            or str(os.environ.get("INITIA_KEY") or "").strip()
        )
        transaction = body.get("transaction") if isinstance(body.get("transaction"), dict) else {}
        calls       = transaction.get("calls") if isinstance(transaction, dict) and isinstance(transaction.get("calls"), list) else []
        first_call  = calls[0] if calls and isinstance(calls[0], dict) else {}
        return _mcp_ok({
            "ok": True, "status": "executed",
            "tx_hash": f"0xinitia{uuid4().hex[:24]}",
            "tool": "move_execute",
            "module": str(body.get("module") or first_call.get("module") or "flash_loan"),
            "function": str(body.get("function") or first_call.get("function") or "borrow"),
            "simulated": True, "source": "mcp-http-compat",
            "session_key_provided": bool(session_key),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    if server_l == "initia" and tool_l == "move_view":
        raw_args = body.get("args")
        args     = raw_args if isinstance(raw_args, list) else []
        is_ons   = (
            str(body.get("module") or "").lower() in {"initia_names", "ons", "name_service"}
            and str(body.get("function") or "").lower() in {"resolve", "get_address", "lookup"}
        )
        if is_ons:
            name_query = str(args[0] if args else "").strip().lower()
            return _mcp_ok({
                "ok": True, "tool": "move_view",
                "address": f"init1mock_{name_query.replace('.init', '').replace('.', '_')}",
                "ons_name": name_query, "resolved": True,
                "source": "mcp-http-compat-ons-mock",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
        return _mcp_ok({
            "ok": True, "tool": "move_view",
            "price": "1.234500", "price_num": 1.2345,
            "source": "mcp-http-compat",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    return _mcp_ok({
        "available": False, "server": server, "tool": tool,
        "message": "Tool not implemented on local MCP compatibility endpoint.",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ── Single-shot (legacy) ──────────────────────────────────────────────────────

@app.post("/create-bot")
async def create_bot(req: PromptRequest, request: Request):
    """Single-shot bot creation (no multi-turn, kept for backwards compat)."""
    request_id = (request.headers.get("x-request-id") or uuid4().hex[:8]).strip()[:12]
    started_at = time.monotonic()
    print(f"[create-bot] [{request_id}] prompt_chars={len(req.prompt)} timeout={CREATE_BOT_TIMEOUT_SECONDS}s")

    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(agent.build_bot, req.prompt, request_id),
            timeout=CREATE_BOT_TIMEOUT_SECONDS,
        )
        elapsed = round(time.monotonic() - started_at, 2)
        print(f"[create-bot] [{request_id}] Done in {elapsed}s")
        return result
    except asyncio.TimeoutError:
        elapsed = round(time.monotonic() - started_at, 2)
        print(f"[create-bot] [{request_id}] ❌ Timeout after {elapsed}s")
        raise HTTPException(
            status_code=504,
            detail=(
                f"Bot generation timed out after {CREATE_BOT_TIMEOUT_SECONDS:.0f}s "
                f"(request_id={request_id})."
            ),
        )
    except Exception as e:
        elapsed = round(time.monotonic() - started_at, 2)
        print(f"[create-bot] [{request_id}] ❌ Error after {elapsed}s: {e}")
        traceback.print_exc()
        status_code = 504 if "timeout" in str(e).lower() else 500
        raise HTTPException(status_code=status_code, detail=str(e))


# ── Multi-turn Planner Agent endpoint ─────────────────────────────────────────

@app.post("/create-bot-chat", response_model=ChatResponse)
async def create_bot_chat(req: ChatRequest, request: Request):
    """
    Multi-turn Planner Agent entry point.

    The frontend sends the complete conversation history on every call.
    The server runs the Planner → MCP → Code Generator loop and returns:

      {"status": "clarification_needed", "question": "..."}
        → frontend appends the question as an assistant message and waits

      {"status": "ready", "files": [...], "intent": {...}, "thoughts": "..."}
        → frontend shows the success card and opens Bot IDE

      {"status": "error", "message": "..."}
        → frontend shows error to user
    """
    request_id = req.request_id or (request.headers.get("x-request-id") or uuid4().hex[:8]).strip()[:12]
    started_at = time.monotonic()
    turns      = len(req.messages)
    print(f"[create-bot-chat] [{request_id}] turns={turns} timeout={CREATE_BOT_TIMEOUT_SECONDS}s")

    # Convert Pydantic models to plain dicts for the orchestrator
    history: List[Dict[str, str]] = [
        {"role": m.role, "content": m.content} for m in req.messages
    ]

    try:
        raw_result: Dict[str, Any] = await asyncio.wait_for(
            asyncio.to_thread(agent.build_bot_with_history, history, request_id),
            timeout=CREATE_BOT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        elapsed = round(time.monotonic() - started_at, 2)
        print(f"[create-bot-chat] [{request_id}] ❌ Timeout after {elapsed}s")
        return ChatResponse(
            status="error",
            message=(
                f"Bot generation timed out after {CREATE_BOT_TIMEOUT_SECONDS:.0f}s. "
                "Try simplifying your request or check the Meta-Agent server."
            ),
        )
    except Exception as exc:
        elapsed = round(time.monotonic() - started_at, 2)
        print(f"[create-bot-chat] [{request_id}] ❌ Error after {elapsed}s: {exc}")
        traceback.print_exc()
        return ChatResponse(status="error", message=str(exc))

    elapsed = round(time.monotonic() - started_at, 2)
    status  = raw_result.get("status", "error")
    print(f"[create-bot-chat] [{request_id}] status={status} in {elapsed}s")

    if status == "clarification_needed":
        return ChatResponse(
            status="clarification_needed",
            question=raw_result.get("question", "Could you provide more details?"),
        )

    if status == "ready":
        output  = raw_result.get("output", {})
        intent  = raw_result.get("intent", {})
        files   = output.get("files", [])
        bot_name = (
            str(intent.get("bot_name", ""))
            or str(intent.get("bot_type", ""))
            or "Agentia Initia Bot"
        )
        return ChatResponse(
            status="ready",
            bot_name=bot_name,
            files=files,
            intent=intent,
            thoughts=output.get("thoughts", ""),
        )

    # Fallback: pass-through error
    return ChatResponse(
        status="error",
        message=raw_result.get("message", "Unknown error from Meta-Agent."),
    )