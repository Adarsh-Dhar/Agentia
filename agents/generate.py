"""
agents/generate.py

Triggers the Meta-Agent to scaffold a production-ready arbitrage bot.

Usage:
    # Default (hardcoded config — backward compatible):
    python generate.py

    # Custom config via JSON:
    python generate.py --config '{"chain":"base-mainnet","baseToken":"USDC","targetToken":"WETH","dex":"1inch","securityProvider":"webacy","borrowAmountHuman":5,"minProfitUsd":1.0,"gasBufferUsdc":2,"pollingIntervalSec":3,"simulationMode":true,"maxRiskScore":20,"botName":"MyArber"}'

    # Custom config from file:
    python generate.py --config-file my_config.json
"""

import requests
import os
import json
import argparse
from datetime import datetime
from typing import Optional

# ─── Default configuration (backward-compatible baseline) ────────────────────

DEFAULT_CONFIG = {
    "botName":            "ArbitrageBot",
    "chain":              "base-sepolia",
    "baseToken":          "USDC",
    "targetToken":        "WETH",
    "dex":                "1inch",
    "securityProvider":   "webacy",
    "borrowAmountHuman":  1,
    "minProfitUsd":       0.5,
    "gasBufferUsdc":      2,
    "pollingIntervalSec": 5,
    "simulationMode":     True,
    "maxRiskScore":       20,
}

# ─── Token address registry ───────────────────────────────────────────────────

TOKEN_ADDRESSES = {
    "USDC": {
        "base-sepolia": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "arbitrum":     "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    "USDT": {
        "base-sepolia": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
        "base-mainnet": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
        "arbitrum":     "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    "WETH": {
        "base-sepolia": "0x4200000000000000000000000000000000000006",
        "base-mainnet": "0x4200000000000000000000000000000000000006",
        "arbitrum":     "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    "CBBTC": {
        "base-sepolia": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
        "base-mainnet": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
        "arbitrum":     "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    "AERO": {
        "base-sepolia": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
        "base-mainnet": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
        "arbitrum":     "",
    },
}

CHAIN_IDS = {
    "base-sepolia": 84532,
    "base-mainnet": 8453,
    "arbitrum":     42161,
}

# ─── Prompt builder ───────────────────────────────────────────────────────────

