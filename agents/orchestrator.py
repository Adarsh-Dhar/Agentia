"""
agents/orchestrator.py

Meta-Agent builder. Uses GPT-4o via Azure AI Inference to generate a complete,
production-ready 4-file arbitrage bot from a plain-English prompt.
"""

import os
import json
from dotenv import load_dotenv
from mcp_client import MultiMCPClient
from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import SystemMessage, UserMessage
from azure.core.credentials import AzureKeyCredential

load_dotenv()

# ---------------------------------------------------------------------------
# Full flash loan ABI — used in the system prompt so the AI never guesses it
# ---------------------------------------------------------------------------
FLASHLOAN_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "_addressProvider", "type": "address"}
        ],
        "stateMutability": "nonpayable",
        "type": "constructor",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "asset",     "type": "address"},
            {"internalType": "uint256", "name": "amount",    "type": "uint256"},
            {"internalType": "uint256", "name": "premium",   "type": "uint256"},
            {"internalType": "address", "name": "initiator", "type": "address"},
            {"internalType": "bytes",   "name": "params",    "type": "bytes"},
        ],
        "name": "executeOperation",
        "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "tokenToBorrow",  "type": "address"},
            {"internalType": "uint256", "name": "amountToBorrow", "type": "uint256"},
            {"internalType": "address", "name": "routerTarget",   "type": "address"},
            {"internalType": "bytes",   "name": "swapData",       "type": "bytes"},
        ],
        "name": "requestArbitrage",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"internalType": "address", "name": "token", "type": "address"}],
        "name": "withdrawProfit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]


