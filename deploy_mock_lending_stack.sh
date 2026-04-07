#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

NODE_URL="${NODE_URL:-https://rpc.testnet.initia.xyz}"
CHAIN_ID="${CHAIN_ID:-initiation-2}"
ACCOUNT_NAME="${ACCOUNT_NAME:-test-account}"

if ! command -v initiad >/dev/null 2>&1; then
  echo "initiad not found in PATH"
  exit 1
fi

ACCOUNT_HEX="${ACCOUNT_HEX:-}"
if [[ -z "$ACCOUNT_HEX" ]]; then
  ACCOUNT_ADDR="$(initiad keys show "$ACCOUNT_NAME" -a)"
  ACCOUNT_HEX="$(initiad keys parse "$ACCOUNT_ADDR" | awk '/bytes:/ {print $2}')"
fi

ACCOUNT_ADDR="${ACCOUNT_ADDR:-$(initiad keys show "$ACCOUNT_NAME" -a)}"

if [[ -z "$ACCOUNT_HEX" ]]; then
  echo "Could not resolve ACCOUNT_HEX. Set ACCOUNT_NAME or export ACCOUNT_HEX."
  exit 1
fi

echo "Using deployer/module address: $ACCOUNT_HEX"

./mock_oracle/deploy.sh "$ACCOUNT_HEX" "$ACCOUNT_NAME"
./mock_lending/deploy.sh "$ACCOUNT_HEX" "$ACCOUNT_NAME"

echo "Initializing mock_oracle_v2"
initiad tx move execute "$ACCOUNT_ADDR" mock_oracle_v2 initialize \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

echo "Initializing mock_lending_v2"
initiad tx move execute "$ACCOUNT_ADDR" mock_lending_v2 initialize \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

echo "Deploy + initialization flow submitted."
