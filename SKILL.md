---
name: uniswap-v3-lp
description: "Uniswap V3 LP position management - fee harvesting, close, rebalance, auto-compound, out-of-range detection"
triggers:
  - uniswap lp
  - liquidity position
  - fee harvest
  - collect fees
  - rebalance
  - auto-compound
  - impermanent loss
  - out of range
  - position close
  - lp management
---

## Uniswap V3 LP Management

This skill manages Uniswap V3 concentrated liquidity positions. It provides actions for the full lifecycle of an LP position: minting, fee collection, adding/removing liquidity, rebalancing, and auto-compounding.

### Core Concepts

- **Concentrated Liquidity**: Uniswap V3 LP positions provide liquidity within a specific price range defined by tick boundaries (tickLower, tickUpper). Positions only earn fees when the pool's current price is within range.
- **Position NFTs**: Each LP position is represented as an ERC-721 NFT managed by the NonfungiblePositionManager contract. The `tokenId` is the unique identifier for any position operation.
- **Tick Spacing**: Valid tick boundaries must be aligned to the pool's tick spacing (1 for 0.01% pools, 10 for 0.05%, 60 for 0.3%, 200 for 1%).
- **Range Width (BPS)**: rangeBps represents the half-width of a position range in basis points. A rangeBps of 500 means ±5% from current price.

### Available Actions

#### Position Lifecycle

1. **mint-position** — Create a new LP position with a specified price range. Requires token0, token1, fee tier, tick range, and desired amounts. Returns the new position's tokenId.

2. **increase-liquidity** — Add more liquidity to an existing position. The tick range stays the same; you provide additional token amounts. Useful for compounding or adding capital.

3. **decrease-liquidity** — Remove some or all liquidity from a position. Set liquidity to MAX to remove everything. Returns the token amounts freed (must call collect-fees afterward to actually receive them).

4. **collect-fees** — Collect accrued trading fees and/or freed liquidity tokens. Set amount0Max and amount1Max to MAX to collect everything. This is the only way to withdraw tokens from a position.

#### Range Analysis

5. **calculate-range** — Compute tick-spacing-aligned tick bounds centered on the pool's current price. Input a rangeBps value to define the width. Always use this before minting to ensure valid tick alignment.

6. **check-rebalance** — Check if an LP position has drifted out of its active range. Returns true if the current pool price is outside the position's ticks (with optional buffer). Use as a condition guard before rebalancing.

7. **compute-optimal-amounts** — Given a tick range and available token balances, calculate the maximum-liquidity token split. Handles three cases: price below range (token0 only), price in range (both tokens), price above range (token1 only).

#### Composite Workflows

8. **rebalance-lp-position** — Full rebalance workflow as a Weiroll script: remove liquidity → collect tokens → calculate new range → compute optimal amounts → swap surplus → mint new position. This is the primary automation action.

### Action Composition Patterns

#### Collect All Fees
```
collect-fees(tokenId, recipient=OWNER, amount0Max=MAX, amount1Max=MAX)
```

#### Close a Position Entirely
```
1. decrease-liquidity(tokenId, liquidity=MAX)
2. collect-fees(tokenId, recipient=OWNER, amount0Max=MAX, amount1Max=MAX)
```

#### Rebalance Out-of-Range Position
```
1. check-rebalance(positionManager, tokenId, bufferBps=100)  → condition guard
2. rebalance-lp-position(tokenId, rangeBps=500, slippageBps=100)
```

#### Auto-Compound Fees
```
1. collect-fees(tokenId, recipient=OWNER)
2. compute-optimal-amounts(pool, tickLower, tickUpper, collectedAmount0, collectedAmount1)
3. increase-liquidity(tokenId, amount0Desired, amount1Desired)
```

#### New Position from Scratch
```
1. calculate-range(pool, rangeBps=500)
2. compute-optimal-amounts(pool, tickLower, tickUpper, balance0, balance1)
3. mint-position(token0, token1, fee, tickLower, tickUpper, amount0, amount1)
```

### Parameter Selection Rules

- **tokenId**: Always required for existing position operations. This is the NFT ID, not a token address.
- **rangeBps**: Half-width in BPS. Common values: 100 (±1%, tight), 500 (±5%, moderate), 1000 (±10%, wide). Tighter ranges earn more fees but go out of range faster.
- **slippageBps**: For swaps during rebalance. Use 50-100 for stable pairs, 100-300 for volatile pairs.
- **recipient**: Use "OWNER" to send to the position owner (default behavior).
- **amount0Max / amount1Max**: Use "MAX" (uint128 max) to collect all available fees.
- **liquidity**: Use "MAX" to remove all liquidity. Otherwise specify the exact uint128 amount.
- **fee**: Pool fee tier in BPS — must be exactly 100, 500, 3000, or 10000.

### Edge Cases and Warnings

