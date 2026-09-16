# STARmem—docs index

Navigable index of this tree. Code truth lives in `docs/reference/`; everything else
is design intent, history, or dated measurement records.

## What lives where

- [`specs/`](./specs/)—the approved design-of-record, [`2026-04-20-starmem-v2-design.md`](./specs/2026-04-20-starmem-v2-design.md). Intent, not code truth; its errata block points at the drift register.
- [`reference/`](./reference/)—the source-of-truth reference set describing implemented behavior, every claim cited `file:line`. Start at the [hub README](./reference/README.md); [`drift-register.md`](./reference/drift-register.md) catalogs the known spec-vs-code divergences.
- [`install.md`](./install.md)—how to install and verify the extension in SillyTavern (git clone only; no build step).
- [`wiki/`](./wiki/)—per-paper notes (AdaMem, A-MEM, ByteRover, MAGMA, RAPTOR, Zep) with our adaptation/rejection rationale.
- [`bench/`](./bench/)—dated measurement records: `baseline.json` plus the `baselines/`, `sweeps/`, and `audits/` artifact trees. Each file is a record of one run—cite it as a measurement of that run, not a guarantee. Methodology and the current harness are documented in [`reference/bench.md`](./reference/bench.md).
- [`plans/`](./plans/)—historical implementation plans and retrospectives, phase by phase, preserved as-is. Superseded by the shipped code; not current guidance.
- [`screenshots/`](./screenshots/)—the Memory Viewer screenshot referenced by the top-level README.

## Reading order

1. [`../README.md`](../README.md)—what the extension is and does.
2. [`install.md`](./install.md)—getting it running in SillyTavern.
3. [`reference/README.md`](./reference/README.md)—the reference set, its status legend (Wired / Unwired / Divergence), and its maintenance rule.
4. [`reference/drift-register.md`](./reference/drift-register.md)—read before trusting any spec detail.

## Rules of the tree

- Reference pages go stale exactly when the code does: update the cited page in the same change that moves what it cites.
- Plans and bench artifacts are frozen history—fix links if they break, never rewrite numbers or prose.
