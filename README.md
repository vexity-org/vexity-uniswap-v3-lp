# Vexity Uniswap V3 LP Plugin

A [Vexity](https://vexity.io) community plugin for Uniswap V3 concentrated liquidity position management.

Built from the [vexity-org/plugin-template](https://github.com/vexity-org/plugin-template).

## Features

- **Rebalance Strategy**: Automatically closes an out-of-range LP position and opens a new one centered on the current tick
- **Initial Mint**: Creates a new LP position if the user has no existing position for the pair
- **Parameter Validation**: Action JSON descriptors include constraint metadata for the agent to validate inputs
- **SKILL-based Composition**: The agent uses `SKILL.md` procedural knowledge and deterministic tools (`encode-function`, `compile-script`, `build-condition`) to compose Weiroll bytecode

## Plugin Structure

```
├── protocol.json                        # Plugin manifest
├── SKILL.md                             # Procedural knowledge for the agent
├── abis/
│   ├── lp-helper.json                   # UniswapV3LPHelper ABI descriptor
│   └── position-manager.json            # NonfungiblePositionManager ABI
├── actions/
│   ├── calculate-range.json             # Compute aligned tick range
│   ├── check-rebalance.json             # Condition: is position out of range?
│   ├── collect-fees.json                # Collect accrued fees from position
│   ├── compute-optimal-amounts.json     # Optimal token split for a range
│   ├── decrease-liquidity.json          # Remove liquidity from position
│   ├── increase-liquidity.json          # Add liquidity to position
│   ├── mint-position.json               # Create new LP position
│   └── rebalance-lp-position.json       # Composite Weiroll rebalance flow
├── deployments/
│   ├── arbitrum.json                    # Arbitrum One contract addresses
│   ├── ethereum.json                    # Ethereum mainnet addresses
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

## How It Works

The agent uses `SKILL.md` as procedural knowledge injected into its context when the plugin's actions are relevant. The agent's deterministic tools handle the actual Weiroll bytecode compilation — `SKILL.md` describes HOW to compose actions (which functions to call, in what order, with what parameters).

### Rebalance Flow

1. Resolve token addresses and ensure correct sort order (token0 < token1)
2. Query pool for current tick via `slot0()`
3. Calculate new tickLower/tickUpper from rangeWidthBps using tick math
4. Find user's existing position (if any)
5. Build operations: decreaseLiquidity → collect → approve × 2 → mint
6. Compile via `compile-script` tool

### Strategy Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `token0` | token | yes | First token of the LP pair (e.g. WETH) |
| `token1` | token | yes | Second token of the LP pair (e.g. USDC) |
| `feeTier` | number | yes | Pool fee tier: 100, 500, 3000, or 10000 |
| `rangeWidthBps` | number | yes | Total range width in bps (e.g. 1000 = ±5%) |
| `driftBufferBps` | number | no | Price drift buffer for automation trigger |

### Example Intents

- "Rebalance my WETH/USDC 0.05% LP to a ±5% range"
- "My WBTC/WETH 0.3% LP is out of range, re-center with 20% range"
- "Create a new WETH/USDC LP position centered on current price with ±2% range"

## Installation

1. Enable **Dev Mode** in Vexity Settings > Developer
2. Click **"+"** in the Capabilities grid
3. Enter `https://github.com/vexity-org/vexity-uniswap-v3-lp`
4. Accept the community plugin notice

### Via VEXITY_PLUGIN_DIRS

```bash
# Point the agent at the plugin directory
export VEXITY_PLUGIN_DIRS=/path/to/plugins

# The plugin system discovers plugins in subdirectories of each dir
# e.g. /path/to/plugins/uniswap-v3-lp/protocol.json
```

### Via vexity.plugins.json

```json
{
  "localDirs": ["plugins"]
}
```

## Deployment Status

| Chain | LP Helper | Status |
|-------|-----------|--------|
| Arbitrum | `0x000...000` | Placeholder — deploy needed |
| Sepolia | `0x000...000` | Placeholder — deploy needed |

Uniswap V3 core contracts (Factory, PositionManager, SwapRouter) are included in deployments for reference.

## License

MIT
