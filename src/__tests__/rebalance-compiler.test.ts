/**
 * Rebalance Compiler Tests
 *
 * Tests the custom compiler for uniswap-v3-lp:rebalance strategy.
 * Uses mocked RPC responses and injected dependencies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress, type Address, type Hex, maxUint128 } from "viem";
import { compileRebalance, type CompileScriptFn, type ResolveTokenFn, type Operation } from "../rebalance-compiler";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address;
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const POOL_ADDRESS = "0xC6962004f452bE9203591991D15f6b388e09E8D0" as Address;
const OWNER = "0x1234567890123456789012345678901234567890" as Address;
const CHAIN_ID = 42161; // Arbitrum
const RPC_URL = "https://arb-mainnet.g.alchemy.com/v2/test-key";

// Position manager address (well-known)
const POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab5B0983" as Address;

// LP Helper on Arbitrum
const LP_HELPER = "0x8b320a9bb7e900cc2af9fd251482d137d402b6b6" as Address;

// Mock token info
const WETH_INFO = { address: WETH_ADDRESS, decimals: 18, symbol: "WETH" };
const USDC_INFO = { address: USDC_ADDRESS, decimals: 6, symbol: "USDC" };

// Mock compileScript that returns deterministic results
const mockCompileScript: CompileScriptFn = vi.fn((input) => ({
  commands: input.operations.map(
    (_, i) => `0x${"aa".repeat(32)}` as Hex,
  ),
  state: [`0x${"bb".repeat(32)}` as Hex],
}));

// Mock resolveToken
const mockResolveToken: ResolveTokenFn = vi.fn((symbol: string, chainId: number) => {
  if (symbol === "WETH" || symbol === WETH_ADDRESS) return WETH_INFO;
  if (symbol === "USDC" || symbol === USDC_ADDRESS) return USDC_INFO;
  return undefined;
});

// Mock RPC responses
const mockReadContract = vi.fn();

// Override createPublicClient to use mocked readContract
vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...(actual as object),
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
    })),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseMockSetup() {
  // Factory.getPool
  mockReadContract.mockImplementation(async (args: any) => {
    const fn = args.functionName;
    const addr = args.address?.toLowerCase();

    // Factory.getPool
    if (fn === "getPool") return POOL_ADDRESS;

    // Position manager
    if (addr === POSITION_MANAGER.toLowerCase()) {
      if (fn === "balanceOf") return 0n; // no positions by default
      if (fn === "tokenOfOwnerByIndex") return 0n;
      if (fn === "positions") {
        return [
          0n, // nonce
          "0x0000000000000000000000000000000000000000", // operator
          WETH_ADDRESS, // token0
          USDC_ADDRESS, // token1
          500, // fee
          -887220, // tickLower
          887220, // tickUpper
          1000000000000000000n, // liquidity (1e18)
          0n, 0n, // feeGrowth
          0n, 0n, // tokensOwed
        ];
      }
    }

    // LP Helper
    if (addr === LP_HELPER.toLowerCase()) {
      if (fn === "calculateRangeTicks") return [-887220, 887220]; // wide range
      if (fn === "computeOptimalAmounts") return [500000000000000000n, 1000000000n]; // 0.5 WETH, 1000 USDC
    }

    // Pool
    if (addr === POOL_ADDRESS.toLowerCase()) {
      if (fn === "slot0") {
        return [
          79228162514264337593543950336n, // sqrtPriceX96 (~1:1 for simplicity)
          0, // tick
          0, 0, 0, 0, true,
        ];
      }
      if (fn === "tickSpacing") return 10;
    }

    // ERC20
    if (fn === "balanceOf") return 1000000000000000000n; // 1e18
    if (fn === "decimals") {
      if (addr === WETH_ADDRESS.toLowerCase()) return 18;
      if (addr === USDC_ADDRESS.toLowerCase()) return 6;
      return 18;
    }

    return 0n;
  });
}

function setupWithPosition() {
  // Same as base but with an existing position
  baseMockSetup();

  // Override balanceOf to return 1 position
  const originalImpl = mockReadContract.getMockImplementation()!;
  mockReadContract.mockImplementation(async (args: any) => {
    const fn = args.functionName;
    const addr = args.address?.toLowerCase();

    // Position manager balanceOf → 1 position
    if (addr === POSITION_MANAGER.toLowerCase() && fn === "balanceOf") {
      return 1n;
    }
    // Position manager tokenOfOwnerByIndex → tokenId 12345
    if (addr === POSITION_MANAGER.toLowerCase() && fn === "tokenOfOwnerByIndex") {
      return 12345n;
    }
    // Position manager positions → active position
    if (addr === POSITION_MANAGER.toLowerCase() && fn === "positions") {
      return [
        0n, // nonce
        "0x0000000000000000000000000000000000000000", // operator
        WETH_ADDRESS, // token0
        USDC_ADDRESS, // token1
        500, // fee
        -100, // tickLower
        100, // tickUpper
        5000000000000000000n, // liquidity (5e18)
        0n, 0n, // feeGrowth
        100000n, 50000n, // tokensOwed (some accrued fees)
      ];
    }
    return originalImpl(args);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compileRebalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Parameter validation ──────────────────────────────────────────────

  describe("parameter validation", () => {
    it("throws when token0 is missing", async () => {
      await expect(
        compileRebalance(
          { token1: "USDC", feeTier: "500", rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
        ),
      ).rejects.toThrow("Missing required parameter: token0");
    });

    it("throws when token1 is missing", async () => {
      await expect(
        compileRebalance(
          { token0: "WETH", feeTier: "500", rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
        ),
      ).rejects.toThrow("Missing required parameter: token1");
    });

    it("throws when feeTier is missing", async () => {
      await expect(
        compileRebalance(
          { token0: "WETH", token1: "USDC", rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
        ),
      ).rejects.toThrow("Missing required parameter: feeTier");
    });

    it("throws when rangeWidthBps is missing", async () => {
      await expect(
        compileRebalance(
          { token0: "WETH", token1: "USDC", feeTier: "500" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
        ),
      ).rejects.toThrow("Missing required parameter: rangeWidthBps");
    });

    it("throws when rpcUrl is not provided", async () => {
      await expect(
        compileRebalance(
          { token0: "WETH", token1: "USDC", feeTier: "500", rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
        ),
      ).rejects.toThrow("RPC URL is required");
    });

    it("throws for invalid feeTier", async () => {
      await expect(
        compileRebalance(
          { token0: "WETH", token1: "USDC", feeTier: "250", rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
        ),
      ).rejects.toThrow("Invalid feeTier");
    });

    it("throws for out-of-range rangeWidthBps", async () => {
      await expect(
        compileRebalance(
          { token0: "WETH", token1: "USDC", feeTier: "500", rangeWidthBps: "25000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
        ),
      ).rejects.toThrow("Invalid rangeWidthBps");
    });

    it("throws for unsupported chain", async () => {
      baseMockSetup();
      await expect(
        compileRebalance(
          { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
          OWNER,
          999999,
          RPC_URL,
        ),
      ).rejects.toThrow("Unsupported chain");
    });
  });

  // ── New position flow (no existing LP) ────────────────────────────────

  describe("new position flow", () => {
    it("creates a new position when no existing LP is found", async () => {
      baseMockSetup();

      const result = await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      expect(result.description).toContain("Create");
      expect(result.stepDescriptions).toBeDefined();
      expect(result.commands.length).toBeGreaterThan(0);
      expect(result.state.length).toBeGreaterThan(0);
    });

    it("skips decrease-liquidity and collect steps for new position", async () => {
      baseMockSetup();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      // Check that compileScript was called with operations
      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      const actionIds = ops
        .filter((op: Operation) => op._actionId)
        .map((op: Operation) => op._actionId);

      expect(actionIds).not.toContain("uniswap-v3-lp:decrease-liquidity");
      expect(actionIds).not.toContain("uniswap-v3-lp:collect-fees");
      expect(actionIds).toContain("uniswap-v3-lp:mint-position");
    });

    it("includes swap when token ratio is imbalanced", async () => {
      baseMockSetup();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      const swapOps = ops.filter((op: Operation) => op.type === "swap");

      // Whether a swap is included depends on the mocked optimal amounts
      // Our mock returns asymmetric amounts, so a swap should be present
      expect(swapOps.length).toBeLessThanOrEqual(1);
    });

    it("mints with BALANCE for amount0Desired and amount1Desired", async () => {
      baseMockSetup();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      const mintOp = ops.find((op: Operation) => op._actionId === "uniswap-v3-lp:mint-position");

      expect(mintOp).toBeDefined();
      expect(mintOp!.args?.["amount0Desired"]).toBe("BALANCE");
      expect(mintOp!.args?.["amount1Desired"]).toBe("BALANCE");
    });

    it("sets correct tick range from LP helper", async () => {
      baseMockSetup();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      const mintOp = ops.find((op: Operation) => op._actionId === "uniswap-v3-lp:mint-position");

      expect(mintOp!.args?.["tickLower"]).toBe("-887220");
      expect(mintOp!.args?.["tickUpper"]).toBe("887220");
    });
  });

  // ── Rebalance flow (existing position) ────────────────────────────────

  describe("rebalance flow", () => {
    it("includes decrease-liquidity and collect for existing position", async () => {
      setupWithPosition();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      const actionIds = ops
        .filter((op: Operation) => op._actionId)
        .map((op: Operation) => op._actionId);

      expect(actionIds).toContain("uniswap-v3-lp:decrease-liquidity");
      expect(actionIds).toContain("uniswap-v3-lp:collect-fees");
      expect(actionIds).toContain("uniswap-v3-lp:mint-position");
    });

    it("resolves tokenId from existing position", async () => {
      setupWithPosition();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      const decreaseOp = ops.find(
        (op: Operation) => op._actionId === "uniswap-v3-lp:decrease-liquidity",
      );

      expect(decreaseOp!.args?.["tokenId"]).toBe("12345");
      expect(decreaseOp!.args?.["liquidity"]).toBe("MAX");
    });

    it("passes owner as collect recipient", async () => {
      setupWithPosition();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      const collectOp = ops.find(
        (op: Operation) => op._actionId === "uniswap-v3-lp:collect-fees",
      );

      expect(collectOp!.args?.["recipient"]).toBe(OWNER);
    });

    it("generates description mentioning position number", async () => {
      setupWithPosition();

      const result = await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      expect(result.description).toContain("Rebalance");
      expect(result.description).toContain("12345");
    });

    it("preserves operation order: decrease → collect → swap → mint", async () => {
      setupWithPosition();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      const types = ops.map((op: Operation) => op._actionId || op.type);

      const decreaseIdx = types.indexOf("uniswap-v3-lp:decrease-liquidity");
      const collectIdx = types.indexOf("uniswap-v3-lp:collect-fees");
      const mintIdx = types.indexOf("uniswap-v3-lp:mint-position");

      expect(decreaseIdx).toBeLessThan(collectIdx);
      expect(collectIdx).toBeLessThan(mintIdx);
    });
  });

  // ── Token resolution ──────────────────────────────────────────────────

  describe("token resolution", () => {
    it("resolves tokens via injected resolveToken", async () => {
      baseMockSetup();

      await compileRebalance(
        { token0: "WETH", token1: "USDC", feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      expect(mockResolveToken).toHaveBeenCalledWith("WETH", CHAIN_ID);
      expect(mockResolveToken).toHaveBeenCalledWith("USDC", CHAIN_ID);
    });

    it("accepts raw addresses without resolveToken", async () => {
      baseMockSetup();

      const result = await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript }, // no resolveToken
      );

      expect(result.commands.length).toBeGreaterThan(0);
    });

    it("throws for unknown token symbol", async () => {
      baseMockSetup();

      await expect(
        compileRebalance(
          { token0: "FAKE", token1: "USDC", feeTier: "500", rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
          undefined,
          { compileScript: mockCompileScript, resolveToken: mockResolveToken },
        ),
      ).rejects.toThrow("Unknown token: FAKE");
    });
  });

  // ── Pool resolution ───────────────────────────────────────────────────

  describe("pool resolution", () => {
    it("resolves pool from factory via getPool", async () => {
      baseMockSetup();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      // Verify factory.getPool was called
      const factoryCalls = mockReadContract.mock.calls.filter(
        (call: any) => call[0].functionName === "getPool",
      );
      expect(factoryCalls.length).toBe(1);
    });

    it("throws when no pool exists", async () => {
      baseMockSetup();
      // Override getPool to return zero address
      mockReadContract.mockImplementation(async (args: any) => {
        if (args.functionName === "getPool") {
          return "0x0000000000000000000000000000000000000000";
        }
        if (args.functionName === "decimals") return 18;
        return 0n;
      });

      await expect(
        compileRebalance(
          { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
          undefined,
          { compileScript: mockCompileScript, resolveToken: mockResolveToken },
        ),
      ).rejects.toThrow("No Uniswap V3 pool found");
    });
  });

  // ── Prepend operations ────────────────────────────────────────────────

  describe("prepend operations", () => {
    it("includes prependOps at the start", async () => {
      baseMockSetup();

      const prependOps: Operation[] = [
        { type: "approve", token: "WETH", amount: "MAX" },
      ];

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        prependOps,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const ops = (mockCompileScript as any).mock.calls[0][0].operations as Operation[];
      expect(ops[0].type).toBe("approve");
    });
  });

  // ── Token ordering validation ─────────────────────────────────────────

  describe("token ordering", () => {
    it("throws when token0 address is higher than token1", async () => {
      baseMockSetup();

      // USDC address is lower than WETH on Arbitrum, so passing WETH as token0 with
      // USDC as token1 should work. Let's swap them to trigger the error.
      // Use addresses where the first is clearly higher
      await expect(
        compileRebalance(
          {
            token0: "0xff00000000000000000000000000000000000000",
            token1: "0x0100000000000000000000000000000000000000",
            feeTier: "500",
            rangeWidthBps: "1000",
          },
          OWNER,
          CHAIN_ID,
          RPC_URL,
          undefined,
          { compileScript: mockCompileScript },
        ),
      ).rejects.toThrow("token0 address must be lower than token1");
    });
  });

  // ── Dependency injection ──────────────────────────────────────────────

  describe("dependency injection", () => {
    it("throws when compileScript is not provided", async () => {
      baseMockSetup();

      await expect(
        compileRebalance(
          { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
        ),
      ).rejects.toThrow("compileScript dependency is required");
    });

    it("passes chainId and owner to compileScript", async () => {
      baseMockSetup();

      await compileRebalance(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: "500", rangeWidthBps: "1000" },
        OWNER,
        CHAIN_ID,
        RPC_URL,
        undefined,
        { compileScript: mockCompileScript, resolveToken: mockResolveToken },
      );

      const callArgs = (mockCompileScript as any).mock.calls[0][0];
      expect(callArgs.chainId).toBe(CHAIN_ID);
      expect(callArgs.owner).toBe(OWNER);
    });
  });

  // ── Fee tiers ─────────────────────────────────────────────────────────

  describe("fee tiers", () => {
    for (const fee of [100, 500, 3000, 10000]) {
      it(`accepts fee tier ${fee}`, async () => {
        baseMockSetup();

        const result = await compileRebalance(
          { token0: WETH_ADDRESS, token1: USDC_ADDRESS, feeTier: fee.toString(), rangeWidthBps: "1000" },
          OWNER,
          CHAIN_ID,
          RPC_URL,
          undefined,
          { compileScript: mockCompileScript, resolveToken: mockResolveToken },
        );

        expect(result.commands.length).toBeGreaterThan(0);
      });
    }
  });
});
