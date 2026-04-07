"""
agents/generate.py

Triggers the Meta-Agent to scaffold Initia-only bot templates.

Usage:
    python generate.py
    python generate.py --config '{"chain":"initia-testnet","botName":"My Initia Bot"}'
    python generate.py --config-file my_config.json
"""

import argparse
import json
import os
from datetime import datetime

import requests

DEFAULT_CONFIG = {
    "botName": "Cross-Rollup Yield Sweeper",
    "chain": "initia-testnet",
    "baseToken": "USDC",
    "targetToken": "USDC",
    "dex": "initia",
    "securityProvider": "none",
    "borrowAmountHuman": 1,
    "minProfitUsd": 0.0,
    "gasBufferUsdc": 0,
    "pollingIntervalSec": 15,
    "simulationMode": True,
    "maxRiskScore": 20,
}

CHAIN_IDS = {
    "initia-testnet": "initiation-2",
}

TOKEN_DENOMS = {
    "INIT": {"initia-testnet": "uinit"},
    "USDC": {"initia-testnet": "uusdc"},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate an Initia bot")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--config", type=str, help="JSON string of bot configuration")
    group.add_argument("--config-file", type=str, help="Path to a JSON config file")
    return parser.parse_args()


def load_config(args: argparse.Namespace) -> dict:
    config = dict(DEFAULT_CONFIG)
    if args.config:
        try:
            config.update(json.loads(args.config))
        except json.JSONDecodeError as exc:
            print(f"Invalid JSON in --config: {exc}")
            raise SystemExit(1)
    elif args.config_file:
        try:
            with open(args.config_file, "r", encoding="utf-8") as handle:
                config.update(json.load(handle))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Could not read {args.config_file}: {exc}")
            raise SystemExit(1)

    if str(config.get("chain", "")).strip().lower() not in CHAIN_IDS:
        config["chain"] = "initia-testnet"
    return config


def build_prompt(config: dict) -> str:
    chain = str(config.get("chain", "initia-testnet")).strip().lower()
    chain_id = CHAIN_IDS[chain]
    base_token = str(config.get("baseToken", "USDC")).strip().upper()
    quote_token = str(config.get("targetToken", "USDC")).strip().upper()
    base_denom = TOKEN_DENOMS.get(base_token, {}).get(chain, "uusdc")
    quote_denom = TOKEN_DENOMS.get(quote_token, {}).get(chain, "uusdc")

    return f"""
You are an expert TypeScript and Move-oriented bot engineer.
Generate an Initia-only bot.

CONFIGURATION:
- Bot Name: {config.get("botName", "Initia Bot")}
- Chain: {chain} (Network ID: {chain_id})
- Base denom: {base_token} ({base_denom})
- Quote denom: {quote_token} ({quote_denom})
- Poll every: {config.get("pollingIntervalSec", 15)} seconds
- Simulation mode default: {"true" if config.get("simulationMode", True) else "false"}

RULES:
1. Use TypeScript only.
2. Only use callMcpTool('initia', 'move_view', ... ) for reads.
3. Only use callMcpTool('initia', 'move_execute', ... ) for writes.
4. Every move_execute call must use the standard flat payload shape: {{network, address, module, function, type_args, args}}.
5. Never wrap multiple actions in a custom transaction object or transaction.calls array.
6. Keep runtime strictly Initia-native with no external chain SDK/tooling.
7. For move_view calls, always include type_args explicitly (use [] when none).
8. For yield sweeper behavior, read 0x1::coin::balance with type_args ['0x1::coin::uusdc'] and args [walletAddress], then execute interwoven_bridge::sweep_to_l1 above threshold.
9. For spread scanners, do not use wallet balance as price; use a verified DEX/oracle quote view.
10. For spread scanners, require non-empty INITIA_PRICE_VIEW_TYPE_ARGS (comma-separated Move type tags) and never send empty type_args to generic quote functions.
11. For cross-chain arbitrage, use TRADE_CAPITAL_USDC = 1000000n, quote Pool A then Pool B with move_view get_amount_out, compute final_usdc_output - TRADE_CAPITAL_USDC - bridgeFee, and if profitable execute three separate move_execute calls: swap, bridge, swap back.
12. Never mention wrapper SDK tooling in generated output.
13. Never add wrapper SDK dependencies; always generate direct MCP payload calls with address/module/function/type_args/args.
14. For cross_chain_liquidation, read mock_lending::get_health_factor for each address in INITIA_LIQUIDATION_WATCHLIST and call mock_lending::liquidate when value < 1000000.
15. For simulated price-crash workflows, call mock_oracle::set_price with reduced collateral token price before liquidation checks.
""".strip()


def main() -> None:
    args = parse_args()
    config = load_config(args)
    prompt = build_prompt(config)

    print(f"\nBot: {config['botName']}")
    print(f"Chain: {config['chain']}")

    server_url = os.environ.get("META_AGENT_URL", "http://127.0.0.1:8000") + "/create-bot"
    try:
        response = requests.post(
            server_url,
            json={"prompt": prompt},
            headers={"accept": "application/json"},
            timeout=180,
        )
    except requests.exceptions.RequestException as exc:
        print(f"Request failed: {exc}")
        raise SystemExit(1)

    if response.status_code != 200:
        print(f"HTTP {response.status_code}: {response.text}")
        raise SystemExit(1)

    data = response.json()
    output = data.get("output", {})

    bot_slug = str(config["botName"]).replace(" ", "_").lower()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder = f"{bot_slug}_{timestamp}"
    os.makedirs(folder, exist_ok=True)

    with open(os.path.join(folder, "bot_config.json"), "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)

    for file in output.get("files", []):
        filepath = str(file.get("filepath", "unknown.ts"))
        content = file.get("content", "")
        if not isinstance(content, str):
            content = json.dumps(content, indent=2)
        out_path = os.path.join(folder, os.path.basename(filepath))
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(content)
        print(f"Saved {os.path.basename(out_path)}")


if __name__ == "__main__":
    main()
