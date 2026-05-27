# CLAUDE.md

## Code style

- **No `as` type casting.** Never use TypeScript `as` assertions (e.g. `"0x..." as Address`, `value as bigint`). Instead, use proper runtime conversion functions:
  - For addresses: use viem's `getAddress()` which validates and checksums the string.
  - For other types: use runtime constructors (e.g. `BigInt(value)`) rather than compile-time assertions.
