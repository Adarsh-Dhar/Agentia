"""
Utility helpers for resolving Initia Name Service (.init) usernames.

The actual ONS contract address and ABI may vary by network, so the resolver
keeps those values configurable. The helpers here are intentionally small and
dependency-free so the meta-agent can reuse them in prompts, tests, or future
automation paths.
"""

from __future__ import annotations

import json
import re
from typing import Optional


INIT_NAME_PATTERN = re.compile(r"^[a-z0-9_-]+\.init$", re.IGNORECASE)


def is_init_name(value: str) -> bool:
    """Return True when the string looks like a .init handle."""
    return bool(INIT_NAME_PATTERN.match(str(value or "").strip()))


def resolve_if_init_name(value: str, resolved_lookup: dict[str, str] | None = None) -> str:
    """
    Resolve a .init name via a caller-provided lookup table.

    This helper is intentionally generic because the actual ONS resolution
    happens through the generated runtime's MCP bridge, not directly here.
    """
    candidate = str(value or "").strip()
    if not candidate or not is_init_name(candidate):
        return candidate

    lookup = resolved_lookup or {}
    return lookup.get(candidate.lower(), candidate)


def extract_address_from_mcp_response(data: dict, name: str) -> Optional[str]:
    """Best-effort extraction for MCP move_view payloads."""
    for field in ("address", "value", "resolved_address", "account"):
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()

    result = data.get("result")
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict):
                text = first.get("text")
                if isinstance(text, str):
                    trimmed = text.strip()
                    if trimmed.startswith("{"):
                        try:
                            inner = json.loads(trimmed)
                        except json.JSONDecodeError:
                            inner = None
                        if isinstance(inner, dict):
                            for field in ("address", "resolved_address", "value"):
                                inner_value = inner.get(field)
                                if isinstance(inner_value, str) and inner_value.strip():
                                    return inner_value.strip()
                    if trimmed.startswith(("init1", "0x")):
                        return trimmed

    return None
