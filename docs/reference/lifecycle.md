# Lifecycle math—recency, importance, maturity

The pure score math behind retrieval weighting and the lifecycle transforms that mutate `entry.lifecycle` on access, update, and decay. Everything in `src/lifecycle/` is side-effect-free—transforms return new Lifecycle objects and never mutate—so the interesting question per function is not purity but **wiring**: which of them actually run in production.

Source: `src/lifecycle/recency.js`, `src/lifecycle/importance.js`, `src/lifecycle/maturity.js`, `src/lifecycle/index.js`. Behavior confirmed against `tests/unit/lifecycle/` (`recency.test.js`, `importance.test.js`, `maturity.test.js`, `index.test.js`).

## Wiring status up front (drift #4)

| Function | Formula | Runtime callers | Status |
| --- | --- | --- | --- |
| `recencyAt` | `exp(-Δt_days / τ)` | `src/retrieval/tier2-bm25.js:71`, `src/retrieval/floor.js:27`, `src/retrieval/scorer.js:47` (Tier 3 default scorer), `src/integration/viewer/tabs/episodic.js:108,214` | **Wired** |
| `applyAccessEvent` | importance +3 | `src/retrieval/ladder.js:78` (per returned entry) | **Wired** |
| `applyUpdateEvent` | importance +5 | `src/consolidation/consolidate.js:217` (dedup-merge path) | **Wired** |
| `applyDailyDecay` | importance × 0.995^days | none | **Unwired**—no production caller; decay is never scheduled anywhere in `src/` |
| `maturityFor` | hysteresis table below | none | **Unwired**—no production caller |
| `maturityBoost` | per-tier multiplier | `src/retrieval/tier2-bm25.js:72`, `src/retrieval/floor.js:29`, `src/retrieval/scorer.js:48` (Tier 3 default scorer), `src/integration/viewer/tabs/episodic.js:223` | **Wired** |

The `scorer.js` sites are the Tier 3 path: `ladder.js:206` calls `tier3()`, which resolves the active scorer via `getScorer()` at `src/retrieval/tier3-graph.js:91`—the `defaultScorer` (`src/retrieval/scorer.js:41-49`) in every production configuration—and applies it to every graph-discovered entry.

Net effect in v2.0: importance moves (+3 on access, +5 on update) and recency is computed, but **tier never changes**—every entry stays `maturity: 'draft'` forever, and `maturityBoost` in effect always returns the draft value 0.85 because `maturityFor` never promotes anything. This is drift #4; the canonical entry lives in the [drift register](./drift-register.md).

## recency.js—exponential recency decay

`recencyAt(now, createdAt, tau)` (`recency.js:38-46`) computes:

```text
recency = exp(-Δt_days / τ)
```

where `Δt_days = (nowMs - createdMs) / MS_PER_DAY` and `MS_PER_DAY = 24 × 60 × 60 × 1000 = 86,400,000` (`recency.js:16`, `:44`). Properties:

- Returns exactly `1.0` at Δt = 0 and `exp(-1)` at Δt = τ; monotonically decreasing, always in (0, 1] (`recency.test.js:6-39`).
- `tau` defaults to `LIFECYCLE.RECENCY_TAU_DAYS` = **30 days** (`src/core/constants.js:33`), giving a half-life of `τ · ln 2 ≈ 20.8` days—at 21 days recency ≈ 0.4966 (`recency.js:31`; `recency.test.js:15-18`). A custom positive `tau` is accepted; non-finite or ≤ 0 throws (`recency.js:39-41`; `recency.test.js:51-54`).
- **Negative Δt clamps to zero** via `Math.max(0, …)` (`recency.js:44`): clock skew or timezone edges cannot make an entry "more than fresh" (`recency.test.js:46-49`).
- Accepts either `Date` objects or ISO strings (`recency.js:24-27`).

