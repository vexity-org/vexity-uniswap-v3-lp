# Vexity Uniswap V3 LP Plugin

A [Vexity](https://vexity.io) community plugin for Uniswap V3 concentrated liquidity position management.

Built from the [vexity-org/plugin-template](https://github.com/vexity-org/plugin-template).

## Features

- **Rebalance Strategy**: Automatically closes an out-of-range LP position and opens a new one centered on the current tick
- **Initial Mint**: Creates a new LP position if the user has no existing position for the pair
- **Parameter Validation**: preCompile hook validates range width, fee tier, and drift buffer before compilation
- **PluginCompiler**: Fully sandboxed compiler conforming to the `PluginCompiler` interface

## Plugin Structure

```
├── plugin.json                          # Plugin manifest (compilers, hooks, dependencies)
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
├── compilers/
│   └── rebalance.ts                     # PluginCompiler implementation (sandboxed)
├── hooks/
│   └── pre-compile.ts                   # PreCompileHook for param validation
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

## Compiler Architecture

The rebalance compiler conforms to the `PluginCompiler` interface and uses only `PluginCompilerContext` APIs:

- `ctx.rpc.call()` for on-chain queries (pool state, position lookup)
- `ctx.abis.encodeFunctionData()` / `decodeFunctionResult()` for ABI encoding
- `ctx.contracts.getAddress()` for resolving protocol contract addresses
- `ctx.weiroll.compile()` for converting high-level operations to Weiroll bytecode
- `ctx.log` for scoped logging

No raw Node.js APIs (`require`, `import`, `fs`, `process`) are used — compilers run in a sandboxed context.

### Compilation Flow

1. Resolve token addresses and ensure correct sort order (token0 < token1)
2. Query pool for current tick via `ctx.rpc.call()`
3. Calculate new tickLower/tickUpper from rangeWidthBps
4. Find user's existing position (if any)
5. Build operations: decreaseLiquidity → collect → approve × 2 → mint
6. Compile via `ctx.weiroll.compile()`

### Parameter Validation (preCompile Hook)

The preCompile hook validates parameters before compilation:

- `rangeWidthBps`: must be between 1 and 20000 (0.01% to 200%)
- `feeTier`: must be one of 100, 500, 3000, 10000
- `driftBufferBps`: if provided, must be positive and less than rangeWidthBps
- `token0` / `token1`: must be non-empty and different

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
# e.g. /path/to/plugins/uniswap-v3-lp/plugin.json
```

### Via vexity.plugins.json

```json
{
  "localDirs": ["plugins"]
}
```

## Dependencies

This plugin depends on the core `uniswap-v3` protocol plugin for:
- Contract ABIs (`pool`, `position-manager`, `factory`)
- Deployment addresses (position manager, factory, router per chain)

## Deployment Status

| Chain | LP Helper | Status |
|-------|-----------|--------|
| Arbitrum | `0x000...000` | Placeholder — deploy needed |
| Sepolia | `0x000...000` | Placeholder — deploy needed |

Uniswap V3 core contracts (Factory, PositionManager, SwapRouter) are included in deployments for reference.

## Creating New Plugins From This Template

1. Copy this repository as a starting point
2. Update `plugin.json` with your plugin ID, name, and capabilities
3. Add your strategy descriptors to `strategies/`
4. Implement your compiler in `compilers/` using only `PluginCompilerContext` APIs
5. Add parameter validation in `hooks/` via `PreCompileHook`
6. Test with `VEXITY_PLUGIN_DIRS` pointing at your plugin directory

### Key Constraints

- **No raw Node.js APIs**: Compilers run in a sandboxed context. No `require()`, `import()`, `eval()`, `process`, `fs`, etc.
- **Trust tiers**: Only `core`, `verified`, and `dev` plugins can load TS compilers/hooks. Community (npm) plugins are limited to JSON declarative hooks.
- **Static analysis**: Source is scanned for unsafe patterns before loading.
- **Context-only I/O**: All RPC calls, ABI encoding, and contract resolution go through the context object.

## License

MIT
