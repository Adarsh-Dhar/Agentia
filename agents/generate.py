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
    "initia-mainnet": "interwoven-1",
    "initia-testnet": "initiation-2",
}

TOKEN_DENOMS = {
    "INIT": {"initia-mainnet": "uinit", "initia-testnet": "uinit"},
    "USDC": {"initia-mainnet": "uusdc", "initia-testnet": "uusdc"},
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
4. Keep runtime strictly Initia-native with no external chain SDK/tooling.
5. For yield sweeper behavior, read 0x1::coin::balance and execute interwoven_bridge::sweep_to_l1 above threshold.
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
