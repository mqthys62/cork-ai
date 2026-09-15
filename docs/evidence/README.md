# Evidence

Every measurement behind the claims in this repository, as the harness wrote
it. Nothing here asks to be taken on trust:

```bash
node docs/evidence/verify.mjs
```

recomputes each published figure from `raw/`, statistics included. If a number
in `README.md` or `AB-TESTING.md` disagrees with what that prints, the prose is
wrong.

## What is here

| file | what it is |
|---|---|
| `raw/ab-repo-2026-09-15.jsonl` | 24 runs, 12 paired, read-heavy questions about a real codebase. The headline result. |
| `raw/skillsbench-probe-2026-09-14.jsonl` | 8 SkillsBench tasks probed on the treatment arm alone, to find out whether that benchmark exercises cork-ai at all. |
| `raw/skillsbench-paired-2026-09-14.jsonl` | 4 paired SkillsBench runs. Kept because they are what proved the benchmark unsuitable. |

Each row is one run: arm, task, cost, turns, token usage, and — on the
treatment arm — what cork-ai actually did. No source content, no paths, no
identifiers.

## The headline

Cost **−14.8%**, cache reads −27.3%, turns −8.3%, all in cork-ai's favour;
**0 full re-reads across 15 compressions**, which is the failure mode that made
`rtk` expensive. And **nothing significant at n=12** (cost p=0.126).

The honest sentence is: *no penalty detected, saving suggestive.* Anyone
quoting "cork-ai saves 15%" from this is overstating it.

## Measurements that did not work, and why

A dossier that only shows what worked is advertising. These cost real money and
are here because each one changed what we believe.

**SkillsBench does not exercise the read path.** Eight tasks probed, **not one
`Read` call across 110 tool uses** — they are data-processing tasks solved
through `Bash`. In real use `Read` is ~99.5% of cork-ai's savings, so that
benchmark measures the tool almost exactly where it does not act. Two
compressions across eight tasks. Set aside, and worth asking how much of the
published `rtk` result is the same effect.

**A paired SkillsBench run that looked like a verdict and was not.** Treatment
$1.30 / 31 turns against control $0.88 / 19 turns — "cork-ai costs 49% more".
Neither arm ever called `Read`, cork-ai recorded zero compressions, and the gap
was one session backgrounding five scans and waiting. The report now refuses to
present pairs with zero compressions as a result.

**A pilot where every read was refused.** The first repository tasks cited
paths like `src/cli/policy.ts`. cork-ai deliberately does not compress a file
the user just named — a sound guard — so the guard fired on every read, zero
compressions were recorded, and it would have been written up as "no effect".
**Naming a file in a benchmark prompt silently disables the thing you are
measuring.** The tasks now name none.

**A stale binary.** The hook runs the *installed* cork-ai, which was one
release behind the working tree. The treatment arm would have measured code
that predated every fix under test. The harness now compares the two and says
so before spending anything.

## What is still not measured

- **Answer quality.** These are open questions with no automated verifier, so
  correctness is unscored. Answer length was comparable (21.0KB treatment vs
  20.2KB control), which rules out saving by producing *less* — not by being
  wrong.
- **Other people's workloads.** One codebase, four tasks, one machine, one
  model. The direction is consistent; the magnitude should not be transplanted.
- **Significance.** n=12. Roughly 30-40 pairs would settle an effect this size.

## Reproducing

See [../AB-TESTING.md](../AB-TESTING.md) for the design and the traps. The
harness is `scripts/ab-repo.mjs` (real repositories) and `scripts/ab-bench.mjs`
(SkillsBench); `scripts/ab-probe.mjs` checks whether a benchmark exercises the
tool before you pay for a full run.
