#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WALLET_ADDRESS="${1:-${INITIA_DEPLOYER_ADDRESS:-}}"
ACCOUNT_NAME="${2:-${INITIAD_ACCOUNT_NAME:-test-account}}"
PRIMARY_NODE="${INITIA_NODE:-https://rpc.testnet.initia.xyz:443}"
FALLBACK_NODE="${INITIA_NODE_FALLBACK:-https://initia-testnet-rpc.polkachu.com}"
NODES=("$PRIMARY_NODE" "$FALLBACK_NODE")

if [[ -z "$WALLET_ADDRESS" ]]; then
  echo "Usage: ./deploy.sh <YOUR_0x_WALLET_ADDRESS> [keyring_account_name]"
  exit 1
fi

if ! command -v initiad >/dev/null 2>&1; then
  echo "initiad not found in PATH"
  exit 1
fi

DEPLOY_OK=0
for NODE in "${NODES[@]}"; do
  for ATTEMPT in 1 2 3; do
    echo "Attempt ${ATTEMPT} via ${NODE}"
    if initiad move deploy \
      --path "$SCRIPT_DIR" \
      --build \
      --skip-fetch-latest-git-deps \
      --named-addresses deployer="$WALLET_ADDRESS" \
      --from "$ACCOUNT_NAME" \
      --gas auto \
      --gas-adjustment 1.5 \
      --gas-prices 0.015uinit \
      --node "$NODE" \
      --chain-id initiation-2 \
      --output json \
      --yes | tee /tmp/arbitrage_router_deploy_output.json; then
      DEPLOY_OK=1
      break 2
    fi
    sleep 2
  done
done

if [[ "$DEPLOY_OK" -ne 1 ]]; then
  echo "Deployment failed on all configured RPC endpoints"
  exit 1
fi

echo "Deployment submitted. Inspect /tmp/arbitrage_router_deploy_output.json for ModulePublishedEvent"
