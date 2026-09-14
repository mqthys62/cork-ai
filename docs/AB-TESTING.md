# Proving it: the A/B harness

cork-ai reports what it thinks it saved. That number is a **counterfactual** —
a claim about a run that never happened — and no tool can measure its own
effect. JetBrains showed why this matters: they A/B-tested `rtk` against a
control on SkillsBench and found it **increased** Claude Code's median cost by
**7.6%** (p=0.004), +13.8% turns, +14.3% cache reads, while `rtk gain` reported
**99.8% savings**.

cork-ai avoids the two errors behind that gap — it prices the counterfactual on
the truncated slice Claude Code actually delivers, and it prices cache reads at
0.1× — but avoiding known errors is not proof. This harness is the proof.

## What it measures

| | |
|---|---|
| **cost** | `total_cost_usd`, which includes subagents (`usage` excludes them) |
| **turns** | the mechanism by which a context tool backfires |
| **cache read / write** | rtk's penalty showed up here first |
| **task success** | SkillsBench's own verifier — a tool that saves tokens by failing has saved nothing |

## Design

- **Paired.** Both arms run the same task from the same pristine copy, so
  per-task difficulty cancels and the comparison is within-task.
- **Interleaved.** Arm order alternates per repeat, so a slow API hour cannot
  land on one arm only.
- **Clean control.** `CLAUDE_CONFIG_DIR` pointing at a directory with
  `settings.json = {}` and the credentials copied: Claude Code loads no hooks,
  so cork-ai is never invoked.
  **`--settings` MERGES instead of replacing, so it cannot build a control arm.**
- **Fresh treatment brain.** `CORK_AI_HOME` is per-run, so one run cannot teach
  the next and the policy starts from the same state every time.
- **No API billing.** Both arms run on the subscription's OAuth; the harness
  strips `ANTHROPIC_API_KEY` so a stray key cannot silently start billing.
  Under OAuth the CLI still fills `total_cost_usd` at list price
  (`costBasis: "list"`), which is what makes the comparison possible.

## Task selection

Of SkillsBench's 87 tasks, only ~14 contain files large enough to clear the
compression gate. On the rest cork-ai is inert and a run is pure noise. The
default set is the ten that exercise it most.

This makes the test **harder** for cork-ai, not easier: the effect is measured
where the tool actually acts, instead of being diluted across tasks where it
does nothing.

## Running it

```bash
git clone --depth 1 https://github.com/benchflow-ai/skillsbench   # Apache 2.0
export SKILLSBENCH_DIR=$PWD/skillsbench

node scripts/ab-bench.mjs --dry-run          # plan only, consumes nothing
node scripts/ab-bench.mjs                    # 10 tasks x 3 repeats x 2 arms
node scripts/ab-report.mjs ab-results/results.jsonl
```

Knobs: `AB_TASKS` (comma-separated), `AB_REPEATS`, `AB_TIMEOUT_MS` (per agent
run), `AB_VERIFY_TIMEOUT_MS`, `AB_OUT`.

The first real run builds each task's image (~1.4GB each, several minutes).
This is not optional: measured on `citation-check`, a generic `python:3.12-slim`
made the verifier reinstall curl and uv and take **over 20 minutes**, against
about a second on the task's own image.

Docker is needed for the verifier only — the agent runs on the host, so
credentials never enter a container built from third-party Dockerfiles.

## Reading the result

The report gives a **median ratio** of treatment over control, with a paired
Wilcoxon signed-rank test on log ratios (rank-based, because ten tasks is far
too few to assume normality).

- `cost +7.6% MORE ... p=0.004` would be the rtk result: the tool costs more.
- `cost -12% less ... p=0.01` would be proof cork-ai works.
- `p not significant` means **no effect was detected**, which is not the same
  as "no effect exists" — at n=10 only effects above roughly 20% are
  detectable. Detecting 8% takes the full 87 tasks.

Until this has been run, `cork-ai gain` says so: tokens kept out of context are
measured, dollars are inferred, and no A/B test yet confirms an effect on your
actual bill.