def build_prompt(config: dict) -> str:
    """
    Convert a structured BotConfig dict into a natural-language prompt
    for the Meta-Agent.  The base architecture (MCP, flash loans, logging)
    is always the same — only the parameters change.
    """
    chain    = config.get("chain", "base-sepolia")
    chain_id = CHAIN_IDS.get(chain, 84532)

    base_token   = config.get("baseToken", "USDC")
    target_token = config.get("targetToken", "WETH")
    dex          = config.get("dex", "1inch")
    security     = config.get("securityProvider", "webacy")
    bot_name     = config.get("botName", "ArbitrageBot")
    borrow       = config.get("borrowAmountHuman", 1)
    min_profit   = config.get("minProfitUsd", 0.5)
    gas_buf      = config.get("gasBufferUsdc", 2)
    poll_sec     = config.get("pollingIntervalSec", 5)
    sim_mode     = config.get("simulationMode", True)
    max_risk     = config.get("maxRiskScore", 20)

    base_addr   = TOKEN_ADDRESSES.get(base_token,   {}).get(chain, "")
    target_addr = TOKEN_ADDRESSES.get(target_token, {}).get(chain, "")

    # Security instruction block
    if security == "none":
        security_line = "// Skip token risk checks entirely."
    elif security == "webacy":
        security_line = (
            f'If profitable, verify BOTH tokens with Webacy get_token_risk (chain="{chain}"). '
            f"Only proceed if both pass: risk==\"low\" OR score<{max_risk}."
        )
    else:
        security_line = (
            "If profitable, verify BOTH tokens with GoPlus Security. "
            "Only proceed if both tokens are safe."
        )

    return f"""
You are an expert Web3 developer. Your job is to write an autonomous EVM arbitrage bot.

CRITICAL ENVIRONMENT CONSTRAINT:
The bot will run inside a WebContainer (an in-browser Node.js environment).
YOU MUST WRITE THE BOT IN TYPESCRIPT / NODE.JS. DO NOT WRITE PYTHON.

Requirements:
1. Generate a package.json with dependencies (ethers, dotenv, etc.) and a \"start\": \"ts-node src/index.ts\" script.
2. Generate a tsconfig.json.
3. Write the bot logic in src/index.ts using modern async/await Node.js patterns.

CONFIGURATION:
- Bot Name: {bot_name}
- Chain: {chain} (Chain ID: {chain_id})
- Base Token (flash loan asset): {base_token} ({base_addr})
- Target Token (arbitrage target): {target_token} ({target_addr})
- DEX / Aggregator: {dex}
- Flash Loan Provider: Aave V3
- Borrow Amount: {borrow} {base_token} (convert to base units at startup)
- Minimum Net Profit: {min_profit} {base_token} (convert to base units; use integer comparison)
- Gas Buffer: {gas_buf} {base_token} (convert to base units at startup)
- Loop Interval: Every {poll_sec} seconds
- Simulation Mode default: {"true (no real transactions)" if sim_mode else "false (live execution)"}

STRATEGY:
Run a continuous async loop every {poll_sec} seconds.
Use {dex} get_quote to check the {base_token}->{target_token}->{base_token} round-trip price.
Calculate net profit after the 0.09% Aave flash loan fee and the gas buffer.
All math must use integers (base units) only.
{security_line}
Get swap calldata from {dex} get_swap_data using tokenIn/tokenOut keys.
Execute via goat_evm write_contract using the \"address\" key (not contractAddress).
Use structured logging. Call convert_to_base_units at startup. Include SIMULATION_MODE.

CRITICAL IMPLEMENTATION DETAILS FOR 1INCH INTEGRATION:
1. When calling get_quote, the response is a JSON object, NOT a number. You MUST extract the price value.
   - Response field: quoteObject?.result?.toTokenAmount || quoteObject?.toTokenAmount
   - NEVER do Math.abs(price - quoteObject) — this will return NaN and bypass all safety checks.
   - Always log the extracted price: console.log(`[1inch] toTokenAmount: ${{price}}`);

2. Profit calculation MUST include the 0.09% Aave flash loan fee:
   - Fee calculation: loanAmountInBaseUnits × 9 / 10000 (0.09% = 9 basis points)
   - Net Profit = (finalAmountOut - initialAmountIn) - fee - gasCostEstimate
   - ONLY execute the flashLoan if: Net Profit > 0
   - Use this logic in the PROTECT step BEFORE the ACT step.

3. The execution must be atomic (all on-chain in one transaction):
   - Step 1: Call Aave V3 flashLoan with loamAmount = {borrow} {base_token}
   - Step 2: Inside the flashLoan callback, execute the 1inch swap tokenIn→tokenOut
   - Step 3: Execute another 1inch swap tokenOut→tokenIn to repay + fee
   - Return the borrowed amount + 0.09% fee to Aave.

4. Log clearly at each step:
   - [LISTEN] → Both 1inch and Pyth prices separately
   - [QUANTIFY] → Profit calculation breakdown (fee, gas, net profit)
   - [PROTECT] → "Profit X > 0, proceeding" or "Profit X ≤ 0, SKIP"
   - [ACT] → "Invoking flashLoan with amount Y..."
""".strip()


# ─── CLI argument parsing ─────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description="Generate a custom arbitrage bot")
    group  = parser.add_mutually_exclusive_group()
    group.add_argument("--config",      type=str, help="JSON string of bot configuration")
    group.add_argument("--config-file", type=str, help="Path to a JSON config file")
    return parser.parse_args()


