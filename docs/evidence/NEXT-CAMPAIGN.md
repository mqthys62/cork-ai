# The next campaign — what to run, and why each part exists

The first result (2026-09-15, n=12) found no cost penalty and a suggestive
saving. Three things stopped it being conclusive, and each has a fix here
rather than "run it for longer".

## Run it

```bash
# 0. Free, and the one that makes the rest believable: check the report
#    detects a regression it is shown, before trusting it on real data.
node scripts/ab-selftest.mjs

# 1. The measurement: 8 tasks x 3 repeats x 2 arms = 48 runs, 24 pairs.
#    Resumable: re-run the same command after an interruption and it
#    continues from the last complete pair.
node scripts/ab-repo.mjs

# 2. The numbers.
node scripts/ab-report.mjs ab-repo-results/results.jsonl

# 3. The part the first campaign could not answer: are the answers as good?
node scripts/ab-judge.mjs ab-repo-results
node scripts/ab-judge.mjs ab-repo-results --summary
```

Watch it from a second terminal, which is where the quota question is
actually answered:

```bash
./scripts/ab-watch.sh
```

It shows the 5-hour block's spend and time left, how many pairs are complete,
and — the number that decides whether to keep going — the projected total cost
extrapolated from the pairs finished so far.

Note that Claude Code's status line does not appear during a campaign: it
belongs to an interactive session, and these runs are `claude -p` subprocesses.
`ab-watch.sh` reads the same underlying usage data instead.

Check the plan before spending anything:

```bash
node scripts/ab-repo.mjs --dry-run     # lists tasks, model, installed version
node scripts/ab-judge.mjs ab-repo-results --dry-run   # shows the blinding
```

## Budget

The first campaign cost ~$55 of list-price equivalent for 12 pairs, so ~$4.60
a pair. Grading adds roughly one arm per pair. Expect **$110-150 equivalent**
for the measurement and **$50-70** for the grading, under an OAuth plan where
this draws on the quota rather than an API bill.

Both stop on their own if the usage limit is hit, and both resume.

## Why each piece is there

**A second repository.** Everything so far was measured on cork-ai's own
source: one small TypeScript CLI. cork-ai's decision depends on file size,
extension and re-read rate, and all three differ sharply in a large NestJS +
Angular monorepo. A saving that appears on both is evidence about the tool; a
saving on one is a fact about that repository.

**Blind grading.** The obvious way for this tool to fake a saving is to show
the model less and get a worse answer. Answer length cannot catch that — a
confidently wrong answer is the same length as a correct one. So each pair
goes to a fresh judge as "A" and "B" in a seeded order, with no mention of
cork-ai or that a tool is under test, and the judge verifies claims against
the repository before scoring. Un-blinding happens after the verdict is
written. The judge runs *without* cork-ai: it has to see the whole truth to
catch an error in it.

**33 pairs.** At n=12 nothing reached significance. This is the sample size
that decides an effect of the observed magnitude.

**Adverse tasks.** Three of the eleven tasks are ordinary work — a test-suite
review, a shell-driven survey, a configuration question — where the hook still
runs on every `Read` and every `Bash` and finds little worth compressing. The
other eight are read-heavy by construction, which is to say chosen where this
tool wins. Measuring only those answers "is cork-ai good at what it is good
at", not "is cork-ai worth installing".

This is the question rtk got wrong. It reported a 99.8% saving and cost 7.6%
more, because a permanent per-call overhead outweighed an occasional gain. If
cork-ai does the same on ordinary work, it has to appear here, so the report
breaks the result down by profile and says so explicitly when the adverse half
costs more.

**A self-test.** `scripts/ab-selftest.mjs` feeds the report synthetic data with
a known planted regression, a known planted saving, and pure noise, and checks
it calls each one correctly. A harness that cannot see a +25% regression it was
handed cannot be trusted to have seen -14.8%. It costs nothing; run it first.

## Traps this harness already avoids

Each of these produced a wrong answer at least once. They are guarded now, but
they are the things to re-check if a future result looks surprising.

- **Naming a file in a task prompt disables the thing being measured.** cork-ai
  refuses to compress a file the user just mentioned. A first pilot cited
  paths, recorded zero compressions, and would have been reported as "no
  effect". None of these tasks names a file.
- **The hook runs the installed binary, not your working tree.** The harness
  compares the two and warns before spending.
- **The two arms read different settings files.** The control runs with an
  empty `settings.json` by construction, so it never sees a configured model.
  The model is now pinned explicitly in both arms and recorded per run.
- **Zero compressions means the tool never acted.** Such a pair measures
  agent variance, not cork-ai, and the report calls it out instead of
  averaging it in.

## Safety

Your repositories are never touched. Every run and every grading works on its
own `rsync` copy with build output excluded; the originals are fingerprinted
(HEAD plus working-tree status) before and after, and any change is reported
loudly at the end. Nothing is written back, and the copies are deleted as they
are consumed.
