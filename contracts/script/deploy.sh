#!/usr/bin/env bash
set -euo pipefail

# ── Deploy UniswapV3LPHelper ─────────────────────────────────────────
#
# Usage:
#   ./script/deploy.sh <chain> [--broadcast] [--verify]
#
# Chains: arbitrum, ethereum, sepolia
#
# Examples:
#   ./script/deploy.sh sepolia                    # dry-run simulation
#   ./script/deploy.sh sepolia --broadcast        # deploy for real
#   ./script/deploy.sh arbitrum --broadcast --verify  # deploy + verify on Etherscan
#
# Required env vars:
#   PRIVATE_KEY         - deployer private key
#   <CHAIN>_RPC_URL     - RPC endpoint (e.g. ARBITRUM_RPC_URL, SEPOLIA_RPC_URL)
#
# Optional env vars:
#   ETHERSCAN_API_KEY   - for contract verification (--verify)
# ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOYMENTS_DIR="$(dirname "$CONTRACTS_DIR")/deployments"

CHAIN="${1:?Usage: ./script/deploy.sh <chain> [--broadcast] [--verify]}"
shift

# Map chain name to RPC env var
case "$CHAIN" in
  arbitrum)  RPC_VAR="ARBITRUM_RPC_URL"; DEPLOYMENT_FILE="arbitrum.json" ;;
  ethereum)  RPC_VAR="ETHEREUM_RPC_URL"; DEPLOYMENT_FILE="ethereum.json" ;;
  sepolia)   RPC_VAR="SEPOLIA_RPC_URL";  DEPLOYMENT_FILE="sepolia.json"  ;;
  *)
    echo "Error: Unknown chain '$CHAIN'. Supported: arbitrum, ethereum, sepolia"
    exit 1
    ;;
esac

RPC_URL="${!RPC_VAR:?Error: $RPC_VAR is not set}"

if [ -z "${PRIVATE_KEY:-}" ]; then
  echo "Error: PRIVATE_KEY is not set"
  exit 1
fi

echo "==> Deploying UniswapV3LPHelper to $CHAIN"
echo "    RPC: $RPC_VAR"
echo "    Flags: $*"

# Run forge script from the contracts directory
cd "$CONTRACTS_DIR"

forge script script/DeployLPHelper.s.sol:DeployLPHelper \
  --rpc-url "$RPC_URL" \
  -vvvv \
  "$@"

# After a successful broadcast, extract the deployed address and update the deployment JSON
if [[ " $* " == *" --broadcast "* ]]; then
  echo ""
  echo "==> Deployment broadcast complete."
  echo "    Check the broadcast logs in: contracts/broadcast/"
  echo ""

  # Try to extract deployed address from the broadcast output
  BROADCAST_FILE="$CONTRACTS_DIR/broadcast/DeployLPHelper.s.sol/$(forge script script/DeployLPHelper.s.sol:DeployLPHelper --rpc-url "$RPC_URL" --json 2>/dev/null | jq -r '.chain' 2>/dev/null || echo "unknown")/run-latest.json"

  if [ -f "$BROADCAST_FILE" ]; then
    DEPLOYED_ADDR=$(jq -r '.transactions[] | select(.transactionType == "CREATE") | .contractAddress' "$BROADCAST_FILE" 2>/dev/null | head -1)
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
