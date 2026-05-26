/**
 * Rebalance Compiler
 *
 * Custom compiler for the uniswap-v3-lp:rebalance strategy. Resolves
 * $pool and $tokenId at compile time via RPC, pre-computes the tick
 * range and optimal amounts, then builds a flat Weiroll script.
 *
 * Two compilation paths:
 * - **Rebalance** (existing position): decrease → collect → swap → mint
 * - **New position** (no LP found): swap (if needed) → mint
 *
 * View function results (calculateRangeTicks, computeOptimalAmounts) are
 * pre-computed at compile time. State-changing operations (decrease,
 * collect, swap, mint) are compiled into the Weiroll script.
 *
 * The mint step uses BALANCE for amount0Desired/amount1Desired so it
 * adapts to the actual token balances at execution time — any drift
 * from the compile-time estimation is handled gracefully.
 *
 * Integration (in main repo's rag/index.ts):
 *   import "../skills/uniswap-v3-lp/strategies/rebalance";
 *
 * Reference: packages/agent/src/skills/aave-v3/leverage-compiler.ts
 */

import {
  type Address,
  type Hex,
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  formatUnits,
  maxUint128,
} from "viem";
import { arbitrum, mainnet, optimism, base } from "viem/chains";

// ---------------------------------------------------------------------------
// Types (aligned with main repo — import from proper paths when integrated)
// ---------------------------------------------------------------------------

export interface StrategyCompilationResult {
  commands: Hex[];
  state: Hex[];
  stepDescriptions: string[];
  description: string;
  quoteCommands?: Hex[];
  quoteState?: Hex[];
  patchSlots?: number[];
}

export interface Operation {
  type: string;
  token?: string;
  amount?: string;
  recipient?: string;
  spender?: string;
  asset?: string;
  onBehalfOf?: string;
  interestRateMode?: number;
  tokenIn?: string;
  tokenOut?: string;
  slippageBps?: number;
  fee?: number;
  from?: string;
  to?: string;
  _actionId?: string;
  args?: Record<string, unknown>;
  swapProvider?: string;
}

/** Dependency injected compile function (from main repo tools/compile-script) */
export type CompileScriptFn = (input: {
  operations: Operation[];
  chainId: number;
  owner?: Address;
}) => { commands: Hex[]; state: Hex[]; quoteCommands?: Hex[]; quoteState?: Hex[]; patchSlots?: number[] };

/** Dependency injected token resolver (from main repo registry/tokens) */
export type ResolveTokenFn = (
  symbolOrAddress: string,
  chainId: number,
) => { address: string; decimals: number; symbol: string } | undefined;

// ---------------------------------------------------------------------------
// ABIs for compile-time RPC calls
// ---------------------------------------------------------------------------

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

const POSITION_MANAGER_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

const LP_HELPER_ABI = parseAbi([
  "function calculateRangeTicks(address pool, uint24 rangeBps) view returns (int24 tickLower, int24 tickUpper)",
  "function computeOptimalAmounts(address pool, int24 tickLower, int24 tickUpper, uint256 amount0Available, uint256 amount1Available) view returns (uint256 amount0Desired, uint256 amount1Desired)",
]);

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

// ---------------------------------------------------------------------------
// Chain & deployment configuration
// ---------------------------------------------------------------------------

// Chain configs for viem's createPublicClient. Using `as any` to avoid
// requiring the full Chain type — we only need the RPC transport config.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CHAIN_MAP: Record<number, any> = {
  1: mainnet,
  42161: arbitrum,
  10: optimism,
  8453: base,
};

/** Well-known Uniswap V3 addresses (same on all canonical chains via CREATE2) */
const UNISWAP_V3_ADDRESSES = {
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Address,
  positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab5B0983" as Address,
  router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address,
};

/** LP Helper deployment addresses per chain */
const LP_HELPER_ADDRESSES: Record<number, Address> = {
  42161: "0x8b320a9bb7e900cc2af9fd251482d137d402b6b6",
};

const VALID_FEE_TIERS = [100, 500, 3000, 10000] as const;

const FEE_TIER_TO_TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

// ---------------------------------------------------------------------------
// Tick math helpers (compile-time only — matches UniswapV3LPHelper.sol)
// ---------------------------------------------------------------------------

/**
 * Convert BPS half-width to a tick offset, aligned to the pool's tick spacing.
 * Mirrors the Taylor expansion in UniswapV3LPHelper._bpsToTicks().
 */
