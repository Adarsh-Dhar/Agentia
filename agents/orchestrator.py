import os
import json
from dotenv import load_dotenv
from mcp_client import MultiMCPClient
from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import SystemMessage, UserMessage
from azure.core.credentials import AzureKeyCredential

# Load variables from .env 
load_dotenv()

class MetaAgentBuilder:
    def __init__(self):
        self.mcp_manager = MultiMCPClient()
        
        # Fetch API Keys
        self.token = os.environ.get("GITHUB_TOKEN")
        self.alchemy_key = os.environ.get("ALCHEMY_API_KEY")
        self.webacy_key = os.environ.get("WEBACY_API_KEY")
        
        if not self.token:
            raise ValueError("GITHUB_TOKEN not found. Please check your .env file.")
            
        self.endpoint = "https://models.inference.ai.azure.com"
        self.model_name = "gpt-4o"
        
        self.client = ChatCompletionsClient(
            endpoint=self.endpoint,
            credential=AzureKeyCredential(self.token),
        )
        
        # NEW: Fetch your deployed contract address
        self.arb_bot_address = os.environ.get("ARB_BOT_ADDRESS")


    async def setup_environment(self):
        """Connects to all required DeFi MCP Servers."""
        print("Connecting to MCP Servers...")

        # 1. 1inch (HTTP via supergateway)
        try:
            await self.mcp_manager.connect_to_server(
                "one_inch", "npx",
                ["-y", "supergateway", "--streamableHttp", "https://api.1inch.com/mcp/protocol", "--outputTransport", "stdio"]
            )
        except Exception as e:
            print(f"⚠️ Failed to connect to 1inch (likely rate limit). Skipping for now. Error: {e}")

        # 2. Jupiter (HTTP via supergateway)
        try:
            await self.mcp_manager.connect_to_server(
                "jupiter", "npx",
                ["-y", "supergateway", "--streamableHttp", "https://dev.jup.ag/mcp", "--outputTransport", "stdio"]
            )
        except Exception as e:
            print(f"⚠️ Failed to connect to Jupiter. Error: {e}")

        # 3. Webacy (HTTP via supergateway WITH API Header)
        if self.webacy_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "webacy", "npx",
                    [
                        "-y", "supergateway", 
                        "--streamableHttp", "https://api.webacy.com/mcp", 
                        "--header", f"x-api-key: {self.webacy_key}", 
                        "--outputTransport", "stdio"
                    ]
                )
            except Exception as e:
                print(f"⚠️ Failed to connect to Webacy. Error: {e}")
        else:
            print("⚠️ WEBACY_API_KEY missing in .env. Skipping Webacy.")

        # 4. Alchemy (Native stdio WITH custom environment variables)
        if self.alchemy_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "alchemy", "npx",
                    ["-y", "@alchemy/mcp-server"],
                    custom_env={"ALCHEMY_API_KEY": self.alchemy_key}
                )
            except Exception as e:
                print(f"⚠️ Failed to connect to Alchemy. Error: {e}")
        else:
            print("⚠️ ALCHEMY_API_KEY missing in .env. Skipping Alchemy.")

        # 5. GOAT EVM execution wallet (Native typescript execution)
        self.wallet_key = os.environ.get("WALLET_PRIVATE_KEY")
        self.rpc_url = os.environ.get("RPC_PROVIDER_URL")
        self.goat_path = os.environ.get("GOAT_EVM_PATH")
        if self.wallet_key and self.rpc_url and self.goat_path:
            if os.path.exists(self.goat_path):
                try:
                    await self.mcp_manager.connect_to_server(
                        "goat_evm", "npx",
                        ["tsx", self.goat_path],
                        custom_env={
                            "WALLET_PRIVATE_KEY": self.wallet_key,
                            "RPC_PROVIDER_URL": self.rpc_url
                        }
                    )
                except Exception as e:
                    print(f"⚠️ Failed to connect to GOAT EVM. Error: {e}")
            else:
                print(f"⚠️ GOAT EVM path not found: {self.goat_path}")
        else:
            print("⚠️ WALLET_PRIVATE_KEY, RPC_PROVIDER_URL, or GOAT_EVM_PATH missing in .env. Skipping GOAT EVM.")


    async def build_bot_logic(self, prompt: str):
        """Uses GPT-4o with strict rules to build a functional Base Sepolia arbitrage bot."""
        available_tools = await self.mcp_manager.list_all_tools()
        
        # Minify tool list to fit token limits
        compressed_tools = []
        for tool in available_tools:
            props = tool.get("input_schema", {}).get("properties", {})
            simple_props = {k: v.get("type", "string") for k, v in props.items()}
            compressed_tools.append({
                "server": tool.get("server", "unknown"), 
                "name": tool["name"], 
                "args": simple_props
            })
        
        tools_str = json.dumps(compressed_tools, separators=(',', ':'))
        mini_abi = '[{"inputs":[{"internalType":"address","name":"tokenToBorrow","type":"address"},{"internalType":"uint256","name":"amountToBorrow","type":"uint256"},{"internalType":"address","name":"routerTarget","type":"address"},{"internalType":"bytes","name":"swapData","type":"bytes"}],"name":"requestArbitrage","outputs":[],"stateMutability":"nonpayable","type":"function"}]'

        # THE REFINED SYSTEM PROMPT
        system_instructions = f"""
    ### IDENTITY
    You are an expert On-Chain Arbitrage Engineer. 
    Generate a COMPLETE Python project for Base Sepolia flash loan arbitrage.

    ────────────────────────────────────────────────────
    MANDATORY RULES FOR PERFECT CODE
    ────────────────────────────────────────────────────
    # 1. EXACT SERVER NAMES: Use "one_inch", "webacy", and "goat_evm" only.
    # 2. THE TOOL BRIDGE: You MUST include this wrapper: 
    async def call_mcp_tool(server, tool, args):
        response = await mcp_manager.call_tool(server=server, tool=tool, args=args)
        return json.loads(response)
    # 3. 1INCH FLOW: You MUST call 'get_swap_data' after a quote is deemed profitable.
    # 4. CONTRACT SIGNATURE: 'requestArbitrage' requires: (tokenToBorrow, amountToBorrow, routerTarget, swapData).
    # 5. UNIT CONSISTENCY: All profit math must be done in BASE UNITS (int) to avoid decimal errors.
    # 6. WEBACY CHECK: Verify that 'risk' == 'low' or score < 20.

    ────────────────────────────────────────────────────
    AVAILABLE TOOLS (MUST USE THESE)
    ────────────────────────────────────────────────────
    {tools_str}

    ────────────────────────────────────────────────────
    VERIFIED ADDRESSES (BASE SEPOLIA)
    ────────────────────────────────────────────────────
    WETH: "0x4200000000000000000000000000000000000006"
    USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    ARB_BOT: "{self.arb_bot_address}"
    ABI: {mini_abi}

    ────────────────────────────────────────────────────
    RESPONSE FORMAT — STRICT JSON
    ────────────────────────────────────────────────────
    Return a single JSON object. No markdown fences. No preamble.
    {{
      "thoughts": "Brief explanation of the strategy",
      "files": [
        {{ "filepath": "main.py", "content": "..." }}
      ]
    }}
    """
        response = self.client.complete(
            messages=[SystemMessage(content=system_instructions), UserMessage(content=prompt)],
            model=self.model_name,
            temperature=0.2,
            max_tokens=2500
        )

        # Parsing Logic
        raw_text = response.choices[0].message.content
        # Clean up any AI formatting mistakes
        if raw_text.startswith("```json"):
            raw_text = raw_text.replace("```json", "").replace("```", "").strip()
        elif raw_text.startswith("```"):
            raw_text = raw_text.strip("```").strip()

        try:
            structured_output = json.loads(raw_text)
        except Exception:
            # This is why error.py is being created
            structured_output = {
                "thoughts": "Error parsing JSON",
                "files": [{"filepath": "error.py", "content": raw_text}]
            }

        return {
            "status": "blueprint_ready",
            "output": structured_output,
            "tools_used": [t['name'] for t in available_tools]
        }