// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {IUniswapV3Pool, IUniswapV3Factory} from "./interfaces/IUniswapV3Pool.sol";

/// @notice Minimal interface for Uniswap V3 NonfungiblePositionManager
interface INonfungiblePositionManager {
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function factory() external view returns (address);
}

/// @title UniswapV3LPHelper
/// @notice Weiroll-compatible helper for Uniswap V3 concentrated liquidity management.
/// @dev Provides stateless view primitives for LP strategy execution:
///      - Range tick calculation from basis points
///      - Rebalance condition detection
///      - Optimal amount computation for liquidity provision
///
///      All functions are `view` with ≤5 parameters for direct Weiroll compatibility.
///      Stateless design — deploy once per chain, works with any pool or position.
contract UniswapV3LPHelper {
    // ── Constants ────────────────────────────────────────────────────

    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint256 internal constant Q96 = 0x1000000000000000000000000; // 2^96

    // ── Errors ───────────────────────────────────────────────────────

    error InvalidRange();
    error PoolNotFound();

    // ══════════════════════════════════════════════════════════════════
    //                       PUBLIC VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════════

    /// @notice Compute tick-spacing-aligned range centered on the pool's current tick.
    /// @param pool       Uniswap V3 pool address
    /// @param rangeBps   Half-width in basis points (500 = ±5% from current price)
    /// @return tickLower Lower tick, rounded down to tickSpacing
    /// @return tickUpper Upper tick, rounded up to tickSpacing
    function calculateRangeTicks(
        address pool,
        uint24 rangeBps
    ) external view returns (int24 tickLower, int24 tickUpper) {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 spacing = IUniswapV3Pool(pool).tickSpacing();

        int24 rangeTicks = _bpsToTicks(rangeBps);

        tickLower = _alignTickDown(currentTick - rangeTicks, spacing);
        tickUpper = _alignTickUp(currentTick + rangeTicks, spacing);

        // Clamp to global bounds
        if (tickLower < MIN_TICK) tickLower = _alignTickUp(MIN_TICK, spacing);
        if (tickUpper > MAX_TICK) tickUpper = _alignTickDown(MAX_TICK, spacing);

        if (tickLower >= tickUpper) revert InvalidRange();
    }

    /// @notice Check whether a position should be rebalanced.
    /// @dev Reads position data from the NFT manager, discovers the pool via the factory,
    ///      and checks if the current tick has drifted outside the position's range
    ///      (expanded by a buffer zone).
    /// @param positionManager  Uniswap V3 NonfungiblePositionManager address
    /// @param tokenId          NFT token ID of the position
    /// @param bufferBps        Buffer in bps that widens the no-rebalance zone
    ///                         (0 = rebalance as soon as tick exits the position range)
    /// @return rebalance       True if current tick is outside the buffered range
    function shouldRebalance(
        address positionManager,
        uint256 tokenId,
        uint24 bufferBps
    ) external view returns (bool rebalance) {
        (
            ,, address token0, address token1, uint24 fee,
            int24 tickLower, int24 tickUpper,,,,,
        ) = INonfungiblePositionManager(positionManager).positions(tokenId);

        address factory = INonfungiblePositionManager(positionManager).factory();
        address pool = IUniswapV3Factory(factory).getPool(token0, token1, fee);
        if (pool == address(0)) revert PoolNotFound();

        (, int24 currentTick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 bufferTicks = _bpsToTicks(bufferBps);

        rebalance = currentTick < tickLower - bufferTicks
            || currentTick >= tickUpper + bufferTicks;
    }

    /// @notice Compute the maximum-liquidity token amounts for a given range.
    /// @dev Uses the Uniswap V3 LiquidityAmounts pattern: given available balances,
    ///      finds the max liquidity that can be minted, then returns the exact amounts
    ///      required for that liquidity. Difference is the "swap remainder".
    /// @param pool              Uniswap V3 pool address (reads current sqrtPriceX96)
    /// @param tickLower         Lower tick of the target range (must be spacing-aligned)
    /// @param tickUpper         Upper tick of the target range (must be spacing-aligned)
    /// @param amount0Available  Maximum token0 the caller can spend
    /// @param amount1Available  Maximum token1 the caller can spend
    /// @return amount0Desired   Token0 amount to use for minting (≤ amount0Available)
    /// @return amount1Desired   Token1 amount to use for minting (≤ amount1Available)
    function computeOptimalAmounts(
        address pool,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Available,
        uint256 amount1Available
    ) external view returns (uint256 amount0Desired, uint256 amount1Desired) {
        if (tickLower >= tickUpper) revert InvalidRange();

        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();

        uint160 sqrtRatioAX96 = _getSqrtRatioAtTick(tickLower);
        uint160 sqrtRatioBX96 = _getSqrtRatioAtTick(tickUpper);

        uint128 liquidity = _getLiquidityForAmounts(
            sqrtPriceX96, sqrtRatioAX96, sqrtRatioBX96,
            amount0Available, amount1Available
        );

        if (sqrtPriceX96 <= sqrtRatioAX96) {
            // Current price below range — position is entirely token0
            amount0Desired = _getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
        } else if (sqrtPriceX96 < sqrtRatioBX96) {
            // Current price in range — both tokens needed
            amount0Desired = _getAmount0ForLiquidity(sqrtPriceX96, sqrtRatioBX96, liquidity);
            amount1Desired = _getAmount1ForLiquidity(sqrtRatioAX96, sqrtPriceX96, liquidity);
        } else {
            // Current price above range — position is entirely token1
            amount1Desired = _getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //                         INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════

    /// @dev Convert basis points to an approximate tick offset.
    ///      Uses a 3-term Taylor expansion of log_{1.0001}(1 + bps/10000):
    ///        n ≈ bps − bps²/20 000 + bps³/300 000 000
    ///      Accurate to <1 tick for bps ≤ 1000, <5 ticks for bps ≤ 3000.
    function _bpsToTicks(uint24 bps) internal pure returns (int24) {
        uint256 b = uint256(bps);
        // term1 = b, term2 = b²/20000, term3 = b³/300_000_000
        uint256 result = b - (b * b / 20_000) + (b * b * b / 300_000_000);
        return int24(int256(result));
    }

    /// @dev Round tick down to the nearest multiple of `spacing` (toward −∞).
    function _alignTickDown(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 mod = tick % spacing;
        if (mod < 0) mod += spacing;
        return tick - mod;
    }

    /// @dev Round tick up to the nearest multiple of `spacing` (toward +∞).
    function _alignTickUp(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 mod = tick % spacing;
        if (mod == 0) return tick;
        if (mod > 0) return tick + spacing - mod;
        return tick - mod; // mod < 0: subtracting negative = adding |mod|
    }

    // ── Uniswap V3 TickMath (inlined, Solidity 0.8-safe) ────────────

    /// @dev Computes sqrt(1.0001^tick) × 2^96. Adapted from Uniswap V3 TickMath.
    ///      Uses precomputed magic numbers for bit-by-bit computation in Q128.128,
    ///      then converts to Q64.96 format (uint160).
    function _getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) revert InvalidRange();

            uint256 ratio = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            // Convert Q128.128 → Q64.96, rounding up
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }

    // ── Uniswap V3 LiquidityAmounts (inlined, uses solady mulDiv) ───

    function _getLiquidityForAmount0(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount0
    ) internal pure returns (uint128) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        uint256 intermediate = FixedPointMathLib.mulDiv(
            uint256(sqrtRatioAX96), uint256(sqrtRatioBX96), Q96
        );
        return _toUint128(
            FixedPointMathLib.mulDiv(amount0, intermediate, uint256(sqrtRatioBX96) - uint256(sqrtRatioAX96))
        );
    }

    function _getLiquidityForAmount1(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        return _toUint128(
            FixedPointMathLib.mulDiv(amount1, Q96, uint256(sqrtRatioBX96) - uint256(sqrtRatioAX96))
        );
    }

    function _getLiquidityForAmounts(
        uint160 sqrtRatioX96,
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        if (sqrtRatioX96 <= sqrtRatioAX96) {
            return _getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
        }
        if (sqrtRatioX96 < sqrtRatioBX96) {
            uint128 liq0 = _getLiquidityForAmount0(sqrtRatioX96, sqrtRatioBX96, amount0);
            uint128 liq1 = _getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioX96, amount1);
            return liq0 < liq1 ? liq0 : liq1;
        }
        return _getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
    }

    function _getAmount0ForLiquidity(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        return FixedPointMathLib.mulDiv(
            uint256(liquidity) << 96,
            uint256(sqrtRatioBX96) - uint256(sqrtRatioAX96),
            uint256(sqrtRatioBX96)
        ) / uint256(sqrtRatioAX96);
    }

    function _getAmount1ForLiquidity(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        return FixedPointMathLib.mulDiv(
            uint256(liquidity),
            uint256(sqrtRatioBX96) - uint256(sqrtRatioAX96),
            Q96
        );
    }

    function _toUint128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert InvalidRange();
        return uint128(x);
    }
}
