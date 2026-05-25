---
name: uniswap-v3-lp
description: "Uniswap V3 LP position management — fee harvesting, close, rebalance, auto-compound, out-of-range detection"
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

### Strategy: Auto-Rebalance

The `uniswap-v3-lp:rebalance` strategy automates position management. It monitors positions for price drift and triggers rebalancing when the position goes out of range. Parameters:
- **token0 / token1**: The LP pair tokens
- **feeTier**: Pool fee tier
- **rangeWidthBps**: Total range width for the new position
- **driftBufferBps** (optional): How far price must drift beyond range before triggering rebalance

The strategy uses a PluginCompiler (`compilers/rebalance.ts`) that dynamically queries on-chain state and builds Weiroll bytecode for atomic execution.
