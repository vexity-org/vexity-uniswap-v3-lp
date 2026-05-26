/**
 * Main Repo Integration
 *
 * This file shows how to register the uniswap-v3-lp:rebalance compiler
 * in the main Vexity agent repo. Place this file at:
 *   packages/agent/src/skills/uniswap-v3-lp/strategies/rebalance.ts
 *
 * Then add this import to packages/agent/src/rag/index.ts:
 *   import "../skills/uniswap-v3-lp/strategies/rebalance";
 *
 * This follows the same side-effect registration pattern used by:
 *   - packages/agent/src/skills/aave-v3/strategies/aave-leverage.ts
 *   - packages/agent/src/skills/euler-v2/strategies/euler-leverage.ts
 */

import type { Address } from "viem";

import type { StrategyDescriptor } from "../../../rag/types";
import { STRATEGY_REGISTRY } from "../../../rag/strategy-registry";
import { compileScript } from "../../../tools/compile-script";
import { resolveToken } from "../../../registry/tokens";
import type { Operation } from "../../../tools/types";
import type { StrategyCompilationResult } from "../../../rag/types";

import { compileRebalance } from "../rebalance-compiler";
import { uniswapV3LpRebalance } from "./rebalance-descriptor";

// ── Register strategy + custom compiler ───────────────────────────────
STRATEGY_REGISTRY.register(uniswapV3LpRebalance as unknown as StrategyDescriptor);

STRATEGY_REGISTRY.registerCompiler(
  "uniswap-v3-lp:rebalance",
  async (
    params: Record<string, string>,
    owner: Address,
    chainId: number,
    rpcUrl?: string,
    prependOps?: Operation[],
  ): Promise<StrategyCompilationResult> => {
    return compileRebalance(params, owner, chainId, rpcUrl, prependOps as any[], {
      compileScript: compileScript as any,
      resolveToken: resolveToken as any,
    });
  },
);
