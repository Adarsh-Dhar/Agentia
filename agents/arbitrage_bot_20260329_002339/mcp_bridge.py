import sys, os, json
_PARENT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)
from mcp_client import MultiMCPClient

mcp = MultiMCPClient()  # module-level singleton

async def call_mcp_tool(server: str, tool: str, args: dict) -> dict:
    raw = await mcp.call_tool(server=server, tool=tool, args=args)
    return json.loads(raw)