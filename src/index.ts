/**
 * Vexity Uniswap V3 LP Plugin — Custom Compiler
 *
 * Exports the rebalance strategy compiler and descriptor for integration
 * with the main Vexity agent.
 *
 * Usage from the main repo:
 *   import { compileRebalance, uniswapV3LpRebalance } from "vexity-uniswap-v3-lp";
 *   import { compileScript } from "../tools/compile-script";
 *   import { resolveToken } from "../registry/tokens";
 *
 *   STRATEGY_REGISTRY.register(uniswapV3LpRebalance);
 *   STRATEGY_REGISTRY.registerCompiler("uniswap-v3-lp:rebalance", (p, o, c, r, ops) =>
 *     compileRebalance(p, o, c, r, ops, { compileScript, resolveToken }),
 *   );
 */

export { compileRebalance } from "./rebalance-compiler";
export type {
  StrategyCompilationResult,
  Operation,
  CompileScriptFn,
  ResolveTokenFn,
} from "./rebalance-compiler";
export { uniswapV3LpRebalance } from "./strategies/rebalance";
export type { StrategyDescriptor } from "./strategies/rebalance";