def load_config(args) -> dict:
    config = dict(DEFAULT_CONFIG)  # start with defaults

    if args.config:
        try:
            user_config = json.loads(args.config)
            config.update(user_config)
            print(f"📋 Using custom config: {json.dumps(config, indent=2)}")
        except json.JSONDecodeError as e:
            print(f"❌ Invalid JSON in --config: {e}")
            raise SystemExit(1)

    elif args.config_file:
        try:
            with open(args.config_file) as f:
                user_config = json.load(f)
            config.update(user_config)
            print(f"📋 Loaded config from {args.config_file}: {json.dumps(config, indent=2)}")
        except (OSError, json.JSONDecodeError) as e:
            print(f"❌ Could not read {args.config_file}: {e}")
            raise SystemExit(1)
    else:
        print("📋 Using default config (USDC/WETH on Base Sepolia via 1inch)")

    return config


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args   = parse_args()
    config = load_config(args)
    prompt = build_prompt(config)

    print(f"\n🧠 Bot: {config['botName']}")
    print(f"   Chain: {config['chain']} | Pair: {config['baseToken']}→{config['targetToken']}")
    print(f"   DEX: {config['dex']} | Security: {config['securityProvider']}")
    print(f"   Borrow: {config['borrowAmountHuman']} {config['baseToken']} | Min profit: ${config['minProfitUsd']}")
    print(f"   Sim mode: {config['simulationMode']}\n")

    SERVER_URL = "http://127.0.0.1:8000/create-bot"
    print("🚀 Sending request to Meta-Agent...")

    try:
        response = requests.post(
            SERVER_URL,
            json={"prompt": prompt},
            headers={"accept": "application/json"},
            timeout=180,
        )
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to http://127.0.0.1:8000")
        print("   Start the server first:  uvicorn main:app --reload")
        raise SystemExit(1)
    except requests.exceptions.Timeout:
        print("❌ Request timed out after 180s.")
        raise SystemExit(1)

    if response.status_code != 200:
        print(f"❌ HTTP {response.status_code}: {response.text}")
        raise SystemExit(1)

    data        = response.json()
    output      = data.get("output", {})
    tools_used  = data.get("tools_used", [])

    # ── Timestamped output directory ───────────────────────────────────────────
    bot_slug  = config["botName"].replace(" ", "_").lower()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder    = f"{bot_slug}_{timestamp}"
    os.makedirs(folder, exist_ok=True)

    # Save config snapshot
    with open(os.path.join(folder, "bot_config.json"), "w") as f:
        json.dump(config, f, indent=2)

    print(f"\n📁 Output: {folder}/")
    print(f"🔧 Tools:  {', '.join(tools_used) if tools_used else 'none'}")
    print(f"\n💡 {output.get('thoughts', 'N/A')}\n")

    # ── Save generated files ───────────────────────────────────────────────────
    EXPECTED = {"config.py", "mcp_bridge.py", "arbitrage.py", "main.py"}
    saved    = set()

    for file in output.get("files", []):
        filepath = file.get("filepath", "unknown.py")
        content  = file.get("content", "")
        
        # Handle edge case where content might be a dict or non-string
        if isinstance(content, dict):
            content = json.dumps(content, indent=2)
        elif not isinstance(content, str):
            content = str(content)
        
        filename = os.path.basename(filepath)
        outpath  = os.path.join(folder, filename)
        with open(outpath, "w") as f:
            f.write(content)
        saved.add(filename)
        print(f"  ✅ {filename:<20} ({len(content.splitlines())} lines)")

    # ── Validation ─────────────────────────────────────────────────────────────
    missing = EXPECTED - saved
    if missing:
        print(f"\n⚠️  Missing files: {', '.join(sorted(missing))}")
    else:
        print(f"\n🎉 All {len(EXPECTED)} production files generated successfully!")

    # ── requirements.txt ───────────────────────────────────────────────────────
    with open(os.path.join(folder, "requirements.txt"), "w") as f:
        f.write("# MCP servers handle all blockchain calls.\n")
        f.write("# Only lightweight runtime deps needed:\n")
        f.write("python-dotenv\n")

    print(f"\n🚀 To run:  cd {folder} && python main.py")
    print(f"🧪 Dry-run: cd {folder} && SIMULATION_MODE=true python main.py")
    print(f"📄 Config:  {folder}/bot_config.json")


if __name__ == "__main__":
    main()