function bpsToTicks(halfBps: number): number {
  // ln(1 + x) ≈ x - x²/2 + x³/3 for small x
  const x = halfBps / 10_000;
  const lnApprox = x - (x * x) / 2 + (x * x * x) / 3;
  // Each tick = ln(1.0001) ≈ 0.00009999500033
  return Math.floor(lnApprox / Math.log(1.0001));
}

function alignTickDown(tick: number, tickSpacing: number): number {
  if (tick < 0 && tick % tickSpacing !== 0) {
    return tick - (tickSpacing + (tick % tickSpacing));
  }
  return tick - (tick % tickSpacing);
}

function alignTickUp(tick: number, tickSpacing: number): number {
  if (tick > 0 && tick % tickSpacing !== 0) {
    return tick + tickSpacing - (tick % tickSpacing);
  }
  return tick - (tick % tickSpacing);
}

/**
 * Compute tick range centered on currentTick, aligned to tickSpacing.
 * Fallback used when the LP helper contract is not deployed on the target chain.
 */
function calculateRangeTicksLocal(
  currentTick: number,
  rangeWidthBps: number,
  tickSpacing: number,
): { tickLower: number; tickUpper: number } {
  const halfBps = Math.floor(rangeWidthBps / 2);
  const delta = bpsToTicks(halfBps);

  // Align delta to tick spacing (round down to ensure range is within spec)
  const alignedDelta = Math.floor(delta / tickSpacing) * tickSpacing;
  const effectiveDelta = Math.max(alignedDelta, tickSpacing); // at least one spacing

  const center = alignTickDown(currentTick, tickSpacing);
  const rawLower = center - effectiveDelta;
  const rawUpper = center + effectiveDelta + tickSpacing;

  // Clamp to Uniswap V3 global tick bounds
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  const tickLower = Math.max(alignTickDown(rawLower, tickSpacing), alignTickDown(MIN_TICK, tickSpacing));
  const tickUpper = Math.min(alignTickUp(rawUpper, tickSpacing), alignTickUp(MAX_TICK, tickSpacing));

  return { tickLower, tickUpper };
}

// ---------------------------------------------------------------------------
// Uniswap V3 LiquidityAmounts math (for position value estimation)
// ---------------------------------------------------------------------------

const Q96 = 2n ** 96n;

function getSqrtRatioAtTick(tick: number): bigint {
  // Use the exact formula: sqrtRatio = sqrt(1.0001^tick) * 2^96
  // For compile-time estimation, floating-point is acceptable
  const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
  // Multiply by 2^96 using BigInt conversion
  // Split into integer and fractional parts for better precision
  const scaleFactor = Number(Q96);
  return BigInt(Math.round(sqrtPrice * scaleFactor));
}

function getAmount0ForLiquidity(
  sqrtRatioA: bigint,
  sqrtRatioB: bigint,
  liquidity: bigint,
): bigint {
  const [lower, upper] = sqrtRatioA < sqrtRatioB
    ? [sqrtRatioA, sqrtRatioB]
    : [sqrtRatioB, sqrtRatioA];
  if (lower === 0n) return 0n;
  return (liquidity * Q96 * (upper - lower)) / upper / lower;
}

function getAmount1ForLiquidity(
  sqrtRatioA: bigint,
  sqrtRatioB: bigint,
  liquidity: bigint,
): bigint {
  const [lower, upper] = sqrtRatioA < sqrtRatioB
    ? [sqrtRatioA, sqrtRatioB]
    : [sqrtRatioB, sqrtRatioA];
  return (liquidity * (upper - lower)) / Q96;
}

/**
 * Estimate token amounts for a given liquidity and tick range.
 * Used to estimate what decreaseLiquidity will free at execution time.
 */
function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtRatioA = getSqrtRatioAtTick(tickLower);
  const sqrtRatioB = getSqrtRatioAtTick(tickUpper);

  if (sqrtPriceX96 <= sqrtRatioA) {
    return {
      amount0: getAmount0ForLiquidity(sqrtRatioA, sqrtRatioB, liquidity),
      amount1: 0n,
    };
  }
  if (sqrtPriceX96 >= sqrtRatioB) {
    return {
      amount0: 0n,
      amount1: getAmount1ForLiquidity(sqrtRatioA, sqrtRatioB, liquidity),
    };
  }
  return {
    amount0: getAmount0ForLiquidity(sqrtPriceX96, sqrtRatioB, liquidity),
    amount1: getAmount1ForLiquidity(sqrtRatioA, sqrtPriceX96, liquidity),
  };
}

// ---------------------------------------------------------------------------
// Position resolution
// ---------------------------------------------------------------------------

