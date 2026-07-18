# Spike findings: what the manual-design method taught us

This project was a spike for **manual writing and design**: every feature
began as a written ADR, was implemented against that ADR, tested, and
pushed before the next began. Nineteen ADRs, twenty-one schema versions,
five packages, 284 tests, and one golden scenario later, these are the
conclusions.

## What worked — keep these

**1. ADR-before-code changed what got built, not just how.**
Writing the design first repeatedly surfaced decisions that code-first
would have made by accident: that a deposit is *credit applied to an order
ahead of the document that owes* (which later made purchase prepayments a
~200-line mirror instead of a subsystem); that bill approval could stand in
for receiving *until* receiving mattered, recorded as an explicit
simplification (ADR 0012) that ADR 0015 then retired deliberately. The
ADRs also made scope cuts durable — "deferred" items were written down
with rationale and every one was either shipped later or is still
honestly listed.

**2. Append-only facts + derive-everything was the highest-leverage
decision in the project.**
Because stock is a movement log and not a level, FIFO valuation (ADR 0015)
was a *pure function added months of design-time later* with zero
migration of behavior. Because settlements, tags, fulfillment, aging, and
reports are all derived, no feature ever fought stored state. Corrections
and voids compose (reverse + reapply) instead of special-casing. The
golden scenario asserts the books balance after every chapter — that
property was never once debugged into existence; it held by construction.

**3. The reference implementation + conformance testing earned its keep.**
`DocumentBook` (in-memory) vs `CompanyFile` (SQLite) with property-based
trial-balance cross-checks caught real divergences at the moment they were
introduced, not in integration. It also forced every rule into a pure
function both engines share — which is exactly the code plugins and future
storage engines can reuse.

**4. Naming seams before needing them paid off exactly as hoped.**
Supplier info was designed *source-tagged* in ADR 0011, four ADRs before
any plugin existed. When the plugin host landed (ADR 0018), the demo
supplier plugin worked through public API with **zero core edits** — the
"VS Code of accounting" thesis, demonstrated rather than asserted.

**5. Graceful degradation by role-mapping made accounting opt-in.**
Tax, A/P, inventory-asset/COGS/GRNI: each posting upgrade activates only
when its ledger roles are mapped, and degrades to the previous behavior
otherwise. Not one existing test had to change semantics when inventory
accounting arrived. This is the pattern for every future compliance
feature.

**6. Honest gaps beat silent ones.**
The design keeps its own list of approximations — shrinkage posting is
deferred, so the golden scenario *asserts the exact 12.00 discrepancy* the
deferral creates (ch. 9). A reviewer can see what the system does not do,
with a number attached.

## What it cost — change these

**1. Hand-mirroring the storage engine is the method's biggest tax.**
Every write-path feature was implemented twice (DocumentBook +
CompanyFile), and the mirror edits grew superlinearly as the files grew
(~2.9k and ~3.6k lines). The conformance value is real, but the mechanism
should change: extract a single command layer that both engines execute,
or generate the SQL mirror. Recommendation: **one write model, storage
adapters underneath** — keep the conformance tests.

**2. SQLite CHECK-constraint enums forced repeated table rebuilds.**
`documents` was rebuilt five times just to widen a type enum. Enum-in-CHECK
is great for integrity but hostile to evolution. Recommendation: lookup
tables (FK to a row you can insert) for open sets; CHECKs only for truly
closed sets.

**3. Tests coupled to error prose broke twice.**
Both times a message was reworded for a widened feature, distant tests
failed on regex. Assert on `LedgerError.code`, keep message checks for the
few user-facing strings that matter.

**4. Workspace staleness produced phantom type errors all spike long.**
Typechecking a package against a sibling's stale `dist/` repeatedly
"failed" correct code. A build orchestrator with dependency-aware hashing
(Turborepo or `tsc -b` project references) should be table stakes for the
real project.

**5. Positional revision-line matching is fragile by design.**
`resolveDocumentLines` carries line identity across revisions by index
when ids are omitted. Documented, tested — and still the most likely
place a future UI corrupts intent. The real project should require
explicit `lineId`s at the API boundary.

## Open gaps (recorded, not hidden)

- Shrinkage/write-off posting (damage disposal, negative adjustments) —
  the one place FIFO valuation and the G/L legitimately diverge today.
- Bill-correction FIFO vs G/L price variance in mixed-layer edge cases.
- Negative-stock issues are costed at `costAt` and never retro-costed.
- `refundCredit` moves real cash but is an application record, not a
  `Payment` — so bank reconciliation cannot match refund lines (golden
  scenario ch. 11 demonstrates the unmatched line). The real project
  should unify all cash movement under one payment-shaped fact.
- ~~Bank import/reconciliation (WS3)~~ — shipped within its time-box
  (ADR 0019); OFX/rules/feeds remain plugin territory as designed.
- Multi-currency, sandboxed plugins, web UI: Phase 2+ by plan, unchanged.

## Verdict

The method scales. Nineteen consecutive design-first features landed on an
immutable core without a rewrite, without a migration failure, and without
the plugin thesis needing a single retrofit. The two structural costs
(hand-mirrored storage, enum rebuilds) have known fixes that don't touch
the method itself. For the real project: keep ADR cadence, keep
event-sourced facts + derived views, keep conformance testing — replace
the hand mirror with one write model, and let plugins keep the v1 host API
exactly as designed.
