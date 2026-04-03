"""
main.py — Meta-Agent API server.
Start: uvicorn main:app --reload
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
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from orchestrator import MetaAgent

app = FastAPI(title="DeFi Bot Meta-Agent", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

agent = MetaAgent()
CREATE_BOT_TIMEOUT_SECONDS = float(os.environ.get("META_AGENT_CREATE_BOT_TIMEOUT_SECONDS", "240"))


class PromptRequest(BaseModel):
    prompt: str


def _mcp_ok(payload: dict):
    return {
        "result": {
            "isError": False,
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(payload),
                }
            ],
        }
    }


def _safe_json_get(url: str, timeout: float = 8.0) -> dict | None:
    try:
        with urllib_request.urlopen(url, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except (HTTPError, URLError, TimeoutError, ValueError):
        return None


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/mcp/health")
async def mcp_health():
    return {"status": "ok", "service": "mcp-http-compat"}


@app.post("/mcp/{server}/{tool}")
async def mcp_tool(server: str, tool: str, body: dict):
    """
    HTTP MCP compatibility endpoint for generated bots.
    Always returns 200 with MCP-shaped JSON to avoid retry storms on 404.
    """
    server_l = server.strip().lower()
    tool_l = tool.strip().lower()

    # LunarCrush compatibility
    if server_l == "lunarcrush" and tool_l in {"getsentiment", "get_sentiment", "get_coin_details"}:
        coin = str(body.get("coin") or body.get("symbol") or "SOL").upper()
        # Lightweight best-effort market proxy data.
        coingecko = _safe_json_get(
            f"https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
        )
        usd = None
        try:
            usd = float((coingecko or {}).get("solana", {}).get("usd"))
        except (TypeError, ValueError):
            usd = None

        sentiment = {
            "coin": coin,
            "sentiment": 55,
            "galaxy_score": 52,
            "available": True,
            "source": "mcp-http-compat",
            "price_usd": usd,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        return _mcp_ok(sentiment)

    # Webacy / GoPlus-style risk compatibility
    if server_l in {"webacy", "goplus"} and tool_l in {"getrisk", "get_token_risk", "token_risk"}:
        address = str(body.get("address") or "")
        chain = str(body.get("chain") or "unknown")
        risk = {
            "address": address,
            "chain": chain,
            "risk": "medium",
            "riskScore": 35,
            "score": 35,
            "available": True,
            "source": "mcp-http-compat",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        return _mcp_ok(risk)

    # Initia compatibility
    if server_l == "initia" and tool_l == "move_execute":
        transaction = body.get("transaction") if isinstance(body.get("transaction"), dict) else {}
        calls = transaction.get("calls") if isinstance(transaction, dict) and isinstance(transaction.get("calls"), list) else []
        first_call = calls[0] if calls and isinstance(calls[0], dict) else {}
        module = str(body.get("module") or first_call.get("module") or "flash_loan")
        function = str(body.get("function") or first_call.get("function") or "borrow")
        args = body.get("args") if isinstance(body.get("args"), list) else []
        type_args = body.get("type_args") if isinstance(body.get("type_args"), list) else []
        mock_tx = {
            "ok": True,
            "status": "executed",
            "tx_hash": f"0xinitia{uuid4().hex[:24]}",
            "tool": "move_execute",
            "request": {
                "network": str(body.get("network") or "initia-mainnet"),
                "address": str(body.get("address") or first_call.get("address") or "0xinitia_atomic_executor"),
                "module": module,
                "function": function,
                "type_args": type_args,
                "args": args,
                "transaction": transaction,
            },
            "module": module,
            "function": function,
            "network": str(body.get("network") or "initia-mainnet"),
            "calls": calls,
            "call_count": len(calls),
            "simulated": True,
            "source": "mcp-http-compat",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        return _mcp_ok(mock_tx)

    if server_l == "initia" and tool_l == "move_view":
        raw_args = body.get("args")
        args = raw_args if isinstance(raw_args, list) else []
        base_denom = str((args[0] if len(args) > 0 else None) or body.get("base_denom") or "uinit")
        quote_denom = str((args[1] if len(args) > 1 else None) or body.get("quote_denom") or "uusdc")
        module = str(body.get("module") or "")
        function = str(body.get("function") or "")
        mock_price = {
            "ok": True,
            "tool": "move_view",
            "network": str(body.get("network") or "initia-mainnet"),
            "address": str(body.get("address") or "0xminitia_pool"),
            "module": module,
            "function": function,
            "args": args,
            "pair": [base_denom, quote_denom],
            "price": "1.234500",
            "price_num": 1.2345,
            "decimals": 6,
            "requires_explicit_target": not bool(module and function),
            "source": "mcp-http-compat",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        return _mcp_ok(mock_price)

    # Default non-fatal compatibility response for unknown routes.
    return _mcp_ok(
        {
            "available": False,
            "server": server,
            "tool": tool,
            "message": "Tool not implemented on local MCP compatibility endpoint.",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


@app.post("/create-bot")
async def create_bot(req: PromptRequest, request: Request):
    """Build bot with request-scoped logging and a configurable timeout."""
    request_id = (request.headers.get("x-request-id") or uuid4().hex[:8]).strip()[:12]
    started_at = time.monotonic()
    prompt_length = len(req.prompt or "")
    print(f"[create-bot] [{request_id}] Received request prompt_chars={prompt_length} timeout={CREATE_BOT_TIMEOUT_SECONDS}s")

    try:
        stage_started = time.monotonic()
        print(f"[create-bot] [{request_id}] Stage=build_bot starting")
        # Wrap blocking call with timeout
        result = await asyncio.wait_for(
            asyncio.to_thread(agent.build_bot, req.prompt, request_id),
            timeout=CREATE_BOT_TIMEOUT_SECONDS,
        )
        build_elapsed = round(time.monotonic() - stage_started, 2)
        total_elapsed = round(time.monotonic() - started_at, 2)
        print(f"[create-bot] [{request_id}] Stage=build_bot completed in {build_elapsed}s total_elapsed={total_elapsed}s")
        if isinstance(result, dict):
            print(f"[create-bot] [{request_id}] Success keys={list(result.keys())}")
        else:
            print(f"[create-bot] [{request_id}] Success result_type={type(result).__name__}")
        return result
    except asyncio.TimeoutError:
        total_elapsed = round(time.monotonic() - started_at, 2)
        print(f"[create-bot] [{request_id}] ❌ Timeout after {total_elapsed}s (limit={CREATE_BOT_TIMEOUT_SECONDS}s) prompt_chars={prompt_length}")
        raise HTTPException(
            status_code=504,
            detail=(
                f"Bot generation timed out after {CREATE_BOT_TIMEOUT_SECONDS:.0f} seconds "
                f"(request_id={request_id}, prompt_chars={prompt_length}). "
                "Check API keys, MCP connectivity, and Meta-Agent model latency."
            ),
        )
    except Exception as e:
        error_msg = str(e)
        elapsed = round(time.monotonic() - started_at, 2)
        print(f"[create-bot] [{request_id}] ❌ Error after {elapsed}s: {error_msg}")
        print(f"[create-bot] [{request_id}] Traceback follows for debugging")
        traceback.print_exc()
        status_code = 504 if "LLM timeout" in error_msg or "timeout" in error_msg.lower() else 500
        raise HTTPException(
            status_code=status_code,
            detail=(
                f"{error_msg} (request_id={request_id}, prompt_chars={prompt_length}, elapsed={elapsed}s)"
            ),
        )