interface PositionInfo {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

/**
 * Find the first active LP position matching the (token0, token1, fee) pool.
 * Scans the owner's NFT positions via the NonfungiblePositionManager.
 */
async function findExistingPosition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  owner: Address,
  token0: Address,
  token1: Address,
  feeTier: number,
): Promise<PositionInfo | undefined> {
  const positionManager = UNISWAP_V3_ADDRESSES.positionManager;

  let balance: bigint;
  try {
    balance = await client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
  } catch {
    return undefined;
  }

  const count = Number(balance);
  for (let i = 0; i < count; i++) {
    const tokenId = await client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, BigInt(i)],
    });

    const pos = await client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: "positions",
      args: [tokenId],
    });

    const posToken0 = getAddress(pos[2]);
    const posToken1 = getAddress(pos[3]);
    const posFee = Number(pos[4]);
    const posLiquidity = pos[7] as bigint;

    if (
      posToken0.toLowerCase() === token0.toLowerCase() &&
      posToken1.toLowerCase() === token1.toLowerCase() &&
      posFee === feeTier &&
      posLiquidity > 0n
    ) {
      return {
        tokenId,
        token0: posToken0,
        token1: posToken1,
        fee: posFee,
        tickLower: Number(pos[5]),
        tickUpper: Number(pos[6]),
        liquidity: posLiquidity,
        tokensOwed0: pos[10] as bigint,
        tokensOwed1: pos[11] as bigint,
      };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a uniswap-v3-lp:rebalance strategy into a Weiroll script.
 *
 * Resolves $pool and $tokenId via RPC, pre-computes the tick range and
 * optimal amounts, then builds a flat operation sequence for compileScript.
 *
 * @param params - User-provided strategy parameters
 * @param owner - The user's address (position owner)
 * @param chainId - Target chain ID
 * @param rpcUrl - RPC URL for on-chain data fetching (required)
 * @param prependOps - Optional operations to prepend (from compose mode)
 * @param deps - Injected dependencies (compileScript, resolveToken)
 */
export async function compileRebalance(
  params: Record<string, string>,
  owner: Address,
  chainId: number,
  rpcUrl?: string,
  prependOps?: Operation[],
  deps?: {
    compileScript: CompileScriptFn;
    resolveToken: ResolveTokenFn;
  },
): Promise<StrategyCompilationResult> {
  // ── Validate params ─────────────────────────────────────────────────
  if (!params["token0"]) throw new Error("Missing required parameter: token0");
  if (!params["token1"]) throw new Error("Missing required parameter: token1");
  if (!params["feeTier"]) throw new Error("Missing required parameter: feeTier");
  if (!params["rangeWidthBps"]) throw new Error("Missing required parameter: rangeWidthBps");
  if (!rpcUrl) {
    throw new Error("RPC URL is required for uniswap-v3-lp:rebalance compilation");
  }

  const feeTier = parseInt(params["feeTier"], 10);
  if (!VALID_FEE_TIERS.includes(feeTier as (typeof VALID_FEE_TIERS)[number])) {
    throw new Error(
      `Invalid feeTier: ${params["feeTier"]}. Must be one of: ${VALID_FEE_TIERS.join(", ")}`,
    );
  }

  const rangeWidthBps = parseInt(params["rangeWidthBps"], 10);
  if (rangeWidthBps < 1 || rangeWidthBps > 20000) {
    throw new Error(
      `Invalid rangeWidthBps: ${params["rangeWidthBps"]}. Must be between 1 and 20000`,
    );
  }

  const tickSpacing = FEE_TIER_TO_TICK_SPACING[feeTier]!;

  // ── Resolve token addresses ─────────────────────────────────────────
  const resolveToken = deps?.resolveToken;
  let token0Address: Address;
  let token1Address: Address;
  let token0Decimals: number;
  let token1Decimals: number;
  let token0Symbol: string;
  let token1Symbol: string;

  if (resolveToken) {
    const t0 = resolveToken(params["token0"], chainId);
    const t1 = resolveToken(params["token1"], chainId);
    if (!t0) throw new Error(`Unknown token: ${params["token0"]}`);
    if (!t1) throw new Error(`Unknown token: ${params["token1"]}`);
    token0Address = getAddress(t0.address);
    token1Address = getAddress(t1.address);
    token0Decimals = t0.decimals;
    token1Decimals = t1.decimals;
    token0Symbol = t0.symbol;
    token1Symbol = t1.symbol;
  } else {
    // Fallback: accept addresses directly, fetch decimals from chain
    token0Address = getAddress(params["token0"]);
    token1Address = getAddress(params["token1"]);
    token0Symbol = params["token0"];
    token1Symbol = params["token1"];
    // Will fetch decimals below after creating client
    token0Decimals = 18;
    token1Decimals = 18;
  }

  // Enforce Uniswap V3 token ordering: token0 < token1
  if (token0Address.toLowerCase() > token1Address.toLowerCase()) {
    throw new Error(
      `token0 address must be lower than token1 address (Uniswap V3 convention). ` +
      `Got token0=${token0Address}, token1=${token1Address}`,
    );
  }

  // ── Create RPC client ───────────────────────────────────────────────
  const chain = CHAIN_MAP[chainId];
  if (!chain) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported: ${Object.keys(CHAIN_MAP).join(", ")}`);
  }
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  // Fetch decimals if not resolved from registry
  if (!resolveToken) {
    const [d0, d1] = await Promise.all([
      client.readContract({ address: token0Address, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({ address: token1Address, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    token0Decimals = d0;
    token1Decimals = d1;
  }

  // ── Resolve pool address ────────────────────────────────────────────
  const pool = await client.readContract({
    address: UNISWAP_V3_ADDRESSES.factory,
    abi: FACTORY_ABI,
    functionName: "getPool",
    args: [token0Address, token1Address, feeTier],
  });
  if (!pool || pool === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `No Uniswap V3 pool found for ${token0Symbol}/${token1Symbol} with fee ${feeTier}`,
    );
  }

  console.log(`[rebalance] Pool: ${pool} (${token0Symbol}/${token1Symbol} ${feeTier / 10000}%)`);

  // ── Resolve existing position ───────────────────────────────────────
  const position = await findExistingPosition(
    client, owner, token0Address, token1Address, feeTier,
  );
  const isRebalance = position !== undefined;

  if (isRebalance) {
    console.log(
      `[rebalance] Found position #${position.tokenId} ` +
      `(liquidity=${position.liquidity}, ticks=${position.tickLower}..${position.tickUpper})`,
    );
  } else {
    console.log(`[rebalance] No existing position found — creating new LP position`);
  }

  // ── Pre-compute tick range ──────────────────────────────────────────
  let tickLower: number;
  let tickUpper: number;

  const lpHelper = LP_HELPER_ADDRESSES[chainId];
  if (lpHelper) {
    // Use on-chain LP helper for exact tick range
    const [tl, tu] = await client.readContract({
      address: lpHelper,
      abi: LP_HELPER_ABI,
      functionName: "calculateRangeTicks",
      args: [pool, rangeWidthBps],
    });
    tickLower = tl;
    tickUpper = tu;
  } else {
    // Fallback: compute locally
    const slot0 = await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "slot0",
    });
    const currentTick = Number(slot0[1]);
    const range = calculateRangeTicksLocal(currentTick, rangeWidthBps, tickSpacing);
    tickLower = range.tickLower;
    tickUpper = range.tickUpper;
  }

  console.log(`[rebalance] New tick range: ${tickLower} to ${tickUpper}`);

  // ── Estimate post-collect balances ──────────────────────────────────
  // Read current wallet balances
  const [walletBal0, walletBal1] = await Promise.all([
    client.readContract({ address: token0Address, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: token1Address, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
  ]);

  let estimatedTotal0 = walletBal0;
  let estimatedTotal1 = walletBal1;

  if (isRebalance) {
    // Estimate tokens freed by decreaseLiquidity using LiquidityAmounts math
    const slot0 = await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "slot0",
    });
    const sqrtPriceX96 = slot0[0];

    const freed = getAmountsForLiquidity(
      sqrtPriceX96,
      position.tickLower,
      position.tickUpper,
      position.liquidity,
    );

    // Add freed tokens + accrued fees to wallet balances
    estimatedTotal0 = walletBal0 + freed.amount0 + (position.tokensOwed0 ?? 0n);
    estimatedTotal1 = walletBal1 + freed.amount1 + (position.tokensOwed1 ?? 0n);

    console.log(
      `[rebalance] Estimated post-collect: ` +
      `${formatUnits(estimatedTotal0, token0Decimals)} ${token0Symbol}, ` +
      `${formatUnits(estimatedTotal1, token1Decimals)} ${token1Symbol}`,
    );
  }

  // ── Determine swap direction ────────────────────────────────────────
  let swapNeeded = false;
  let swapTokenIn = "";
  let swapTokenOut = "";
  let swapAmount = "";

  if (estimatedTotal0 > 0n || estimatedTotal1 > 0n) {
    // Use LP helper or local math to compute optimal amounts
    let optAmount0: bigint;
    let optAmount1: bigint;

    if (lpHelper) {
      const [a0, a1] = await client.readContract({
        address: lpHelper,
        abi: LP_HELPER_ABI,
        functionName: "computeOptimalAmounts",
        args: [pool, tickLower, tickUpper, estimatedTotal0, estimatedTotal1],
      });
      optAmount0 = a0;
      optAmount1 = a1;
    } else {
      // Rough estimation: use the tick range ratio
      // For a centered range, roughly 50/50 split
      optAmount0 = estimatedTotal0 / 2n;
      optAmount1 = estimatedTotal1 / 2n;
    }

    const surplus0 = estimatedTotal0 > optAmount0 ? estimatedTotal0 - optAmount0 : 0n;
    const surplus1 = estimatedTotal1 > optAmount1 ? estimatedTotal1 - optAmount1 : 0n;

    // Only swap if there's a meaningful surplus on one side and deficit on the other
    const MIN_SWAP_THRESHOLD = 100n; // Minimum swap to avoid dust swaps
    if (surplus0 > MIN_SWAP_THRESHOLD && surplus1 === 0n) {
      swapNeeded = true;
      swapTokenIn = token0Symbol;
      swapTokenOut = token1Symbol;
      swapAmount = formatUnits(surplus0, token0Decimals);
    } else if (surplus1 > MIN_SWAP_THRESHOLD && surplus0 === 0n) {
      swapNeeded = true;
      swapTokenIn = token1Symbol;
      swapTokenOut = token0Symbol;
      swapAmount = formatUnits(surplus1, token1Decimals);
    }
  }

  // ── Build operations ────────────────────────────────────────────────
  const operations: Operation[] = [];
  const stepDescriptions: string[] = [];

  if (prependOps?.length) {
    operations.push(...prependOps);
  }

  // Steps 0-1: Exit existing position (rebalance only)
  if (isRebalance) {
    operations.push({
      type: "custom",
      _actionId: "uniswap-v3-lp:decrease-liquidity",
      args: {
        tokenId: position.tokenId.toString(),
        liquidity: "MAX",
        amount0Min: "0",
        amount1Min: "0",
      },
    });
    stepDescriptions.push(
      `Remove all liquidity from position #${position.tokenId}`,
    );

    operations.push({
      type: "custom",
      _actionId: "uniswap-v3-lp:collect-fees",
      args: {
        tokenId: position.tokenId.toString(),
        recipient: owner,
        amount0Max: maxUint128.toString(),
        amount1Max: maxUint128.toString(),
      },
    });
    stepDescriptions.push(
      `Collect all tokens and fees from position #${position.tokenId}`,
    );
  }

  // Step 2: Swap surplus to achieve optimal ratio (if needed)
  if (swapNeeded) {
    operations.push({
      type: "swap",
      tokenIn: swapTokenIn,
      tokenOut: swapTokenOut,
      amount: swapAmount,
      fee: feeTier,
      slippageBps: 100, // 1% slippage tolerance
      swapProvider: "uniswap-v3",
    });
    stepDescriptions.push(
      `Swap ${swapAmount} ${swapTokenIn} → ${swapTokenOut} for optimal ratio`,
    );
  }

  // Step 3: Mint new position with BALANCE (adapts to actual balances at execution time)
  operations.push({
    type: "custom",
    _actionId: "uniswap-v3-lp:mint-position",
    args: {
      token0: token0Address,
      token1: token1Address,
      fee: feeTier.toString(),
      tickLower: tickLower.toString(),
      tickUpper: tickUpper.toString(),
      amount0Desired: "BALANCE",
      amount1Desired: "BALANCE",
      amount0Min: "0",
      amount1Min: "0",
      recipient: owner,
    },
  });
  stepDescriptions.push(
    `Mint ${token0Symbol}/${token1Symbol} LP position (ticks: ${tickLower} to ${tickUpper})`,
  );

  // ── Compile operations ──────────────────────────────────────────────
  const compileScript = deps?.compileScript;
  if (!compileScript) {
    throw new Error(
      "compileScript dependency is required. When integrating into the main repo, " +
      "import from '../../tools/compile-script' and pass via deps.",
    );
  }

  const result = compileScript({
    operations,
    chainId,
    owner,
  });

  return {
    commands: result.commands,
    state: result.state,
    stepDescriptions,
    description: isRebalance
      ? `Rebalance ${token0Symbol}/${token1Symbol} ${feeTier / 10000}% LP (position #${position.tokenId}) — ` +
        stepDescriptions.join(" → ")
      : `Create ${token0Symbol}/${token1Symbol} ${feeTier / 10000}% LP position — ` +
        stepDescriptions.join(" → "),
    ...(result.quoteCommands?.length
      ? {
          quoteCommands: result.quoteCommands,
          quoteState: result.quoteState,
          patchSlots: result.patchSlots,
        }
      : {}),
  };
}
