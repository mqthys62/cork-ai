#!/usr/bin/env bash
# Live view of an A/B campaign, for a second terminal.
#
# The harness prints one line per finished run, but a run takes minutes and
# the campaign takes hours. This answers the question that actually matters
# while it runs: how much quota is left, and will the campaign fit in it.
#
# Usage:  ./scripts/ab-watch.sh [results-dir]      (default: ab-repo-results)

set -uo pipefail
OUT="${1:-ab-repo-results}"
RESULTS="$OUT/results.jsonl"
TOTAL_PAIRS="${AB_TOTAL_PAIRS:-33}"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

while true; do
  clear
  echo "  cork-ai A/B campaign — $(date '+%H:%M:%S')"
  echo "  ──────────────────────────────────────────────────────────────"

  # The 5-hour block: what actually stops the campaign.
  if command -v ccusage >/dev/null 2>&1; then
    block=$(ccusage blocks --active --json 2>/dev/null | jq -r '
        .blocks[0] // empty |
        "  Quota block   $\(.costUSD // 0 | .*100|round/100) used" +
        "   \((.projection.remainingMinutes // 0) / 60 | floor)h \((.projection.remainingMinutes // 0) % 60)m left" ,
        "  Burn rate     $\(.burnRate.costPerHour // 0 | .*100|round/100)/hr" +
        "   projected $\(.projection.totalCost // 0 | .*100|round/100) by block end"
      ' 2>/dev/null)
    # Between two 5-hour blocks there is no active block at all, which is not
    # an error: it means nothing has been spent since the reset.
    if [ -n "$block" ]; then
      echo "$block"
    else
      echo "  Quota block   no active block — a fresh 5h window starts on the next call"
    fi
  else
    echo "  Quota block   ccusage not installed — npm i -g ccusage"
  fi

  echo ""

  if [ -f "$RESULTS" ]; then
    jq -sr --argjson total "$TOTAL_PAIRS" '
      # A pair counts only when BOTH arms succeeded: a half-pair is not a
      # measurement, and counting it would overstate progress.
      (map(select(.ok)) | group_by(.task + "#" + (.rep|tostring))
        | map(select(length == 2)) | length) as $pairs |
      (map(.costUSD // 0) | add) as $spent |
      (map(select(.arm=="treatment") | .compressions // 0) | add) as $comp |
      (map(select(.arm=="treatment") | .reReads // 0) | add) as $rr |
      (length) as $runs |
      "  Runs done     \($runs)          pairs complete \($pairs)/\($total)",
      "  Spent         $\($spent*100|round/100) of list-price equivalent",
      "  cork-ai       \($comp) compression(s), \($rr) full re-read(s)",
      (if $pairs > 0 then
        "  Per pair      $\(($spent / $pairs)*100|round/100)   projected total $\((($spent / $pairs) * $total)*100|round/100)"
       else empty end)
    ' "$RESULTS" 2>/dev/null

    echo ""
    echo "  Last 6 runs:"
    tail -6 "$RESULTS" | jq -r '
      "    \(.task[0:20] | . + (" " * (20 - length))) \(.arm[0:9] | . + (" " * (9 - length))) " +
      "$\((.costUSD // 0)*10000|round/10000)   \(.turns // "?") turns" +
      (if .arm == "treatment" then "   \(.compressions // 0) compressed" else "" end) +
      (if .ok then "" else "   FAILED" end)'
  else
    echo "  Waiting for $RESULTS ..."
  fi

  echo ""
  echo "  ──────────────────────────────────────────────────────────────"
  echo "  Ctrl+C to stop watching (the campaign keeps running)."
  sleep 20
done