class MetaAgentBuilder:
    def __init__(self):
        self.mcp_manager = MultiMCPClient()

        self.token        = os.environ.get("GITHUB_TOKEN")
        self.alchemy_key  = os.environ.get("ALCHEMY_API_KEY")
        self.webacy_key   = os.environ.get("WEBACY_API_KEY")
        self.oneinch_key  = os.environ.get("1INCH_API_KEY")

        if not self.token:
            raise ValueError("GITHUB_TOKEN not found. Please check your .env file.")

        self.endpoint   = "https://models.inference.ai.azure.com"
        self.model_name = "gpt-4o"
        self.client = ChatCompletionsClient(
            endpoint=self.endpoint,
            credential=AzureKeyCredential(self.token),
        )

        self.arb_bot_address = os.environ.get(
            "ARB_BOT_ADDRESS", "0x6b7b81e04D024259b87a6C0F5ab5Eb04d9539102"
        )

    # -------------------------------------------------------------------------
    # MCP Server Setup
    # -------------------------------------------------------------------------

    async def setup_environment(self):
        """Connect the orchestrator's MCP client to all DeFi servers."""
        print("Connecting to MCP Servers...")

        try:
            one_inch_args = [
                "-y", "supergateway",
                "--streamableHttp", "https://api.1inch.com/mcp/protocol",
            ]
            if self.oneinch_key:
                one_inch_args += ["--header", f"Authorization: Bearer {self.oneinch_key}"]
            one_inch_args += ["--outputTransport", "stdio"]
            await self.mcp_manager.connect_to_server(
                "one_inch", "npx", one_inch_args
            )
        except Exception as e:
            print(f"⚠️ 1inch: {e}")

        try:
            await self.mcp_manager.connect_to_server(
                "jupiter", "npx",
                ["-y", "supergateway", "--streamableHttp",
                 "https://dev.jup.ag/mcp", "--outputTransport", "stdio"],
            )
        except Exception as e:
            print(f"⚠️ Jupiter: {e}")

        if self.webacy_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "webacy", "npx",
                    ["-y", "supergateway",
                     "--streamableHttp", "https://api.webacy.com/mcp",
                     "--header", f"x-api-key: {self.webacy_key}",
                     "--outputTransport", "stdio"],
                )
            except Exception as e:
                print(f"⚠️ Webacy: {e}")
        else:
            print("⚠️ WEBACY_API_KEY missing. Skipping Webacy.")

        if self.alchemy_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "alchemy", "npx",
                    ["-y", "@alchemy/mcp-server"],
                    custom_env={"ALCHEMY_API_KEY": self.alchemy_key},
                )
            except Exception as e:
                print(f"⚠️ Alchemy: {e}")
        else:
            print("⚠️ ALCHEMY_API_KEY missing. Skipping Alchemy.")

        wallet_key = os.environ.get("WALLET_PRIVATE_KEY")
        rpc_url    = os.environ.get("RPC_PROVIDER_URL")
        goat_path  = os.environ.get("GOAT_EVM_PATH")
        if wallet_key and rpc_url and goat_path:
            if os.path.exists(goat_path):
                try:
                    await self.mcp_manager.connect_to_server(
                        "goat_evm", "npx", ["tsx", goat_path],
                        custom_env={
                            "WALLET_PRIVATE_KEY": wallet_key,
                            "RPC_PROVIDER_URL":   rpc_url,
                        },
                    )
                except Exception as e:
                    print(f"⚠️ GOAT EVM: {e}")
            else:
                print(f"⚠️ GOAT_EVM_PATH not found: {goat_path}")
        else:
            print("⚠️ WALLET_PRIVATE_KEY / RPC_PROVIDER_URL / GOAT_EVM_PATH missing.")

    # -------------------------------------------------------------------------
    # Bot Generation
    # -------------------------------------------------------------------------

    async def build_bot_logic(self, prompt: str) -> dict:
        """
        Call GPT-4o with an exhaustive system prompt to generate a
        production-ready 4-file arbitrage bot.
        """
        available_tools = await self.mcp_manager.list_all_tools()

        # Minify tool list to fit token budget
        compressed_tools = []
        for tool in available_tools:
            props = tool.get("input_schema", {}).get("properties", {})
            compressed_tools.append({
                "server": tool.get("server", "unknown"),
                "name":   tool["name"],
                "args":   {k: v.get("type", "string") for k, v in props.items()},
            })
        tools_str = json.dumps(compressed_tools, separators=(',', ':'))
        abi_str   = json.dumps(FLASHLOAN_ABI, separators=(',', ':'))

        system_instructions = f"""
### IDENTITY
You are an expert On-Chain Arbitrage Engineer.
Generate a COMPLETE, production-ready Python project for Base Sepolia flash loan arbitrage.
The project MUST consist of exactly 4 files with clean separation of concerns.

════════════════════════════════════════════════════════════════════
VERIFIED TOOL SIGNATURES  ──  NEVER DEVIATE. NEVER GUESS.
════════════════════════════════════════════════════════════════════

① 1inch — PRICE QUOTE (read-only, no broadcast)
  server="one_inch"  tool="get_quote"
  args: {{"tokenIn":"<addr>","tokenOut":"<addr>","amount":"<str int>","chain":<int>}}
  parse: int(response["toTokenAmount"])

② 1inch — SWAP CALLDATA (needed before contract call)
  server="one_inch"  tool="get_swap_data"
  args: {{"tokenIn":"<addr>","tokenOut":"<addr>","amount":"<str int>","chain":<int>,"from":"<addr>","slippage":1}}
  parse: response["tx"]["data"]  → hex string

③ Webacy — TOKEN RISK CHECK
  server="webacy"  tool="get_token_risk"
  args: {{"address":"<addr>","chain":"base-sepolia"}}   ← chain MUST be the STRING "base-sepolia"
  parse: response["risk"] == "low"  OR  response["score"] < 20

④ GOAT EVM — UNIT CONVERSION  (call ONCE at startup per token)
  server="goat_evm"  tool="convert_to_base_units"
  args: {{"tokenAddress":"<addr>","amount":"<str human number>"}}
  parse: int(response["baseUnits"])

⑤ GOAT EVM — CONTRACT WRITE  (broadcasts the flash loan tx)
  server="goat_evm"  tool="write_contract"
  args: {{
    "address":"<contract addr>",        ← KEY IS "address"  NOT "contractAddress"
    "abi":<list>,
    "functionName":"requestArbitrage",
    "args":[tokenToBorrow, amountToBorrow, routerTarget, swapData]
  }}
  parse: response["transactionHash"]  → str

════════════════════════════════════════════════════════════════════
FILE SPECIFICATIONS
════════════════════════════════════════════════════════════════════

━━━ FILE 1 ── config.py  (constants only, zero logic) ━━━
WETH_ADDRESS    = "0x4200000000000000000000000000000000000006"
USDC_ADDRESS    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
ARB_BOT_ADDRESS = "{self.arb_bot_address}"
ONE_INCH_ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65"
CHAIN_ID           = 8453        # Base Sepolia
USDC_DECIMALS      = 6
WETH_DECIMALS      = 18
AAVE_FEE_BPS       = 9            # 0.09 %
GAS_BUFFER_USDC    = 2_000_000    # 2 USDC in base units — always integer
POLL_INTERVAL      = 5            # seconds
BORROW_AMOUNT_HUMAN = 1           # human-readable USDC; converted to base units at runtime
FLASHLOAN_ABI      = {abi_str}

━━━ FILE 2 ── mcp_bridge.py  (MCP wrapper with path fix) ━━━
The generated bot lives in a SUBDIRECTORY of agents/.
mcp_client.py is in the PARENT agents/ directory.
You MUST include this exact path fix so the import resolves correctly:

  import sys, os, json
  _PARENT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
  if _PARENT not in sys.path:
      sys.path.insert(0, _PARENT)
  from mcp_client import MultiMCPClient

  mcp = MultiMCPClient()   # module-level singleton

  async def call_mcp_tool(server: str, tool: str, args: dict) -> dict:
      raw = await mcp.call_tool(server=server, tool=tool, args=args)
      return json.loads(raw)

━━━ FILE 3 ── arbitrage.py  (all async strategy functions) ━━━
Import from config and mcp_bridge only.

  async def convert_to_base_units(token_address: str, human_amount) -> int
      → goat_evm convert_to_base_units → int(response["baseUnits"])

  async def get_usdc_to_weth_quote(amount_usdc_base: int) -> int
      → one_inch get_quote  tokenIn=USDC  tokenOut=WETH  → int(response["toTokenAmount"])

  async def get_weth_to_usdc_quote(amount_weth_base: int) -> int
      → one_inch get_quote  tokenIn=WETH  tokenOut=USDC  → int(response["toTokenAmount"])

  async def calculate_profit(borrow_usdc_base: int) -> int
      weth   = await get_usdc_to_weth_quote(borrow_usdc_base)
      gross  = await get_weth_to_usdc_quote(weth)
      fee    = (borrow_usdc_base * AAVE_FEE_BPS) // 10_000
      return  gross - borrow_usdc_base - fee - GAS_BUFFER_USDC

  async def verify_tokens() -> bool
      → webacy get_token_risk for USDC and WETH  chain="base-sepolia" (string)
      → True only if BOTH pass: risk=="low" OR score<20

  async def get_swap_calldata(src, dst, amount_base, from_addr) -> str
      → one_inch get_swap_data  tokenIn/tokenOut  → response["tx"]["data"]

  async def execute_arbitrage(calldata: str, borrow_amount_base: int) -> str
      → goat_evm write_contract  key="address"  functionName="requestArbitrage"
      → response["transactionHash"]

━━━ FILE 4 ── main.py  (entry point with full setup) ━━━

  Imports:
    import asyncio, logging, os
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    from mcp_bridge import mcp        ← import singleton for shutdown
    from arbitrage import (convert_to_base_units, calculate_profit,
                           verify_tokens, get_swap_calldata, execute_arbitrage)
    from config import *

  SIMULATION_MODE = os.getenv("SIMULATION_MODE", "false").lower() == "true"

  async def setup_bot_connections():
    # The mcp object is a BLANK MultiMCPClient with self.sessions = {{}}.
    # It has NO connections until this function runs.
    # You MUST call mcp.connect_to_server() here for each server:
    await mcp.connect_to_server("one_inch", "npx",
        ["-y","supergateway","--streamableHttp",
         "https://api.1inch.com/mcp/protocol","--outputTransport","stdio"])
    webacy_key = os.getenv("WEBACY_API_KEY")
    if not webacy_key: raise RuntimeError("WEBACY_API_KEY not set")
    await mcp.connect_to_server("webacy", "npx",
        ["-y","supergateway","--streamableHttp","https://api.webacy.com/mcp",
         "--header",f"x-api-key: {{webacy_key}}","--outputTransport","stdio"])
    wallet  = os.getenv("WALLET_PRIVATE_KEY")
    rpc     = os.getenv("RPC_PROVIDER_URL")
    gpath   = os.getenv("GOAT_EVM_PATH")
    if not all([wallet, rpc, gpath]):
        raise RuntimeError("WALLET_PRIVATE_KEY, RPC_PROVIDER_URL, GOAT_EVM_PATH must be set")
    await mcp.connect_to_server("goat_evm","npx",["tsx",gpath],
        custom_env={{"WALLET_PRIVATE_KEY":wallet,"RPC_PROVIDER_URL":rpc}})

  async def run_bot():
    if SIMULATION_MODE: logger.info("SIMULATION MODE — no transactions will broadcast")
    await setup_bot_connections()
    borrow_amount_base = await convert_to_base_units(USDC_ADDRESS, BORROW_AMOUNT_HUMAN)
    logger.info(f"Borrow amount: {{borrow_amount_base}} base units")
    try:
      while True:
        try:
          profit = await calculate_profit(borrow_amount_base)
          if profit > 0:
            logger.info(f"Opportunity: +{{profit}} base units")
            if not await verify_tokens():
              logger.warning("Risk check failed. Skipping.")
            elif SIMULATION_MODE:
              logger.info(f"[SIM] Would execute. Profit: +{{profit/1_000_000:.6f}} USDC")
            else:
              calldata = await get_swap_calldata(USDC_ADDRESS,WETH_ADDRESS,borrow_amount_base,ARB_BOT_ADDRESS)
              tx = await execute_arbitrage(calldata, borrow_amount_base)
              logger.info(f"Executed. TX: {{tx}}")
          else:
            logger.info(f"No opportunity. Net: {{profit}} base units")
        except Exception as e:
          logger.error(str(e), exc_info=True)
        await asyncio.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
      logger.info("Stopping bot...")
    finally:
      await mcp.shutdown()

  logging.basicConfig(level=logging.INFO,
      format="%(asctime)s [%(levelname)s] %(message)s",
      datefmt="%Y-%m-%d %H:%M:%S")
  logger = logging.getLogger(__name__)

  if __name__ == "__main__":
      asyncio.run(run_bot())

════════════════════════════════════════════════════════════════════
AVAILABLE MCP TOOLS  (discovered at runtime — use server names above)
════════════════════════════════════════════════════════════════════
{tools_str}

════════════════════════════════════════════════════════════════════
HARD RULES  ──  ANY VIOLATION = BROKEN BOT
════════════════════════════════════════════════════════════════════
1.  NEVER use tool name "swap" — ONLY "get_quote" or "get_swap_data"
2.  NEVER use "src"/"dst" as 1inch keys — ONLY "tokenIn"/"tokenOut"
3.  NEVER use "contractAddress" in goat_evm — ONLY "address"
4.  NEVER hardcode base-unit amounts — derive via convert_to_base_units at startup
5.  ALL profit arithmetic must use integers — no float, no Decimal, no round()
6.  Webacy chain MUST be the string "base-sepolia" — never integer 8453
7.  mcp_bridge.py MUST include the sys.path parent-dir fix shown above
8.  main.py MUST call setup_bot_connections() FIRST before any tool call
9.  main.py MUST call mcp.shutdown() in a finally block
10. main.py MUST implement SIMULATION_MODE
11. No placeholder comments — every function body must be complete and runnable

════════════════════════════════════════════════════════════════════
RESPONSE FORMAT — RAW JSON ONLY. NO MARKDOWN. NO PREAMBLE.
════════════════════════════════════════════════════════════════════
{{
  "thoughts": "One paragraph explaining strategy and architecture.",
  "files": [
    {{"filepath": "config.py",     "content": "..."}},
    {{"filepath": "mcp_bridge.py", "content": "..."}},
    {{"filepath": "arbitrage.py",  "content": "..."}},
    {{"filepath": "main.py",       "content": "..."}}
  ]
}}
"""

        response = self.client.complete(
            messages=[
                SystemMessage(content=system_instructions),
                UserMessage(content=prompt),
            ],
            model=self.model_name,
            temperature=0.1,   # deterministic — less hallucination
            max_tokens=4096,
        )

        raw_text = response.choices[0].message.content.strip()

        # Strip any markdown fences the model adds despite instructions
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        elif raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
        raw_text = raw_text.strip()

        try:
            structured_output = json.loads(raw_text)
            files   = structured_output.get("files", [])
            got     = {f.get("filepath") for f in files}
            missing = {"config.py", "mcp_bridge.py", "arbitrage.py", "main.py"} - got
            if missing:
                print(f"⚠️  Model did not generate: {missing}")
        except Exception as parse_err:
            print(f"⚠️  JSON parse error: {parse_err}")
            structured_output = {
                "thoughts": "JSON parsing failed — raw output saved.",
                "files": [{"filepath": "error.py", "content": raw_text}],
            }

        return {
            "status":     "blueprint_ready",
            "output":     structured_output,
            "tools_used": [t["name"] for t in available_tools],
        }