- **Out-of-range positions** earn zero fees. Always check with `check-rebalance` before deciding to rebalance.
- **Decreasing liquidity does NOT transfer tokens** — you must follow up with `collect-fees` to actually receive tokens.
- **Token ordering matters**: token0 must have a lower address than token1 (standard Uniswap sort order).
- **Zero liquidity positions**: After removing all liquidity and collecting, the NFT still exists but represents an empty position. It can be reused with `increase-liquidity`.
- **Tick alignment**: Always use `calculate-range` to get properly aligned ticks. Unaligned ticks will cause the mint/increaseLiquidity call to revert.
- **Deadline parameter**: Transaction deadline is handled automatically by the builder — do not expose to users.

### Supported Chains

| Chain | Chain ID | Position Manager |
|-------|----------|-----------------|
| Ethereum | 1 | 0xC36442b4a4522E871399CD717aBDD847Ab5B0983 |
| Arbitrum | 42161 | 0xC36442B4A4522E871399cd717ABDd847ab5B0983 |

### Tick Math & Range Calculation

The agent's deterministic tools handle bytecode compilation, but the agent needs this knowledge to correctly parameterize LP operations.

#### Fee Tier → Tick Spacing Mapping

| Fee Tier | Fee (%) | Tick Spacing |
|----------|---------|--------------|
| 100      | 0.01%   | 1            |
| 500      | 0.05%   | 10           |
| 3000     | 0.30%   | 60           |
| 10000    | 1.00%   | 200          |

#### Converting Range Width (BPS) to Tick Delta

`rangeWidthBps` is the **total** range width. To compute tick bounds:

1. Compute half-range: `halfBps = rangeWidthBps / 2`
2. Convert to tick delta: `tickDelta = ln(1 + halfBps / 10000) / ln(1.0001)`
3. Round down to nearest tick spacing: `aligned = max(tickSpacing, floor(tickDelta / tickSpacing) * tickSpacing)`
4. Compute bounds: `tickLower = alignedCenter - aligned`, `tickUpper = alignedCenter + aligned`

Where `alignedCenter = round(currentTick / tickSpacing) * tickSpacing`.

**Example**: For rangeWidthBps=1000 (±5%), fee tier 3000 (tickSpacing=60):
- halfBps = 500
- tickDelta = ln(1.05) / ln(1.0001) ≈ 487.9
- aligned = floor(487.9 / 60) * 60 = 480
- Range: [currentTick - 480, currentTick + 480]

#### Querying Current Tick (slot0)

To get the current pool price/tick:
1. Resolve pool address via Factory: `factory.getPool(token0, token1, fee)` — returns zero address if pool doesn't exist
2. Query pool's `slot0()` — returns `(sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, feeProtocol, unlocked)`
3. The `tick` (index 1) is the current tick used for range centering

**sqrtPriceX96**: The pool price encoded as `sqrt(price) * 2^96`. To get the human-readable price: `price = (sqrtPriceX96 / 2^96)^2`. This is the ratio of token1/token0 in their raw decimal units.

#### Position Resolution

To find a user's existing position for a token pair + fee:
1. Query `positionManager.balanceOf(owner)` to get NFT count
2. Iterate with `tokenOfOwnerByIndex(owner, i)` to get each tokenId
3. Query `positions(tokenId)` → returns `(nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, ...)`
4. Match on token0 + token1 + fee; prefer the position with most liquidity

### Parameter Validation Rules

When composing rebalance strategies, validate these constraints:

- **token0 / token1**: Must be non-empty, must be different tokens, token0 address must be less than token1 (standard sort order)
- **feeTier**: Must be exactly one of: 100, 500, 3000, 10000
- **rangeWidthBps**: Must be between 1 and 20000 (0.01% to 200% total range)
- **driftBufferBps** (optional): Must be positive and strictly less than rangeWidthBps

### Strategy: Auto-Rebalance

The `uniswap-v3-lp:rebalance` strategy automates position management. It monitors positions for price drift and triggers rebalancing when the position goes out of range. Parameters:
- **token0 / token1**: The LP pair tokens
- **feeTier**: Pool fee tier (100, 500, 3000, or 10000)
- **rangeWidthBps**: Total range width for the new position (1–20000)
- **driftBufferBps** (optional): How far price must drift beyond range before triggering rebalance

#### Rebalance Composition Flow

The agent composes a rebalance using deterministic tools (`encode-function`, `compile-script`, `build-condition`) following this sequence:

1. **Query on-chain state**: Use `encode-function` to call `slot0()` on the pool, extract current tick
2. **Calculate new tick bounds**: Apply the tick math above to derive tickLower/tickUpper from rangeWidthBps
3. **Find existing position**: Enumerate user's position NFTs, match on pair + fee
4. **Build operations** (if existing position):
   - `decreaseLiquidity(tokenId, liquidity=MAX, amount0Min=0, amount1Min=0, deadline)`
   - `collect(tokenId, recipient=OWNER, amount0Max=MAX_UINT128, amount1Max=MAX_UINT128)`
5. **Approve tokens**: Approve token0 and token1 for the NonfungiblePositionManager
6. **Mint new position**: `mint(token0, token1, fee, tickLower, tickUpper, amount0Desired=BALANCE, amount1Desired=BALANCE, amount0Min=0, amount1Min=0, recipient=OWNER, deadline)`
7. **Compile**: Use `compile-script` to produce Weiroll bytecode from the operation sequence
