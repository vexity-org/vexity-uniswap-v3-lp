#!/usr/bin/env bash
set -euo pipefail

# ── Deploy UniswapV3LPHelper to Arbitrum ────────────────────────────
#
# Usage:
#   ./script/deploy.sh [--account <name>] [--broadcast] [--verify]
#
# Signing methods (pick one):
#   --account <name>     Use a Foundry keystore wallet (cast wallet import)
#   --private-key <key>  Use a raw private key
#   --ledger             Use a Ledger hardware wallet
#   --trezor             Use a Trezor hardware wallet
#
# If no signing method is specified, PRIVATE_KEY env var is used as fallback.
#
# Examples:
#   ./script/deploy.sh --account deployer              # dry-run with keystore
#   ./script/deploy.sh --account deployer --broadcast   # deploy with keystore
#   ./script/deploy.sh --account hot --broadcast --verify
#   ./script/deploy.sh --broadcast                      # uses PRIVATE_KEY env
#
# Required env vars:
#   ARBITRUM_RPC_URL    - RPC endpoint for Arbitrum
#
# Optional env vars:
#   PRIVATE_KEY         - deployer private key (fallback if no --account/--ledger)
#   ETHERSCAN_API_KEY   - for contract verification (--verify)
# ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOYMENTS_DIR="$(dirname "$CONTRACTS_DIR")/deployments"

CHAIN="arbitrum"
DEPLOYMENT_FILE="arbitrum.json"
RPC_URL="${ARBITRUM_RPC_URL:?Error: ARBITRUM_RPC_URL is not set}"

# Check if a signing method is provided in the flags
HAS_SIGNER=false
for arg in "$@"; do
  case "$arg" in
    --account|--private-key|--ledger|--trezor) HAS_SIGNER=true ;;
  esac
done

# Build extra flags for signing
SIGNER_FLAGS=()
if [ "$HAS_SIGNER" = false ]; then
  if [ -n "${PRIVATE_KEY:-}" ]; then
    SIGNER_FLAGS=("--private-key" "$PRIVATE_KEY")
  else
    echo "Error: No signing method provided."
    echo "  Use --account <name>, --private-key <key>, --ledger, or set PRIVATE_KEY env var."
    echo ""
    echo "  To import a wallet:  cast wallet import <name> --interactive"
    echo "  To list wallets:     cast wallet list"
    exit 1
  fi
fi

echo "==> Deploying UniswapV3LPHelper to $CHAIN"
echo "    RPC: ARBITRUM_RPC_URL"
echo "    Flags: $*"

# Run forge script from the contracts directory
cd "$CONTRACTS_DIR"

forge script script/DeployLPHelper.s.sol:DeployLPHelper \
  --rpc-url "$RPC_URL" \
  "${SIGNER_FLAGS[@]}" \
  -vvvv \
  "$@"

# After a successful broadcast, extract the deployed address
if [[ " $* " == *" --broadcast "* ]]; then
  echo ""
  echo "==> Deployment broadcast complete."
  echo "    Check the broadcast logs in: contracts/broadcast/"
  echo ""

  # Try to find the latest broadcast file for this chain
  CHAIN_BROADCAST_DIR="$CONTRACTS_DIR/broadcast/DeployLPHelper.s.sol"
  LATEST_RUN=$(find "$CHAIN_BROADCAST_DIR" -name "run-latest.json" 2>/dev/null | head -1)

  if [ -n "$LATEST_RUN" ]; then
    DEPLOYED_ADDR=$(jq -r '.transactions[] | select(.transactionType == "CREATE") | .contractAddress' "$LATEST_RUN" 2>/dev/null | head -1)
    if [ -n "$DEPLOYED_ADDR" ] && [ "$DEPLOYED_ADDR" != "null" ]; then
      echo "==> Deployed address: $DEPLOYED_ADDR"
      echo ""
      echo "    To update deployments/$DEPLOYMENT_FILE, run:"
      echo "    jq '.contracts.\"lp-helper\".address = \"$DEPLOYED_ADDR\"' $DEPLOYMENTS_DIR/$DEPLOYMENT_FILE > tmp.json && mv tmp.json $DEPLOYMENTS_DIR/$DEPLOYMENT_FILE"
    fi
  else
    echo "    Could not auto-detect broadcast file. Check broadcast/ directory manually."
  fi
fi
