/**
 * Uniswap V3 LP Rebalance Compiler
 *
 * Conforms to the PluginCompiler interface. Uses only PluginCompilerContext
 * APIs — no raw Node.js access, no direct viem imports, no filesystem.
 *
 * Flow:
 * 1. Resolve token addresses and ensure correct sort order (token0 < token1)
 * 2. Query pool for current tick via ctx.rpc.call()
 * 3. Calculate new tickLower/tickUpper from rangeWidthBps
 * 4. Find user's existing position (if any)
 * 5. Build operations: decreaseLiquidity → collect → approve × 2 → mint
 * 6. Compile via ctx.weiroll.compile()
 */

// ============================================================================
// Fee tier → tick spacing mapping
// ============================================================================

const FEE_TO_TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

const VALID_FEE_TIERS = new Set(Object.keys(FEE_TO_TICK_SPACING).map(Number));

// ============================================================================
// Tick Math Helpers
// ============================================================================

/**
 * Get the tick spacing for a given fee tier.
 */
function getTickSpacing(feeTier: number): number {
  const spacing = FEE_TO_TICK_SPACING[feeTier];
  if (!spacing) {
    throw new Error(
      `Unsupported fee tier: ${feeTier}. Supported: ${Object.keys(FEE_TO_TICK_SPACING).join(", ")}`,
    );
  }
  return spacing;
}

/**
 * Convert a range width in BPS to a tick delta, rounded to tick spacing.
 *
 * rangeWidthBps is the TOTAL range width. We compute half the range
 * and convert to ticks: tickDelta = ln(1 + halfBps/10000) / ln(1.0001)
 */
function bpsToTickDelta(rangeWidthBps: number, tickSpacing: number): number {
  const halfBps = rangeWidthBps / 2;
  const tickDelta = Math.log(1 + halfBps / 10_000) / Math.log(1.0001);
  // Round down to nearest tick spacing (must be at least 1 spacing unit)
  const rounded = Math.max(
    tickSpacing,
    Math.floor(tickDelta / tickSpacing) * tickSpacing,
  );
  return rounded;
}

// ============================================================================
// RPC Helpers (using PluginCompilerContext)
// ============================================================================

interface CompilerContext {
  rpc: {
    call(params: { to: string; data: string; chainId: number }): Promise<string>;
  };
  abis: {
    encodeFunctionData(abiId: string, fn: string, args: unknown[]): string;
    decodeFunctionResult(abiId: string, fn: string, data: string): unknown;
  };
  contracts: {
    getAddress(chainId: number, protocol: string, name: string): string | undefined;
  };
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  weiroll: {
    compile(operations: PluginOp[], owner: string, chainId: number): CompiledResult;
  };
}

interface PluginOp {
  type: "approve" | "custom" | "transfer" | "swap";
  token?: string;
  amount?: string;
  recipient?: string;
  spender?: string;
  _actionId?: string;
  args?: Record<string, unknown>;
  tokenIn?: string;
  tokenOut?: string;
  slippageBps?: number;
  fee?: number;
}

interface CompiledResult {
  commands: string[];
  state: string[];
  stepDescriptions: string[];
  description: string;
  quoteCommands?: string[];
  quoteState?: string[];
  patchSlots?: number[];
}

