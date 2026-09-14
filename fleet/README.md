# cork-ai fleet

A self-hosted dashboard for an organisation that runs cork-ai on several
workstations. Two files, no dependencies, no account, **no PostHog key**.

Each workstation runs `collect.mjs`, which asks the locally installed cork-ai
for its own numbers and writes one JSON report. A dashboard somewhere reads
those reports and shows the fleet.

```
workstation ──┐
workstation ──┼──► reports/*.json ──► dashboard.mjs ──► http://localhost:4343
workstation ──┘
```

## Why there is no PostHog key here

cork-ai can send anonymous, opt-in telemetry to its author. That is a separate
channel, and this folder neither reads it nor needs it. The reason is not
philosophical — it is that **PostHog cannot restrict an API key to a subset of
rows**. The finest grain an API key can be scoped to is the whole project, so
any key shipped here would let every reader see every cork-ai user's events,
worldwide. A key on a public repository is also compromised by secret scanners
within minutes of being pushed.

So this dashboard reads the workstation's own data instead. That turns out to
be the better source anyway: it carries real project names and real costs,
where telemetry only carries bucketed, anonymised aggregates.

Consequences worth knowing:

- Your fleet's numbers never leave your infrastructure. cork-ai's author sees
  nothing about your organisation, and is not a sub-processor of your data.
- You do not need telemetry enabled on any workstation for this to work.
- If your people *do* enable cork-ai's telemetry, their install id is the same
  id this dashboard uses as a machine key — which is how you can match a
  workstation here with a row in cork-ai's own statistics, should you ever
  agree with the author to look at your fleet together.

## Requirements

Node 18 or later on the workstations and on the host. cork-ai installed and on
`PATH` on the workstations (or point at it with `--bin`).

## 1. Collect, on each workstation

Write into a shared folder everyone can reach:

```bash
node collect.mjs --out /mnt/fleet-reports
```

Or POST it to the dashboard (see `--ingest` below):

```bash
node collect.mjs --post https://fleet.example.com/ingest --token "$FLEET_TOKEN"
```

Check what would be sent before sending anything:

```bash
node collect.mjs --stdout | less
```

### What leaves the workstation

`cork-ai report --json` is a local report and contains absolute paths such as
`/home/alice/work/acme-payments`. Fine on the machine it came from; much less
fine in a folder the whole company reads. `--privacy` decides:

| Level | Project paths | Project names | Use for |
|---|---|---|---|
| `full` | kept | kept | a machine you own yourself |
| `default` *(default)* | dropped | kept | normal fleet reporting |
| `minimal` | dropped | dropped | totals only, no project names |

Session ids are dropped at every level except `full`. Add `--anonymous-host` to
omit the hostname and the user name as well — the install id still identifies
the machine across reports, so history is preserved.

Tell people which level you use, and why. A fleet dashboard that appears
without warning, showing which projects someone worked on, is how a useful tool
gets banned.

### Scheduling it

**Linux / macOS** — once a day at 19:00, via `crontab -e`:

```cron
0 19 * * * /usr/bin/node /opt/cork-ai-fleet/collect.mjs --out /mnt/fleet-reports >> /tmp/cork-fleet.log 2>&1
```

**Windows** — Task Scheduler, or from an elevated PowerShell:

```powershell
$action  = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "C:\cork-ai-fleet\collect.mjs --out \\fileserver\fleet-reports"
$trigger = New-ScheduledTaskTrigger -Daily -At 19:00
Register-ScheduledTask -TaskName "cork-ai fleet report" -Action $action -Trigger $trigger
```

**WSL — read this before deploying.** A person running Claude Code both in
PowerShell and inside WSL has **two cork-ai installs**: one under
`C:\Users\alice\.cork-ai`, one under `/home/alice/.cork-ai`. Two install ids,
two independent sets of statistics, and neither knows about the other. That is
not a bug this folder can fix — it is what cork-ai actually is on that machine.

The collector therefore reports which side it ran on (`environment: wsl` vs
`win32`) and the dashboard shows the two as separate rows. Decide what you
want:

- *Both sides matter* — schedule the collector twice, once in Windows Task
  Scheduler and once in WSL cron (`sudo service cron start`, and enable
  `systemd` in `/etc/wsl.conf` if you want it to survive a reboot). The fleet
  shows two rows for that laptop, which is the truth.
- *Only one side is used* — schedule only that side. A Windows scheduled task
  can reach the WSL install with
  `wsl.exe -e node /opt/cork-ai-fleet/collect.mjs --out /mnt/reports`, but note
  that a Windows UNC path is not reachable from inside WSL unless it is
  mounted, and `/mnt/c/...` from inside WSL is slow for large writes.

The same caveat applies to any other layer that gives one person two homes:
containers, Dev Drive, a roaming profile that does not roam `.cork-ai`.

## 2. Serve the dashboard

```bash
node dashboard.mjs --reports /mnt/fleet-reports
```

Then open <http://127.0.0.1:4343>.

| Flag | Default | Meaning |
|---|---|---|
| `--reports <dir>` | `./reports` | where the JSON reports live |
| `--port <n>` | `4343` | |
| `--host <addr>` | `127.0.0.1` | `0.0.0.0` serves the network — see below |
| `--labels <file>` | `<reports>/labels.json` | machine names you assign |
| `--ingest` | off | accept `POST /ingest` |
| `--token <t>` | `$FLEET_TOKEN` | bearer required on `/ingest` |

Click any row to give a machine a name and a team. Names are stored in
`labels.json` next to the reports and are never sent anywhere.

### Security, stated plainly

This server has **no authentication of its own**. On `127.0.0.1` that is fine.
The moment you pass `--host 0.0.0.0`, anyone who can reach the port sees the
whole fleet — put it behind your own reverse proxy and your own SSO, the same
way you would any other internal tool.

`--ingest` without `--token` lets anyone who can reach the port write report
files. The server refuses to let a report name a path outside the reports
folder, but it will happily store junk. Always pass a token in anything but a
local test.

## What the dashboard shows, and what to do about it

| Signal | What it usually means |
|---|---|
| **Auto-compact: not set** | Claude Code will compact at its own default. Setting `autoCompactWindow` is the single cheapest improvement available; a machine without one is the first place to look. |
| **Auto-compact above 500k** | A ceiling that high may never actually trigger. It is not wrong, but the savings attributed to it are theoretical. |
| **Re-read rate above ~25 %** | Outlines are being re-read instead of answering the question the first time. Worth looking at together with the person, not at them. |
| **Mixed versions** | Numbers from different versions are not strictly comparable. Get the fleet onto one version before drawing conclusions from small differences. |
| **Not reporting for 7d+** | The scheduled task stopped, the share is unreachable, or that person stopped using Claude Code. All three are worth a message. |
| **Negative cost saved** | On that machine cork-ai is currently costing more than it saves. It happens on small projects with lots of re-reads; it is real, and the dashboard shows it rather than hiding it. |

## Adapting it

These are two plain `.mjs` files with no build step and no dependencies. Fork
them, rewrite the page, feed `/api/fleet` into Grafana — whatever fits your
infrastructure. The JSON reports are a stable, documented shape
(`schema: "cork-ai.fleet.report/1"`); if you build on anything, build on that.
