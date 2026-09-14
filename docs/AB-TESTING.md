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

### Stopping and resuming

A subscription's 5-hour window rarely covers 60 runs, so the harness is built
to be interrupted. Re-run the same command and it skips the pairs already in
`results.jsonl`; `--dry-run` reports how many runs are left before you commit
any quota to it.

Only **whole pairs** are skipped. A half-finished pair is redone, because the
two arms must run close together for the comparison to hold.

It also stops on its own rather than burning the rest of the plan: on a run
that produced no result and mentions a usage limit, or after three failures in
a row. Everything measured so far stays on disk.

### What it costs

Nothing beyond the subscription — but it is real quota. A trivial run already
costs about $0.10 of list-price equivalent in start-up alone, and these tasks
are the dense ones, so budget roughly **$1–3 of equivalent per run**: about
**$60–180 for the full 60-run smoke**. Plan it for a window where you are not
working.

Docker is needed for the verifier only — the agent runs on the host, so
credentials never enter a container built from third-party Dockerfiles.

## What two real runs already showed

A first paired run on `software-dependency-audit` (rc.4 installed, both arms):

| | treatment | control |
|---|---|---|
| cost | $1.3035 | $0.8769 |
| turns | 31 | 19 |
| cache reads | 1,223,873 | 509,207 |
| Bash calls | 29 (5 backgrounded) | 18 (0 backgrounded) |
| **Read calls** | **0** | **0** |
| **cork-ai compressions** | **0** | — |

Read as a verdict this says cork-ai costs 49% more. It says nothing of the
kind. **Neither arm ever called `Read`**, so the hook had nothing to intercept
and cork-ai recorded zero compressions and zero saved tokens. The gap is one
agent choosing to background five scans and burn turns waiting, and the other
not — ordinary between-session variance.

Two lessons the harness now depends on:

- **A single pair proves nothing.** Session-to-session variance on these tasks
  is larger than the effect being measured. Only the repeated, paired design
  with a rank test separates them, which is why `AB_REPEATS` exists.
- **Check that cork-ai actually ran.** A task that solves itself through `Bash`
  never touches the read path. Before reading any cost number, confirm the
  treatment arm's `CORK_AI_HOME` recorded compressions — the report prints this,
  and a run with zero compressions measures agent variance, not this tool.

## Does the benchmark even exercise the tool?

Probing the treatment arm alone (half the cost of a pair) on four tasks:

| task | cost | turns | compressions | tools used |
|---|---|---|---|---|
| software-dependency-audit | $1.30 | 31 | 0 | Bash x29 |
| citation-check | $0.54 | 9 | 0 | Bash x8 |
| python-scala-translation | $1.74 | 24 | **2** (1,766 tok) | Bash x23 |
| organize-messy-files | $1.06 | 20 | 0 | Bash x18 |
| simpo-code-reproduction | $0.74 | 20 | 0 | Bash x19 |
| invoice-fraud-detection | $0.50 | 13 | 0 | Bash x12 |
| lean4-proof, flink-query, data-to-d3 | — | — | 0 | timed out at 7 min |

**Not one `Read` call across 110 tool uses on six completed tasks**, including
two that ask the agent to modify existing source files. SkillsBench tasks are
data-processing work — grep, python, jq — so the agent works through `Bash`
throughout. The single task that did trigger cork-ai did so through the Bash
hook, on a `cat` of a 340-line SKILL.md, and the outcome was the good one:
`rangeReads: 1, reReads: 0` — the agent read the region it needed instead of
re-reading the file.

This matters for interpretation. In real use `Read` is **99.5%** of cork-ai's
savings and Bash is 0.5%, so a benchmark where the agent never calls `Read`
measures the tool almost exactly where it does not act. A null result here
would be evidence about SkillsBench, not about cork-ai — and it is worth
asking how much of the rtk result was the same effect.

Probe before spending: `scripts/ab-probe.mjs` runs the treatment arm alone on a
list of tasks and reports what cork-ai actually did. Eight tasks cost $4.59 to
probe and produced two compressions in total — enough to say that a paired
smoke over these tasks would mostly measure agent variance.

A benchmark that exercises the read path is still needed. Tasks where an agent
edits real source files — the work `Read` is for — are the missing piece, and
SkillsBench does not supply them.

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