interface StrategyDesc {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface PositionMatch {
  tokenId: bigint;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

/**
 * Fetch the pool address for a token pair + fee tier via the Factory contract.
 */
async function fetchPoolAddress(
  ctx: CompilerContext,
  token0: string,
  token1: string,
  fee: number,
  chainId: number,
): Promise<string | null> {
  const factory = ctx.contracts.getAddress(chainId, "uniswap-v3", "factory");
  if (!factory) throw new Error(`Uniswap V3 Factory not found on chain ${chainId}`);

  const data = ctx.abis.encodeFunctionData("uniswap-v3:factory", "getPool", [token0, token1, fee]);
  const result = await ctx.rpc.call({ to: factory, data, chainId });

  const decoded = ctx.abis.decodeFunctionResult("uniswap-v3:factory", "getPool", result);
  const poolAddress = decoded as string;

  // Factory returns zero address for non-existent pools
  if (!poolAddress || poolAddress === "0x0000000000000000000000000000000000000000") return null;

  return poolAddress;
}

/**
 * Fetch the current tick from a Uniswap V3 pool's slot0.
 */
async function fetchCurrentTick(
  ctx: CompilerContext,
  poolAddress: string,
  chainId: number,
): Promise<number> {
  const data = ctx.abis.encodeFunctionData("uniswap-v3:pool", "slot0", []);
  const result = await ctx.rpc.call({ to: poolAddress, data, chainId });
  const decoded = ctx.abis.decodeFunctionResult("uniswap-v3:pool", "slot0", result);

  // slot0 returns a tuple: [sqrtPriceX96, tick, ...]
  const tuple = decoded as readonly unknown[];
  return Number(tuple[1]);
}

/**
 * Find a user's existing LP position NFT matching the token pair + fee tier.
 * Returns the position with the most liquidity, or null if none found.
 */
async function findUserPosition(
  ctx: CompilerContext,
  owner: string,
  token0: string,
  token1: string,
  fee: number,
  chainId: number,
): Promise<PositionMatch | null> {
  const positionManager = ctx.contracts.getAddress(chainId, "uniswap-v3", "position-manager");
  if (!positionManager) throw new Error(`Uniswap V3 NonfungiblePositionManager not found on chain ${chainId}`);

  // Get balance of NFT positions
  const balanceData = ctx.abis.encodeFunctionData("uniswap-v3:position-manager", "balanceOf", [owner]);
  const balanceResult = await ctx.rpc.call({ to: positionManager, data: balanceData, chainId });
  const balance = ctx.abis.decodeFunctionResult("uniswap-v3:position-manager", "balanceOf", balanceResult) as bigint;

  if (balance === 0n) return null;

  const t0Lower = token0.toLowerCase();
  const t1Lower = token1.toLowerCase();
  let bestMatch: PositionMatch | null = null;

  // Enumerate positions and find matching pair + fee
  for (let i = 0n; i < balance; i++) {
    const tokenIdData = ctx.abis.encodeFunctionData("uniswap-v3:position-manager", "tokenOfOwnerByIndex", [owner, i]);
    const tokenIdResult = await ctx.rpc.call({ to: positionManager, data: tokenIdData, chainId });
    const tokenId = ctx.abis.decodeFunctionResult("uniswap-v3:position-manager", "tokenOfOwnerByIndex", tokenIdResult) as bigint;

    const posData = ctx.abis.encodeFunctionData("uniswap-v3:position-manager", "positions", [tokenId]);
    const posResult = await ctx.rpc.call({ to: positionManager, data: posData, chainId });
    const pos = ctx.abis.decodeFunctionResult("uniswap-v3:position-manager", "positions", posResult) as readonly unknown[];

    // positions() returns: [nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, ...]
    const posToken0 = (pos[2] as string).toLowerCase();
    const posToken1 = (pos[3] as string).toLowerCase();
    const posFee = Number(pos[4]);
    const posLiquidity = pos[7] as bigint;

    if (posToken0 === t0Lower && posToken1 === t1Lower && posFee === fee) {
      if (!bestMatch || posLiquidity > bestMatch.liquidity) {
        bestMatch = {
          tokenId,
          liquidity: posLiquidity,
          tickLower: Number(pos[5]),
          tickUpper: Number(pos[6]),
        };
      }
    }
  }

  return bestMatch;
}

// ============================================================================
// Plugin Compiler Export
// ============================================================================

const MAX_UINT128 = ((1n << 128n) - 1n).toString();

const compiler = {
  strategyId: "uniswap-v3-lp:rebalance",

  async compile(
    _strategy: StrategyDesc,
    params: Record<string, string>,
    ctx: CompilerContext,
  ): Promise<CompiledResult> {
    const chainId = parseInt(params["_chainId"] ?? "42161", 10);
    const owner = params["_owner"];
    if (!owner) throw new Error("Missing _owner in params — required for position lookup and Weiroll compilation");

    // ---- 1. Resolve tokens ----
    const token0Param = params["token0"];
    const token1Param = params["token1"];
    if (!token0Param || !token1Param) {
      throw new Error("Missing required params: token0 and token1");
    }

    const feeTier = parseInt(params["feeTier"] ?? "3000", 10);
    if (!VALID_FEE_TIERS.has(feeTier)) {
      throw new Error(`Unsupported fee tier: ${feeTier}. Supported: ${[...VALID_FEE_TIERS].join(", ")}`);
    }

    const rangeWidthBps = parseInt(params["rangeWidthBps"] ?? "1000", 10);
    if (rangeWidthBps <= 0 || rangeWidthBps > 20000) {
      throw new Error(`rangeWidthBps must be between 1 and 20000 (got ${rangeWidthBps})`);
    }

    // Token params may be symbols (from LLM) or addresses.
    // For this compiler, we pass them through to the Weiroll compiler which
    // handles token resolution internally via the core token registry.
    const token0 = token0Param;
    const token1 = token1Param;

    // ---- 2. Validate tick spacing ----
    const tickSpacing = getTickSpacing(feeTier);

    // ---- 3. Query pool and current tick ----
    ctx.log.info(`Querying pool for ${token0}/${token1} fee=${feeTier} on chain ${chainId}`);

    const poolAddress = await fetchPoolAddress(ctx, token0, token1, feeTier, chainId);
    if (!poolAddress) {
      // Try reversed order
      const reversedPool = await fetchPoolAddress(ctx, token1, token0, feeTier, chainId);
      if (!reversedPool) {
        throw new Error(
          `No Uniswap V3 pool found for ${token0}/${token1} with fee tier ${feeTier} on chain ${chainId}`,
        );
      }
    }

    const resolvedPool = poolAddress ?? await fetchPoolAddress(ctx, token1, token0, feeTier, chainId);
    if (!resolvedPool) {
      throw new Error(`No Uniswap V3 pool found for ${token0}/${token1} with fee tier ${feeTier} on chain ${chainId}`);
    }

    const currentTick = await fetchCurrentTick(ctx, resolvedPool, chainId);
    ctx.log.info(`Current tick: ${currentTick}`);

    // ---- 4. Calculate new tick bounds ----
    const tickDelta = bpsToTickDelta(rangeWidthBps, tickSpacing);
    const alignedCenter = Math.round(currentTick / tickSpacing) * tickSpacing;
    const newTickLower = alignedCenter - tickDelta;
    const newTickUpper = alignedCenter + tickDelta;

    ctx.log.info(`New range: [${newTickLower}, ${newTickUpper}] (delta=${tickDelta}, center=${alignedCenter})`);

    // ---- 5. Find existing position ----
    const position = await findUserPosition(ctx, owner, token0, token1, feeTier, chainId);
    const isInitialMint = !position;

    if (position) {
      ctx.log.info(`Found position #${position.tokenId} with liquidity ${position.liquidity}`);
    } else {
      ctx.log.info("No existing position found — will mint a new one");
    }

    const positionManager = ctx.contracts.getAddress(chainId, "uniswap-v3", "position-manager");
    if (!positionManager) throw new Error(`Uniswap V3 NonfungiblePositionManager not found on chain ${chainId}`);

    // ---- 6. Build operations ----
    const operations: PluginOp[] = [];
    const stepDescriptions: string[] = [];

    // Far-future deadline (2 hours from "now")
    const deadline = String(Math.floor(Date.now() / 1000) + 7200);

    if (!isInitialMint) {
      // Remove all liquidity from existing position
      operations.push({
        type: "custom",
        _actionId: "uniswap-v3:decrease-liquidity",
        args: {
          tokenId: position.tokenId.toString(),
          liquidity: position.liquidity.toString(),
          amount0Min: "0",
          amount1Min: "0",
          deadline,
        },
      });
      stepDescriptions.push(`Remove all liquidity from position #${position.tokenId}`);

      // Collect all tokens (withdrawn liquidity + accrued fees)
      operations.push({
        type: "custom",
        _actionId: "uniswap-v3:collect",
        args: {
          tokenId: position.tokenId.toString(),
          recipient: "OWNER",
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      });
      stepDescriptions.push(`Collect all tokens from position #${position.tokenId}`);
    }

    // Approve token0 for position manager
    operations.push({
      type: "approve",
      token: token0,
      amount: "MAX",
      spender: positionManager,
    });
    stepDescriptions.push(`Approve ${token0} for position manager`);

    // Approve token1 for position manager
    operations.push({
      type: "approve",
      token: token1,
      amount: "MAX",
      spender: positionManager,
    });
    stepDescriptions.push(`Approve ${token1} for position manager`);

    // Mint new position at computed range
    operations.push({
      type: "custom",
      _actionId: "uniswap-v3:mint-position",
      args: {
        token0,
        token1,
        fee: String(feeTier),
        tickLower: String(newTickLower),
        tickUpper: String(newTickUpper),
        amount0Desired: "BALANCE",
        amount1Desired: "BALANCE",
        amount0Min: "0",
        amount1Min: "0",
        recipient: "OWNER",
        deadline,
      },
    });

    const feeDisplay = `${feeTier / 100}bps`;
    stepDescriptions.push(
      `Mint new position: ${token0}/${token1} [${newTickLower}, ${newTickUpper}] (fee: ${feeDisplay})`,
    );

    // ---- 7. Compile to Weiroll bytecode ----
    const compiled = ctx.weiroll.compile(operations, owner, chainId);

    const description = isInitialMint
      ? `Mint ${token0}/${token1} LP position [${newTickLower}, ${newTickUpper}] (${feeDisplay}) centered on tick ${currentTick}`
      : `Rebalance ${token0}/${token1} LP position #${position.tokenId}: close old range [${position.tickLower}, ${position.tickUpper}] → open new range [${newTickLower}, ${newTickUpper}] centered on tick ${currentTick}`;

    return {
      commands: compiled.commands,
      state: compiled.state,
      stepDescriptions,
      description,
      quoteCommands: compiled.quoteCommands,
      quoteState: compiled.quoteState,
      patchSlots: compiled.patchSlots,
    };
  },
};

// Export for plugin system (default export or named — loader tries both)
export default compiler;
