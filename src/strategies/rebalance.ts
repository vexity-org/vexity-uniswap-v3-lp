/**
 * Uniswap V3 LP Rebalance Strategy
 *
 * Creates or rebalances a concentrated liquidity position on Uniswap V3.
 * Uses a custom compiler because $pool and $tokenId must be resolved at
 * compile time via RPC — they are not user-provided parameters.
 *
 * Flow:
 * 1. [Rebalance only] Remove liquidity from current position
 * 2. [Rebalance only] Collect freed tokens and accrued fees
 * 3. Swap surplus token to achieve optimal ratio for new range
 * 4. Mint new LP position centered on current pool price
 *
 * Integration (add to main repo's rag/index.ts):
 *   import "../skills/uniswap-v3-lp/strategies/rebalance";
 */

// ---------------------------------------------------------------------------
// Main repo imports — these resolve when the file is placed at:
//   packages/agent/src/skills/uniswap-v3-lp/strategies/rebalance.ts
//
// For the plugin repo (standalone), these are used for type-checking only.
// The actual registration happens when the file is imported by the main repo.
// ---------------------------------------------------------------------------

// When integrating into the main repo, uncomment these imports and remove
// the inlined types below:
//
// import type { StrategyDescriptor } from "../../../rag/types";
// import { STRATEGY_REGISTRY } from "../../../rag/strategy-registry";
// import { compileScript } from "../../../tools/compile-script";
// import { resolveToken } from "../../../registry/tokens";
// import { compileRebalance } from "../rebalance-compiler";
//
// Create the bound compiler with injected deps:
// const boundCompiler = (params, owner, chainId, rpcUrl, prependOps) =>
//   compileRebalance(params, owner, chainId, rpcUrl, prependOps, {
//     compileScript,
//     resolveToken,
//   });
//
// STRATEGY_REGISTRY.register(uniswapV3LpRebalance);
// STRATEGY_REGISTRY.registerCompiler("uniswap-v3-lp:rebalance", boundCompiler);

import type { StrategyCompilationResult, Operation } from "../rebalance-compiler";

// ---------------------------------------------------------------------------
// Strategy Descriptor
// ---------------------------------------------------------------------------

export interface StrategyDescriptor {
  id: string;
  name: string;
  description: string;
  tags: string[];
  triggers: string[];
  params: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    default?: string;
  }>;
  steps: Array<{
    actionId: string;
    params: Record<string, string>;
    label: string;
  }>;
  examples: Array<{
    input: string;
    params: Record<string, string>;
  }>;
  chains: number[];
}

export const uniswapV3LpRebalance: StrategyDescriptor = {
  id: "uniswap-v3-lp:rebalance",
  name: "Uniswap V3 LP Rebalance",
  description:
    "Create or rebalance a Uniswap V3 concentrated liquidity position — " +
    "exits the existing position, collects all fees, rebalances token ratio via swap, " +
    "then mints a fresh position centered on the current pool price",
  tags: [
    "uniswap",
    "lp",
    "rebalance",
    "concentrated-liquidity",
    "yield",
    "v3",
    "position",
    "liquidity",
    "range",
    "auto-compound",
  ],
  triggers: [
    "rebalance uniswap lp position",
    "auto rebalance lp",
    "rebalance concentrated liquidity",
    "keep lp in range",
    "uniswap v3 rebalance",
    "rebalance my uniswap position",
    "auto-compound uniswap lp fees",
    "active lp management",
    "rebalance when out of range",
    "uniswap v3 auto rebalance",
    "re-center my LP",
    "my uniswap LP is out of range",
    "adjust LP range",
    "create a new LP position",
    "provide liquidity on uniswap",
  ],
  params: [
    {
      name: "token0",
      type: "token",
      required: true,
      description:
        "First token of the LP pair (e.g. WETH). Must have lower address than token1.",
    },
    {
      name: "token1",
      type: "token",
      required: true,
      description:
        "Second token of the LP pair (e.g. USDC). Must have higher address than token0.",
    },
    {
      name: "feeTier",
      type: "number",
      required: true,
      description:
        "Pool fee tier: 100 (0.01%), 500 (0.05%), 3000 (0.3%), or 10000 (1%)",
    },
    {
      name: "rangeWidthBps",
      type: "number",
      required: true,
      description:
        "Total width of the new range in basis points (e.g. 1000 = ~±5% around current price)",
    },
    {
      name: "driftBufferBps",
      type: "number",
      required: false,
      description:
        "Optional price drift buffer in bps for automation trigger threshold",
    },
  ],
  // Steps are empty — this strategy uses a custom compiler (rebalance-compiler.ts)
  // that pre-computes tick ranges and token splits at compile time via RPC.
  steps: [],
  examples: [
    {
      input:
        "Rebalance my WETH/USDC 0.05% LP to a ±5% range",
      params: {
        token0: "WETH",
        token1: "USDC",
        feeTier: "500",
        rangeWidthBps: "1000",
      },
    },
    {
      input:
        "My WBTC/WETH 0.3% LP is out of range, re-center with 20% range",
      params: {
        token0: "WBTC",
        token1: "WETH",
        feeTier: "3000",
        rangeWidthBps: "2000",
      },
    },
    {
      input:
        "Create a new WETH/USDC LP position centered on current price with ±2% range",
      params: {
        token0: "WETH",
        token1: "USDC",
        feeTier: "500",
        rangeWidthBps: "400",
      },
    },
    {
      input:
        "Auto-rebalance my WETH/USDC Uniswap V3 LP when it goes out of range",
      params: {
        token0: "WETH",
        token1: "USDC",
        feeTier: "500",
        rangeWidthBps: "1000",
        driftBufferBps: "200",
      },
    },
  ],
  chains: [1, 42161, 10, 8453],
};
