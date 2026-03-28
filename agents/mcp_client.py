"""
agents/mcp_client.py

Industrial-grade MCP session manager.
Manages persistent stdio connections to multiple MCP servers and exposes a
single call_tool() convenience method for use by any bot instance.
"""

import os
import shutil
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from contextlib import AsyncExitStack


class MultiMCPClient:
    def __init__(self):
        self.sessions: dict[str, ClientSession] = {}
        self.exit_stack = AsyncExitStack()

    async def connect_to_server(
        self,
        name: str,
        command: str,
        args: list,
        custom_env: dict = None,
    ):
        """
        Connect to a single MCP server via stdio and register it by name.

        Args:
            name:       Logical server name, e.g. "one_inch", "webacy", "goat_evm"
            command:    Executable to launch, e.g. "npx"
            args:       CLI arguments list
            custom_env: Extra environment variables to inject (API keys, RPC URLs, etc.)

        Raises:
            RuntimeError: If the command binary is not found in PATH.
        """
        cmd_path = shutil.which(command)
        if not cmd_path:
            raise RuntimeError(
                f"Command '{command}' not found in system PATH. "
                "Ensure Node.js / npx is installed."
            )

        env = os.environ.copy()
        if custom_env:
            env.update(custom_env)

        server_params = StdioServerParameters(
            command=cmd_path,
            args=args,
            env=env,
        )

        transport = await self.exit_stack.enter_async_context(
            stdio_client(server_params)
        )
        read_stream, write_stream = transport
        session = await self.exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()

        self.sessions[name] = session
        print(f"✅ Connected to '{name}' MCP server")

    async def list_all_tools(self) -> list[dict]:
        """Return aggregated tool definitions from every connected server."""
        all_tools = []
        for server_name, session in self.sessions.items():
            result = await session.list_tools()
            for tool in result.tools:
                all_tools.append({
                    "server":       server_name,
                    "name":         tool.name,
                    "description":  tool.description,
                    "input_schema": tool.inputSchema,
                })
        return all_tools

    async def call_tool(self, server: str, tool: str, args: dict) -> str:
        """
        Call a tool on a named MCP server and return the raw text response.

        Args:
            server: Registered server name, e.g. "one_inch"
            tool:   Tool name, e.g. "get_quote"
            args:   Arguments dict

        Returns:
            Raw text string from the MCP response (typically JSON).

        Raises:
            ValueError: If the server is not connected or returns empty content.
        """
        session = self.sessions.get(server)
        if not session:
            raise ValueError(
                f"MCP server '{server}' is not connected. "
                f"Connected servers: {list(self.sessions.keys())}"
            )

        result = await session.call_tool(tool, args)

        if not result.content:
            raise ValueError(
                f"Server '{server}' / tool '{tool}' returned empty content."
            )

        return result.content[0].text

    async def shutdown(self):
        """Close all sessions cleanly. Always call this on bot exit."""
        await self.exit_stack.aclose()
        print("🔒 All MCP sessions closed.")