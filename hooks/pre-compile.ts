/**
 * Uniswap V3 LP — preCompile Hook
 *
 * Validates strategy parameters before compilation:
 * - rangeWidthBps: must be between 1 and 20000 (0.01% to 200%)
 * - feeTier: must be one of 100, 500, 3000, 10000
 * - driftBufferBps: if provided, must be positive and less than rangeWidthBps
 * - token params: must be non-empty
 *
 * Conforms to PreCompileHook interface — no raw Node.js APIs.
 */

const VALID_FEE_TIERS = new Set([100, 500, 3000, 10000]);

const hook = {
  async execute(input: {
    strategyId: string;
    params: Record<string, string>;
    chainId: number;
    ctx: { log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void } };
  }): Promise<{
    valid: boolean;
    errors?: string[];
    transformedParams?: Record<string, string>;
  }> {
    const { params, ctx } = input;
    const errors: string[] = [];

    // ---- Validate token params ----
    if (!params["token0"] || params["token0"].trim() === "") {
      errors.push("token0 is required");
    }
    if (!params["token1"] || params["token1"].trim() === "") {
      errors.push("token1 is required");
    }
    if (params["token0"] && params["token1"] && params["token0"] === params["token1"]) {
      errors.push("token0 and token1 must be different tokens");
    }

    // ---- Validate feeTier ----
    const feeTierRaw = params["feeTier"];
    if (!feeTierRaw) {
      errors.push("feeTier is required");
    } else {
      const feeTier = parseInt(feeTierRaw, 10);
      if (isNaN(feeTier) || !VALID_FEE_TIERS.has(feeTier)) {
        errors.push(`feeTier must be one of: ${[...VALID_FEE_TIERS].join(", ")} (got "${feeTierRaw}")`);
      }
    }

    // ---- Validate rangeWidthBps ----
    const rangeWidthRaw = params["rangeWidthBps"];
    if (!rangeWidthRaw) {
      errors.push("rangeWidthBps is required");
    } else {
      const rangeWidthBps = parseInt(rangeWidthRaw, 10);
      if (isNaN(rangeWidthBps)) {
        errors.push(`rangeWidthBps must be a number (got "${rangeWidthRaw}")`);
      } else if (rangeWidthBps < 1 || rangeWidthBps > 20000) {
        errors.push(`rangeWidthBps must be between 1 and 20000 (got ${rangeWidthBps})`);
      }
    }

    // ---- Validate driftBufferBps (optional) ----
    const driftBufferRaw = params["driftBufferBps"];
    if (driftBufferRaw !== undefined && driftBufferRaw !== "") {
      const driftBufferBps = parseInt(driftBufferRaw, 10);
      if (isNaN(driftBufferBps)) {
        errors.push(`driftBufferBps must be a number (got "${driftBufferRaw}")`);
      } else if (driftBufferBps <= 0) {
        errors.push(`driftBufferBps must be positive (got ${driftBufferBps})`);
      } else {
        const rangeWidthBps = parseInt(rangeWidthRaw ?? "0", 10);
        if (!isNaN(rangeWidthBps) && driftBufferBps >= rangeWidthBps) {
          errors.push(
            `driftBufferBps (${driftBufferBps}) must be less than rangeWidthBps (${rangeWidthBps})`,
          );
        }
      }
    }

    if (errors.length > 0) {
      ctx.log.warn(`Parameter validation failed: ${errors.join("; ")}`);
    } else {
      ctx.log.info("Parameter validation passed");
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  },
};

// Export for plugin system
export default hook;
