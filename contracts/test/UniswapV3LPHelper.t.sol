// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {
    UniswapV3LPHelper,
    INonfungiblePositionManager
} from "../src/UniswapV3LPHelper.sol";
import {IUniswapV3Pool, IUniswapV3Factory} from "../src/interfaces/IUniswapV3Pool.sol";

/**
 * @title UniswapV3LPHelperTest
 * @notice Fork tests for UniswapV3LPHelper against live Uniswap V3 pools on Arbitrum.
 *
 *         Tests cover:
 *         - Range tick calculation with various rangeBps and tick spacings
 *         - Rebalance detection (in-range, out-of-range, boundary/buffer cases)
 *         - Optimal amount computation accuracy
 */
contract UniswapV3LPHelperTest is Test {
    // ── Arbitrum One addresses ───────────────────────────────────────
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address constant NFT_POSITION_MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;

    UniswapV3LPHelper helper;
    address wethUsdcPool005; // 0.05% fee tier, tickSpacing = 10
    address wethUsdcPool030; // 0.30% fee tier, tickSpacing = 60

    function setUp() public {
        vm.createSelectFork(vm.envOr("ARBITRUM_RPC_URL", string("https://arb1.arbitrum.io/rpc")));

        helper = new UniswapV3LPHelper();

        wethUsdcPool005 = IUniswapV3Factory(FACTORY).getPool(WETH, USDC, 500);
        wethUsdcPool030 = IUniswapV3Factory(FACTORY).getPool(WETH, USDC, 3000);

        require(wethUsdcPool005 != address(0), "WETH/USDC 0.05% pool not found");
        require(wethUsdcPool030 != address(0), "WETH/USDC 0.30% pool not found");
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      calculateRangeTicks
    // ═══════════════════════════════════════════════════════════════════

    function test_calculateRangeTicks_500bps_tickSpacing10() public view {
        (int24 tickLower, int24 tickUpper) = helper.calculateRangeTicks(wethUsdcPool005, 500);

        // Must be aligned to tickSpacing = 10
        assertEq(tickLower % 10, 0, "tickLower not aligned to spacing 10");
        assertEq(tickUpper % 10, 0, "tickUpper not aligned to spacing 10");

        // Range must be non-zero and roughly centered
        assertLt(tickLower, tickUpper, "tickLower >= tickUpper");

        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // 500 bps ≈ 488 ticks each side. After alignment, ~480-490.
        int24 lowerDist = currentTick - tickLower;
        int24 upperDist = tickUpper - currentTick;
        assertGt(lowerDist, 400, "lower distance too small for 500 bps");
        assertLt(lowerDist, 600, "lower distance too large for 500 bps");
        assertGt(upperDist, 400, "upper distance too small for 500 bps");
        assertLt(upperDist, 600, "upper distance too large for 500 bps");
    }

    function test_calculateRangeTicks_500bps_tickSpacing60() public view {
        (int24 tickLower, int24 tickUpper) = helper.calculateRangeTicks(wethUsdcPool030, 500);

        // Must be aligned to tickSpacing = 60
        assertEq(tickLower % 60, 0, "tickLower not aligned to spacing 60");
        assertEq(tickUpper % 60, 0, "tickUpper not aligned to spacing 60");
        assertLt(tickLower, tickUpper, "tickLower >= tickUpper");
    }

    function test_calculateRangeTicks_100bps() public view {
        (int24 tickLower, int24 tickUpper) = helper.calculateRangeTicks(wethUsdcPool005, 100);

        assertEq(tickLower % 10, 0, "tickLower not aligned");
        assertEq(tickUpper % 10, 0, "tickUpper not aligned");

        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // 100 bps ≈ 100 ticks each side
        int24 lowerDist = currentTick - tickLower;
        int24 upperDist = tickUpper - currentTick;
        assertGt(lowerDist, 80, "lower distance too small for 100 bps");
        assertLt(lowerDist, 120, "lower distance too large for 100 bps");
        assertGt(upperDist, 80, "upper distance too small for 100 bps");
        assertLt(upperDist, 120, "upper distance too large for 100 bps");
    }

    function test_calculateRangeTicks_1000bps() public view {
        (int24 tickLower, int24 tickUpper) = helper.calculateRangeTicks(wethUsdcPool005, 1000);

        assertEq(tickLower % 10, 0, "tickLower not aligned");
        assertEq(tickUpper % 10, 0, "tickUpper not aligned");

        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // 1000 bps ≈ 953 ticks each side
        int24 lowerDist = currentTick - tickLower;
        assertGt(lowerDist, 900, "lower distance too small for 1000 bps");
        assertLt(lowerDist, 1050, "lower distance too large for 1000 bps");
    }

    function test_calculateRangeTicks_2000bps() public view {
        (int24 tickLower, int24 tickUpper) = helper.calculateRangeTicks(wethUsdcPool030, 2000);

        // tickSpacing = 60
        assertEq(tickLower % 60, 0, "tickLower not aligned");
        assertEq(tickUpper % 60, 0, "tickUpper not aligned");

        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool030).slot0();

        // 2000 bps ≈ 1823 ticks each side, close to our approx of 1826
        int24 lowerDist = currentTick - tickLower;
        assertGt(lowerDist, 1700, "lower distance too small for 2000 bps");
        assertLt(lowerDist, 1950, "lower distance too large for 2000 bps");
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        shouldRebalance
    // ═══════════════════════════════════════════════════════════════════

    function test_shouldRebalance_inRange_noBuffer() public {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // Position centered on current tick with 1000 tick range each side
        int24 posLower = ((currentTick - 1000) / 10) * 10;
        int24 posUpper = ((currentTick + 1000) / 10) * 10 + 10;

        _mockPosition(1, WETH, USDC, 500, posLower, posUpper);

        bool rebalance = helper.shouldRebalance(NFT_POSITION_MANAGER, 1, 0);
        assertFalse(rebalance, "should NOT rebalance when in range");
    }

    function test_shouldRebalance_outOfRangeBelow() public {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // Position entirely above current tick
        int24 posLower = ((currentTick + 500) / 10) * 10;
        int24 posUpper = ((currentTick + 1500) / 10) * 10;

        _mockPosition(2, WETH, USDC, 500, posLower, posUpper);

        bool rebalance = helper.shouldRebalance(NFT_POSITION_MANAGER, 2, 0);
        assertTrue(rebalance, "should rebalance when price below range");
    }

    function test_shouldRebalance_outOfRangeAbove() public {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // Position entirely below current tick
        int24 posLower = ((currentTick - 1500) / 10) * 10;
        int24 posUpper = ((currentTick - 500) / 10) * 10;

        _mockPosition(3, WETH, USDC, 500, posLower, posUpper);

        bool rebalance = helper.shouldRebalance(NFT_POSITION_MANAGER, 3, 0);
        assertTrue(rebalance, "should rebalance when price above range");
    }

    function test_shouldRebalance_atBoundaryWithBuffer() public {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // Position where current tick is just outside the range (by 50 ticks)
        // but within the 200 bps buffer (~200 ticks)
        int24 posLower = ((currentTick + 50) / 10) * 10;
        int24 posUpper = ((currentTick + 1050) / 10) * 10;

        _mockPosition(4, WETH, USDC, 500, posLower, posUpper);

        // Without buffer: should rebalance (current tick < posLower)
        bool rebalanceNoBuffer = helper.shouldRebalance(NFT_POSITION_MANAGER, 4, 0);
        assertTrue(rebalanceNoBuffer, "should rebalance without buffer");

        // With 200 bps buffer (~200 ticks): should NOT rebalance
        // because currentTick ≥ posLower - 200
        bool rebalanceWithBuffer = helper.shouldRebalance(NFT_POSITION_MANAGER, 4, 200);
        assertFalse(rebalanceWithBuffer, "should NOT rebalance with 200 bps buffer");
    }

    function test_shouldRebalance_zeroBufferAtEdge() public {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // Position where tickUpper == currentTick (exclusive upper bound in UniV3)
        // Mock doesn't require tick spacing alignment
        int24 posLower = currentTick - 500;
        int24 posUpper = currentTick;

        _mockPosition(5, WETH, USDC, 500, posLower, posUpper);

        bool rebalance = helper.shouldRebalance(NFT_POSITION_MANAGER, 5, 0);
        assertTrue(rebalance, "should rebalance at upper boundary (exclusive)");
    }

    // ═══════════════════════════════════════════════════════════════════
    //                     computeOptimalAmounts
    // ═══════════════════════════════════════════════════════════════════

    function test_computeOptimalAmounts_inRange() public view {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        int24 tickLower = ((currentTick - 500) / 10) * 10;
        int24 tickUpper = ((currentTick + 500) / 10) * 10 + 10;

        uint256 amount0Avail = 1 ether; // 1 WETH
        uint256 amount1Avail = 2500e6; // 2500 USDC

        (uint256 amount0, uint256 amount1) = helper.computeOptimalAmounts(
            wethUsdcPool005, tickLower, tickUpper, amount0Avail, amount1Avail
        );

        // Both amounts should be used (in-range)
        assertGt(amount0, 0, "amount0 should be > 0 in range");
        assertGt(amount1, 0, "amount1 should be > 0 in range");

        // Neither should exceed available
        assertLe(amount0, amount0Avail, "amount0 exceeds available");
        assertLe(amount1, amount1Avail, "amount1 exceeds available");
    }

    function test_computeOptimalAmounts_belowRange() public view {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // Range entirely above current tick → all token0
        int24 tickLower = ((currentTick + 500) / 10) * 10;
        int24 tickUpper = ((currentTick + 1500) / 10) * 10;

        uint256 amount0Avail = 1 ether;
        uint256 amount1Avail = 2500e6;

        (uint256 amount0, uint256 amount1) = helper.computeOptimalAmounts(
            wethUsdcPool005, tickLower, tickUpper, amount0Avail, amount1Avail
        );

        // Price below range: only token0 is used
        assertGt(amount0, 0, "amount0 should be > 0 below range");
        assertEq(amount1, 0, "amount1 should be 0 below range");
        assertLe(amount0, amount0Avail, "amount0 exceeds available");
    }

    function test_computeOptimalAmounts_aboveRange() public view {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // Range entirely below current tick → all token1
        int24 tickLower = ((currentTick - 1500) / 10) * 10;
        int24 tickUpper = ((currentTick - 500) / 10) * 10;

        uint256 amount0Avail = 1 ether;
        uint256 amount1Avail = 2500e6;

        (uint256 amount0, uint256 amount1) = helper.computeOptimalAmounts(
            wethUsdcPool005, tickLower, tickUpper, amount0Avail, amount1Avail
        );

        // Price above range: only token1 is used
        assertEq(amount0, 0, "amount0 should be 0 above range");
        assertGt(amount1, 0, "amount1 should be > 0 above range");
        assertLe(amount1, amount1Avail, "amount1 exceeds available");
    }

    function test_computeOptimalAmounts_zeroInput() public view {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        int24 tickLower = ((currentTick - 500) / 10) * 10;
        int24 tickUpper = ((currentTick + 500) / 10) * 10 + 10;

        (uint256 amount0, uint256 amount1) = helper.computeOptimalAmounts(
            wethUsdcPool005, tickLower, tickUpper, 0, 0
        );

        assertEq(amount0, 0, "amount0 should be 0 with zero input");
        assertEq(amount1, 0, "amount1 should be 0 with zero input");
    }

    function test_computeOptimalAmounts_revertsOnInvalidRange() public {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        int24 tick = (currentTick / 10) * 10;

        // tickLower == tickUpper
        vm.expectRevert(UniswapV3LPHelper.InvalidRange.selector);
        helper.computeOptimalAmounts(wethUsdcPool005, tick, tick, 1 ether, 2500e6);

        // tickLower > tickUpper
        vm.expectRevert(UniswapV3LPHelper.InvalidRange.selector);
        helper.computeOptimalAmounts(wethUsdcPool005, tick + 10, tick, 1 ether, 2500e6);
    }

    function test_computeOptimalAmounts_wideRange() public view {
        (, int24 currentTick,,,,,) = IUniswapV3Pool(wethUsdcPool005).slot0();

        // Very wide range (±5000 ticks)
        int24 tickLower = ((currentTick - 5000) / 10) * 10;
        int24 tickUpper = ((currentTick + 5000) / 10) * 10 + 10;

        uint256 amount0Avail = 10 ether;
        uint256 amount1Avail = 25_000e6;

        (uint256 amount0, uint256 amount1) = helper.computeOptimalAmounts(
            wethUsdcPool005, tickLower, tickUpper, amount0Avail, amount1Avail
        );

        assertGt(amount0, 0, "amount0 should be > 0 for wide range");
        assertGt(amount1, 0, "amount1 should be > 0 for wide range");
        assertLe(amount0, amount0Avail, "amount0 exceeds available");
        assertLe(amount1, amount1Avail, "amount1 exceeds available");
    }

    // ═══════════════════════════════════════════════════════════════════
    //                         TEST HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Mock the NonfungiblePositionManager.positions() and factory() calls.
    function _mockPosition(
        uint256 tokenId,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper
    ) internal {
        // Mock positions(tokenId)
        vm.mockCall(
            NFT_POSITION_MANAGER,
            abi.encodeWithSelector(INonfungiblePositionManager.positions.selector, tokenId),
            abi.encode(
                uint96(0),      // nonce
                address(0),     // operator
                token0,
                token1,
                fee,
                tickLower,
                tickUpper,
                uint128(1e18),  // liquidity
                uint256(0),     // feeGrowthInside0LastX128
                uint256(0),     // feeGrowthInside1LastX128
                uint128(0),     // tokensOwed0
                uint128(0)      // tokensOwed1
            )
        );

        // Use the real factory() from the NFT position manager — no need to mock
    }
}
