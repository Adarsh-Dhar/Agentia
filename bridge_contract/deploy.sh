#!/usr/bin/env bash
# =============================================================================
#  deploy.sh — One-click MockBridge deployer for Initia testnet
#
#  Usage:
#    chmod +x deploy.sh
#    ./deploy.sh <YOUR_init1_WALLET_ADDRESS> [keyring_account_name]
#
#  Example:
#    ./deploy.sh init1abc123def456...
# =============================================================================

set -euo pipefail  # Exit immediately if any command fails, including piped commands

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p "$SCRIPT_DIR/sources"
cp "$SCRIPT_DIR/bridge.move" "$SCRIPT_DIR/sources/bridge.move"

# --------------------------------------------------------------------------
# 0. Validate input
# --------------------------------------------------------------------------
WALLET_ADDRESS="${1:-${INITIA_DEPLOYER_ADDRESS:-}}"
ACCOUNT_NAME="${2:-${INITIAD_ACCOUNT_NAME:-test-account}}"
PRIMARY_NODE="${INITIA_NODE:-https://rpc.testnet.initia.xyz:443}"
FALLBACK_NODE="${INITIA_NODE_FALLBACK:-https://initia-testnet-rpc.polkachu.com}"
NODES=("$PRIMARY_NODE" "$FALLBACK_NODE")
if [[ -z "$WALLET_ADDRESS" ]]; then
  echo ""
  echo "  ❌  Missing wallet address."
  echo ""
  echo "  Usage: ./deploy.sh <YOUR_init1_WALLET_ADDRESS> [keyring_account_name]"
  echo ""
  exit 1
fi

echo ""
echo "  ┌──────────────────────────────────────────┐"
echo "  │   MockBridge — Initia Testnet Deployer   │"
echo "  └──────────────────────────────────────────┘"
echo ""
echo "  Wallet  : $WALLET_ADDRESS"
echo "  Account  : $ACCOUNT_NAME"
echo "  Network : initiation-2 (testnet)"
echo "  Node    : ${NODES[*]}"
echo ""

# --------------------------------------------------------------------------
# 1. Check initiad is installed
# --------------------------------------------------------------------------
if ! command -v initiad &> /dev/null; then
  echo "  ❌  initiad not found in PATH."
  echo "      Install it from https://github.com/initia-labs/initia/releases"
  exit 1
fi

echo "  ✓  initiad found: $(initiad version 2>/dev/null || echo 'version unknown')"
echo ""

# --------------------------------------------------------------------------
# 2. Publish the contract
# --------------------------------------------------------------------------
echo "  📦  Publishing MockBridge module..."
echo ""

DEPLOY_OK=0
for NODE in "${NODES[@]}"; do
  for ATTEMPT in 1 2 3; do
    echo "  -> Attempt ${ATTEMPT} via ${NODE}"
    if initiad move deploy \
      --path "$SCRIPT_DIR" \
      --build \
      --named-addresses deployer="$WALLET_ADDRESS" \
      --from "$ACCOUNT_NAME" \
      --gas auto \
      --gas-adjustment 1.5 \
      --gas-prices 0.015uinit \
      --node "$NODE" \
      --chain-id initiation-2 \
      --output json \
      --yes \
      | tee /tmp/deploy_output.json; then
      DEPLOY_OK=1
      break 2
    fi
    sleep 2
  done
done

if [[ "$DEPLOY_OK" -ne 1 ]]; then
  echo ""
  echo "  ❌ Deployment failed on all configured RPC endpoints."
  exit 1
fi

echo ""
echo "  ✅  Transaction broadcast complete."
echo ""

# --------------------------------------------------------------------------
# 3. Extract the module address hint
# --------------------------------------------------------------------------
echo "  ──────────────────────────────────────────"
echo "  Next steps:"
echo ""
echo "  1. Wait ~5 seconds for the tx to be included in a block."
echo ""
echo "  2. Look in the JSON output above for 'ModulePublishedEvent'."
echo "     Copy the 0x... address from that event."
echo ""
echo "  3. Add these two lines to your bot's .env file:"
echo ""
echo "       INITIA_BRIDGE_ADDRESS=0x<address_from_event>"
echo "       USER_WALLET_ADDRESS=0x<your_wallet_0x_address>"
echo ""
echo "  4. Restart your bot:  npm run start"
echo ""
echo "  If the bot prints:"
echo "       [ACT] ✓ Atomic execution succeeded"
echo "  — your Yield Sweeper is fully functional! 🎉"
echo "  ──────────────────────────────────────────"
echo ""
