# Vexity Uniswap V3 LP Plugin

A [Vexity](https://vexity.io) community plugin for Uniswap V3 concentrated liquidity position management.

Built from the [vexity-org/plugin-template](https://github.com/vexity-org/plugin-template).

## Features

- **Calculate Range Ticks** — Compute tick-spacing-aligned LP ranges centered on current price
- **Check Rebalance** — Detect when an LP position has drifted out of range
- **Compute Optimal Amounts** — Calculate maximum-liquidity token amounts for a tick range
- **Auto-Rebalance Strategy** — Full automated LP rebalancing with fee compounding

## Plugin Structure

```
├── plugin.json                          # Plugin manifest
├── abis/lp-helper.json                  # UniswapV3LPHelper ABI descriptor
├── actions/
│   ├── calculate-range.json             # Compute aligned tick range
│   ├── check-rebalance.json             # Condition: is position out of range?
│   ├── compute-optimal-amounts.json     # Optimal token split for a range
│   └── rebalance-lp-position.json       # Composite Weiroll rebalance flow
├── deployments/
│   ├── arbitrum.json                    # Arbitrum One contract addresses
│   └── sepolia.json                     # Sepolia testnet addresses
├── strategies/
│   └── rebalance.json                   # Auto-rebalance strategy template
└── contracts/
    ├── src/UniswapV3LPHelper.sol        # Weiroll-compatible helper contract
    ├── src/interfaces/IUniswapV3Pool.sol
    └── test/UniswapV3LPHelper.t.sol     # 16 fork tests against live Arbitrum pools
```

## Smart Contract

The `UniswapV3LPHelper` is a stateless, Weiroll-compatible helper contract with three view functions:

| Function | Description |
|----------|-------------|
| `calculateRangeTicks(pool, rangeBps)` | Compute tick-spacing-aligned range centered on current price |
| `shouldRebalance(positionManager, tokenId, bufferBps)` | Check if position needs rebalancing |
| `computeOptimalAmounts(pool, tickLower, tickUpper, amount0, amount1)` | Calculate optimal mint amounts |

All functions are `view` with ≤5 parameters for direct Weiroll compatibility. Deploy once per chain — works with any pool or position.

### Building & Testing

```bash
cd contracts
forge install
forge build
forge test --fork-url https://arb1.arbitrum.io/rpc
```

## Installation

1. Enable **Dev Mode** in Vexity Settings > Developer
2. Click **"+"** in the Capabilities grid
3. Enter `https://github.com/vexity-org/vexity-uniswap-v3-lp`
4. Accept the community plugin notice

## Deployment Status

| Chain | LP Helper | Status |
|-------|-----------|--------|
| Arbitrum | `0x000...000` | Placeholder — deploy needed |
| Sepolia | `0x000...000` | Placeholder — deploy needed |

Uniswap V3 core contracts (Factory, PositionManager, SwapRouter) are included in deployments for reference.

## License

MIT
