# ADR 0002: Money is bigint minor units; floats are banned

- **Status:** Accepted
- **Date:** 2026-07-01

## Context

IEEE 754 floats cannot represent most decimal amounts exactly (`0.1 + 0.2 !==
0.3`). Accounting software must sum to the cent, always.

## Decision

- All monetary amounts are stored and computed as **bigint counts of minor
  units** (cents, pence, …), paired with an ISO 4217 currency code and its
  exponent.
- Parsing from user input and formatting for display are the only places decimal
  strings appear; both live in `@accounts/core`'s `money` module and never route
  through `number`.
- Float literals, `parseFloat`, and `Number.parseFloat` are banned by lint rule
  in `packages/core` and `packages/storage`.
- SQLite stores amounts as INTEGER (SQLite integers are 64-bit, read back as
  bigint via `defaultSafeIntegers`); Postgres will use BIGINT.

## Consequences

- Arithmetic is exact and overflow-safe far beyond realistic book sizes.
- Currency exponent handling (JPY=0, BHD=3) is explicit in the money type.
- FX rates (non-monetary ratios) are represented as scaled integers when they
  enter financial computation; display-only math may use floats outside the
  restricted packages.