`recencyAt` is one factor of the multiplicative retrieval score (Tier 2, floor, Tier 3's default scorer, and viewer sort); the other factors live in the retrieval layer—see [retrieval.md](./retrieval.md).

## importance.js—event transforms and decay

All three transforms are pure and clamp their importance result to [0, 100] via `clampImportance` (`importance.js:25-29`).

### `applyAccessEvent(l)`—wired

`importance += ACCESS_BONUS` (+3) and `accessCount += 1` (`importance.js:39-45`; `src/core/constants.js:27`). It does **not** touch `updatedAt`—access is a read, not a content mutation (`importance.js:33-34`; `importance.test.js:34-37`). Golden value: importance 50 plus 7 accesses = 71 (`importance.test.js:45-50`); clamps at 100 (`:39-43`).

Wired at `src/retrieval/ladder.js:78`—fired for every entry the ladder returns, then persisted with the retrieval state.

### `applyUpdateEvent(l, now = new Date())`—wired

`importance += UPDATE_BONUS` (+5), `updateCount += 1`, and `updatedAt = now.toISOString()` (`importance.js:55-62`; `src/core/constants.js:29`). Does not increment `accessCount` (`importance.test.js:66-69`); `now` defaults to the current time (`:83-90`).

Wired at `src/consolidation/consolidate.js:217`—the dedup-merge path, when an extracted fact duplicates an existing entry instead of adding a new one. This is the only reason `updatedAt` ever moves after creation.

### `applyDailyDecay(l, days)`—unwired

`importance *= DAILY_DECAY^days`—0.995 raised to the day count, compounding (`importance.js:73-83`; `src/core/constants.js:31`), i.e. ≈ 0.5% per day: importance 50 decays to ≈ 8.0 over 365 days (`importance.test.js:104-109`). Guards: `days` must be a non-negative finite number or it throws (`:74-76`); `days === 0` returns a plain clone (`:77`). It touches only `importance`—not counts, timestamps, or maturity, which are separate concerns (`:65-67`; `importance.test.js:120-127`).

**Status: Unwired.** No function in `src/` calls it; there is no background scheduler, no consolidation hook, no startup sweep that applies elapsed-day decay. In production, importance never decreases—it only ever rises by access/update bonuses. Spec §7 describes decay as a background-scheduled effect; the scheduler side was never implemented (drift #4).

## maturity.js—hysteresis and boosts

### `maturityFor(importance, currentTier)`—unwired

Transitions are capped at **one step per call** and use **hysteresis gaps** so an entry hovering near a threshold cannot ping-pong between tiers (`maturity.js:5-14`, `:31-54`):

| Current tier | Condition | Next tier |
| --- | --- | --- |
| `draft` | importance ≥ 65 (`PROMOTION.draftToValidated`) | `validated` |
| `draft` | otherwise | `draft` |
| `validated` | importance ≥ 85 (`PROMOTION.validatedToCore`) | `core` |
| `validated` | importance < 35 (`DEMOTION.validatedToDraft`) | `draft` |
| `validated` | 35 ≤ importance < 85 | `validated` |
| `core` | importance < 60 (`DEMOTION.coreToValidated`) | `validated` |
| `core` | otherwise | `core` |

Thresholds live in `LIFECYCLE.PROMOTION` / `LIFECYCLE.DEMOTION` (`src/core/constants.js:41-49`). The one-step cap means a `draft` entry at importance 95 rises only to `validated`, not straight to `core` (`maturity.test.js:17-19`), and a `core` entry at importance 10 falls only to `validated` (`:34-36`). Hysteresis behavior: an entry oscillating between importance 60 and 70 stays `validated` throughout; a `validated` entry does not flip to `draft` until importance drops below 35 (`maturity.test.js:39-51`). Out-of-range importance and invalid tiers throw (`maturity.js:32-37`).

**Status: Unwired.** No production caller. In consequence every entry keeps the `maturity: 'draft'` it was born with (`entry.js:136`) regardless of importance.

### `maturityBoost(m)`—wired

Returns `LIFECYCLE.MATURITY_BOOST[m]` (`maturity.js:62-67`; `src/core/constants.js:35-39`): **draft 0.85, validated 1.0, core 1.2**. Throws on invalid maturity (`maturity.js:63-65`).

Wired at `src/retrieval/tier2-bm25.js:72` and `src/retrieval/floor.js:29` as a score multiplier, inside the Tier 3 default scorer (`src/retrieval/scorer.js:48`), and in the viewer's episodic display (`src/integration/viewer/tabs/episodic.js:223`). Because `maturityFor` never runs, the boost actually applied in v2.0 is always the `draft` value 0.85.

## See also

- [core.md](./core.md)—the `LIFECYCLE` constant block these functions read.
- [memory.md](./memory.md)—the lifecycle baseline `createEntry` initializes.
- [retrieval.md](./retrieval.md) and [consolidation.md](./consolidation.md)—the wired call sites for access and update events.
- [data-model.md](./data-model.md)—the `Lifecycle` field shape these transforms preserve.
- [drift-register.md](./drift-register.md)—drift #4: decay and maturity implemented but unwired.
- `docs/specs/2026-04-20-starmem-v2-design.md` §7—design intent (not code truth).
