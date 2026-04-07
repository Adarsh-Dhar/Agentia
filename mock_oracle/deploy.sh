#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WALLET_ADDRESS="${1:-${ACCOUNT_HEX:-}}"
ACCOUNT_NAME="${2:-${ACCOUNT_NAME:-test-account}}"
CHAIN_ID="${CHAIN_ID:-initiation-2}"
PRIMARY_NODE="${NODE_URL:-https://rpc.testnet.initia.xyz:443}"
FALLBACK_NODE="${NODE_URL_FALLBACK:-https://initia-testnet-rpc.polkachu.com}"
NODES=("$PRIMARY_NODE" "$FALLBACK_NODE")

if [[ -z "$WALLET_ADDRESS" ]]; then
  echo "Usage: ./deploy.sh <0xHEX_ADDRESS> [account_name]"
  echo "Tip: export ACCOUNT_HEX from 'initiad keys parse ...' output"
  exit 1
fi

if ! command -v initiad >/dev/null 2>&1; then
  echo "initiad not found in PATH"
  exit 1
fi

DEPLOY_OK=0
for NODE in "${NODES[@]}"; do
  for ATTEMPT in 1 2 3; do
    echo "Deploying MockOracle via ${NODE} (attempt ${ATTEMPT}/3)"
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
      --chain-id "$CHAIN_ID" \
      --output json \
      --yes | tee /tmp/mock_oracle_deploy_output.json; then
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

echo "MockOracle deployment submitted. Inspect /tmp/mock_oracle_deploy_output.json"
