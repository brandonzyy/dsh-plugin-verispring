# dsh-plugin-verispring

Verispring three-role session architecture plus a bundled local knowledge graph (manon), substantially improving main-session context and reducing premium model API costs.
[中文](README.zh.md) | English

## What it enforces

| # | Gate | Behavior |
|---|---|---|
| 1 | Dispatch spec gate | `subagent` / `subagent_fork` requires the dispatch spec content to have appeared in the session (a read result containing the spec's first-line marker; state is persisted in the session log and survives restarts) |
| 2 | Scout identity (dispatch intent) | The role is decided by the **`description` prefix the leader writes**: a dispatch whose description starts with `测绘智能体` or `scout` is a scout dispatch, anything else is an executor dispatch. Reachability only decides whether the dispatch may start, never the role: while a reachable scout exists, another scout dispatch is denied with a `send_message` reuse pointer (a scout waiting for a question showing finished/inactive is normal — `send_message` cold-resumes it); when no scout is reachable, an **executor dispatch is denied** with the `scout-missing` rule and three routes — `send_message` the previous scout, re-dispatch with a scout-prefixed description, or have the scout build/recheck the map first. It is never silently re-roled into a scout. Every scout dispatch gets a briefing (role, read-only duty, the unreachable previous scout, and the full repository map when present); only a successful scout start records `scoutId`, executor dispatches never touch that field. Child roles are persisted at spawn (`session-state/<child session id>.json`) and restored from the record, the session title, and the recorded scout id after reloads |
| 3 | Map first + baseline | Non-scout dispatch requires `<session workspace>/.project-map.md` (project root = `.git`/`.manon` present; otherwise fail-open); a `write`/`edit` of that file registers the current HEAD as the map baseline, and dispatch is denied while HEAD has advanced past it (the denial points to a scout incremental recheck plus a full `write` rewrite to re-register). A map without a registered baseline is denied too — no fail-open, so a stale map cannot stay valid forever. Fail-open only when `CASEOS_SCOUT=0` or HEAD cannot be read |
| 4 | Brief lint + executor cap | The executor brief is a result description, not a research request: briefs containing research wording (`BRIEF_LINT_TERMS` in `gates/dispatch-gate.js`) are denied with directions to `send_message` the scout instead — **negated mentions are exempt** (a negation within 6 characters before the hit, e.g. `不要通读实现` / `禁止先调研`). Running executors per leader session are capped (default 8); exceeding it is denied with "end the turn and wait for receipts". Both have kill switches (`CASEOS_BRIEF_LINT=0`, `CASEOS_MAX_EXECUTORS`) |
| 5 | Pinned model | Routes are enforced at runtime **per role**: a scout dispatch uses the panel's scout route, an executor dispatch the executor route (the role comes from the `description` prefix); explicit `provider`/`model` on the call is ignored. `subagent_fork` is always denied |
| 6 | Commit gate | `git commit` requires a prior read of `~/.dsh/specs/代码写作规范.md`; the shape is forced to `-F file -- explicit paths`, with `timeout`/`env`/`nice`/`nohup`/`stdbuf` style wrappers seen through |
| 7 | Leader scope | The leader's tool face shrinks to the review five (`bash`/`edit`/`write`/`read`/`read_image`) plus the dispatch face (`subagent`/`send_message`/`interrupt_agent`/`list_agents`/`release_subagent`), intersected with the tools that actually exist in the leader's view (desktop serves them from the preset layer, headless from the root layer); dispatch tools are shadowed by slim definitions; `subagent-base` is unconditionally denied at the root layer (if the routing executor ever breaks, the model has no fallback to sneak through). Scout and executor subagents get the full face of the `verispring-subagent` preset; a scout's `edit`/`write` are hard-denied at runtime — `gates/dispatch-gate.js` matches the `scout` role from the queued dispatch plan on `agent/created` and calls `rtc.tools.restrict({ deny: ["edit", "write"] })` on the child's own scope, so the tools are absent from the scout's tool list (executors and the leader keep them). Kill switch `CASEOS_SCOUT=0` drops the scout part of the division clause and the restriction |
| 8 | Leader guard | Two kinds of runtime handling. **Denials (unchanged):** while a child is running, `sleep`/loop-waiting in `bash` is denied, and a second `list_agents` in the same turn is denied. **Hints (since 1.3.66):** `edit`/`write` outside the whitelist (`.project-map.md`, paths containing `/reports/`, `~/.dsh/AGENTS.md`, plus `CASEOS_LEADER_WRITE_ALLOW` prefixes) and `bash` change commands — `git commit/push/merge/rebase/restore/stash` (only `git stash list` / `git stash show` stay silent), `npm`/`pnpm` publish/install, `sed -i`/`perl -i`, `rm -rf`, workspace redirects — are **no longer denied**: the call runs as usual and one notice is appended after the tool result via the host `tools/post-execute` `additionalContexts` ("clear-boundary code and writing tasks go to an executor subagent; the leader does small fixes, the map, reports and verification writes"), at most once per turn, recorded to the monitor as `leader-write-hint` (rule + summary). Subagent sessions are unaffected. Kill switch `CASEOS_LEADER_GUARD=0` |
| 9 | Scout relay | The three loops that used to exist only in the prompt: `ask_scout` lets an executor hand a location/fact question to the resident scout and waits for the fresh answer (sender is the leader agent, since `sendMessage` authorizes by lineage; the answer is correlated by marker from the scout's session events, so a scout that settles right after answering still delivers it, and every wait round yields through a real ≥250 ms timer that is cleared when the wait ends); the closing "结构增量" (structure delta) section of a non-scout child is forwarded to the scout automatically; a failed child (`error`/`aborted`/`refusal`) writes a checkpoint that the plugin attaches when the leader continues it. Non-scout subagents get an injected ≤4-line locator discipline (`ask_scout` when a scout is reachable, "write it into your report" otherwise) plus the mandatory structure-delta section. Kill switch `CASEOS_SCOUT_RELAY=0`; `CASEOS_ASK_SCOUT_TIMEOUT_MS` bounds the wait |
| 10 | manon bridge | Resolves the local graph CLI (`MANON_KG_BIN` > bundled `manon/manon-kg` > legacy `~/manon/manon-kg`) and, when present, injects per role: the scout gets the full surface (commands, sourced invocation rule, ownership discipline), the leader gets one line ("graph facts come from the scout"), the executor gets one line — **manon is scout-owned; leader and executors never invoke it directly**; semantics in `~/.dsh/specs/Manon调用规则.md`. **The load-bearing part is the invocation rule**: dsh's subprocess service strips KEY/TOKEN-shaped env vars from children (anti-leak), so a bare `manon-kg sync` always fails with a missing key — the injected form sources `~/.dsh/manon.env` inside the bash command first (the scrub only strips the first hop; grandchildren inherit freely). Secret values never pass through or get printed |
| 11 | Secret hygiene | Credential/env files (`manon.env`, `verispring.env`, project `.env*`) cannot be read via `read` or echoed via `cat`/`sed` and friends (matched per command segment, so the sanctioned `source` prefix and pipes on manon output are not false positives); whole-environment dumps — bare `env`/`printenv`, `ps eww`, `/proc/*/environ`, `docker inspect` without `--format` — are denied |
| 12 | Runtime monitor | Role drift, gate denials, scout reachability changes and subagent start/end (role + route + stop reason, recorded only after a successful start) are appended to `~/.dsh/verispring-monitor.jsonl`, so audits no longer require decompressing session logs |

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `CASEOS_SCOUT` | on | `0` drops the scout part of the division clause, the map freshness/baseline gate, and the `scout-missing` denial (executor dispatches are then allowed without a scout) |
| `CASEOS_BRIEF_LINT` | on | `0` disables research-wording denials on executor briefs |
| `CASEOS_MAX_EXECUTORS` | `8` | running-executor cap per leader session (`0` blocks every executor dispatch). The default equals the host's own `maxActiveSubagents` default of 8 (the scout counts toward the host limit), so with the scout running the 8th executor may be refused by the host with `ACTIVATION_LIMIT_REACHED` |
| `CASEOS_LEADER_GUARD` | on | `0` disables the leader runtime denials at assembly time |
| `CASEOS_LEADER_WRITE_ALLOW` | empty | `:`-separated extra path prefixes the leader may `edit`/`write` |
| `CASEOS_SCOUT_RELAY` | on | `0` unregisters `ask_scout` and stops forwarding/checkpointing/prompt injection |
| `CASEOS_ASK_SCOUT_TIMEOUT_MS` | `600000` | how long `ask_scout` waits for the scout's answer before returning a timeout |
| `CASEOS_MEM_GUARD` | on | `0` disables the host memory watchdog at assembly time (no interval, no listeners) |
| `CASEOS_MEM_CHECK_MS` | `15000` | host heap check interval |
| `CASEOS_READ_GUARD` | on | `0` disables the whole-file read guard (`tools/pre-execute` denial of oversized whole-file reads) |
| `CASEOS_READ_GUARD_MAX_BYTES` | `2097152` (2MiB) | largest file a whole-file read may touch; larger targets are denied with a segment-read prompt |
| `CASEOS_READ_GUARD_ALLOW` | empty | comma-separated path prefixes the read guard always allows (`~` expanded, directory-boundary matching) |
| `CASEOS_MEM_SOFT_BYTES` | ceiling × 60% | soft heap threshold: non-blocking release hint to the leader + pruning of the plugin's own indexes (2.4GiB on a 4GiB ceiling) |
| `CASEOS_MEM_HARD_BYTES` | ceiling × 80% | hard heap threshold: idle-state `mem-guard-skip` + restart prompt, never an exit (3.2GiB on a 4GiB ceiling) |
| `CASEOS_HOST_WATCHDOG` | on | `0` disables the out-of-process watchdog child (no fork, no heartbeat) |
| `CASEOS_WATCHDOG_SAMPLE_MS` | `5000` | child sampling interval (parent RSS via `ps -o rss= -p <ppid>`) |
| `CASEOS_WATCHDOG_STALL_MS` | `10000` | heartbeat silence that counts as a stalled host event loop |
| `CASEOS_WATCHDOG_SURGE_BYTES` | `536870912` (512MiB) | RSS growth inside 30s that records `host-mem-surge` |
| `CASEOS_WATCHDOG_RSS_ALERT_BYTES` | `2791728742` (2.6GiB) | first RSS crossing that records `host-mem-surge` (`rss-alert`) |
| `CASEOS_WATCHDOG_RESTART_MS` | `2000` | base delay for re-forking the child; retry n waits n× this |
| `CASEOS_EVICT` | on | `0` disables the subagent-release gate at assembly time (no `agents.resume` wrapper, no telemetry scan, no `release_subagent` tool, no events) |
| `CASEOS_EVICT_SCAN_MS` | `60000` | telemetry scan interval; the scan only reports the releasable-child count, it never releases anything |

### Monitor events

`kind` values in `~/.dsh/verispring-monitor.jsonl`: `subagent-start` / `subagent-start-failed` / `subagent-end` / `subagent-error` (lifecycle + role + route), `child-route-updated`, `role-route-mismatch`, `scout-unreachable`, `scout-tools-restricted` (scout child id; its `edit`/`write` were restricted on `agent/created`), `dispatch-deny` (with `rule`: `scout-missing`, `brief-lint`, `map-baseline-missing`, `map-stale`, `executor-cap`), `gate-deny` (dispatch spec / resident-scout / missing-map denials, plus codestyle and manon), `leader-guard-deny` (with `rule`: `sleep-in-loop`, `sleep-long`, `sleep-background`, `list-agents-repeat`), `leader-write-hint` (with `rule`: `write-whitelist`, `git-mutation`, `package-mutation`, `in-place-edit`, `recursive-remove`, `workspace-redirect` — non-blocking leader write hints), `ask-scout`, `structure-forward`, `checkpoint-saved` / `checkpoint-save-failed` / `checkpoint-injected` / `checkpoint-inject-failed`, `scout-relay-error`, `mem-guard-boot` (activation self-report: `heapLimitBytes`, `nodeArgv`, `pid`, `softBytes`, `hardBytes`, `thresholdsSource`, `checkMs`, `readGuard`, `readGuardMaxBytes`), `mem-guard-recycle` / `mem-guard-skip` (heap watchdog: `heapUsed`, `released`, `reason`), `mem-guard-read-deny` (whole-file read guard: `tool`, `session`, `path`, `size`), `mem-guard-sample` (a 5-minute `heapUsed` / `rss` / `heapLimitBytes` growth curve), `mem-guard-soft` (soft-threshold heartbeat, rate-limited to 5 minutes), `mem-guard-release-hint` (non-blocking leader hint after a tool result while over the soft threshold: `session`, `heapUsed`, `softBytes`, `candidates`), `mem-guard-release` (leader-requested subagent release: `caller`, `child`, `mode`: `drain` / `dispose` / `noop` / `refused`, `reason`, `heapUsedBefore`, `heapUsedAfter`), `mem-guard-evict-boot` (release gate self-report at apply time: `scanMs`, `tracked`, `untracked`, `releaseTool`, `subagentProbe`), `mem-guard-evict-tool` (final tool-registration state: `tool`, `registered`, `via`: `root` / `inject`, `elapsedMs`), `mem-guard-evict-follow` (follow-wrapper install: `source`, `preexistingFollowers`, `elapsedMs`), `mem-guard-evict-scan` (5-minute telemetry: `tracked`, `candidates`, `resident`, `followerTotal`, `followerTracked`, `followerUntracked`, `followerProbe`, `subagentProbe`, `heapUsed`), `mem-guard-evict-skip` (`reason`: `scan-failed`), `host-watchdog-boot` (child start self-report: `pid`, `ppid`, `execPath`, `electron`, `sampleMs`, `stallMs`, `surgeBytes`, `rssAlertBytes`), `host-stall` / `host-stall-tick` / `host-stall-end` (blocked host event loop: stalled ms, last heartbeat `seq` / `heapUsed`, RSS curve, recovery duration + peak RSS), `host-mem-surge` (`reason`: `rss-surge` / `rss-alert`, window start/end RSS, last heartbeat `heapUsed`), `host-exit` (parent died: last heartbeat age, last `heapUsed` / RSS, the last 10 RSS samples, newer `crash-*.log` names), `host-watchdog-sample` (5-minute child summary), `host-watchdog-gave-up` (3 failed re-forks).


## Memory guard

The host process never evicts an opened session by itself; without a release path a long-running host
eventually dies of an OOM. `gates/memory-guard.js` watches `process.memoryUsage()` from inside the
host (every `CASEOS_MEM_CHECK_MS`, default 15s, plus immediately on `subagent/end` and after every
tool result via `tools/post-execute` — one huge result can jump the heap between two samples):

- **Boot self-report** — on activation it appends `mem-guard-boot` to `~/.dsh/verispring-monitor.jsonl`
  with `heapLimitBytes` (`v8.getHeapStatistics().heap_size_limit`), `nodeArgv` (`process.execArgv`),
  `pid`, `softBytes` / `hardBytes`, `thresholdsSource` (`proportional` / `env`) and `checkMs`. This is
  the anchor for every claim about the ceiling: read the host's real heap limit here, not the RAM size.
- **Thresholds are a fraction of the ceiling** — soft = `floor(heapLimitBytes × 0.6)`,
  hard = `floor(heapLimitBytes × 0.8)`: 2.4GiB / 3.2GiB on a 4GiB ceiling (the old fixed band),
  4.8GiB / 6.4GiB on an 8GiB ceiling. `CASEOS_MEM_SOFT_BYTES` / `CASEOS_MEM_HARD_BYTES` override either
  side explicitly and set `thresholdsSource: "env"` (overriding one side leaves the other proportional).
  When V8 statistics are unavailable the guard falls back to a 4GiB ceiling instead of going inactive.
- **Soft threshold** — observation, not action. The plugin never releases a session on its own: it
  prunes its own append-only indexes of entries whose session is gone (recorded as
  `mem-guard-recycle`, 5-minute cooldown) and keeps the `mem-guard-soft` heartbeat. If there is
  nothing to prune it records `mem-guard-skip` (`reason: "soft-threshold-no-targets"`).
- **Release hint** — while the heap is over the soft threshold, the next tool result of a **leader**
  session gets one non-blocking `additionalContexts` entry listing the finished subagents the leader
  may release (`id`, truncated description, scout or executor) and suggesting `release_subagent`.
  It is recorded as `mem-guard-release-hint` and shown at most once per leader session per 5 minutes;
  subagent sessions never get the hint.
- **Whole-file read guard** — the burst is mostly one huge tool result landing in `Session.log`
  (the host pruner copies results over 8KB a second time), so `tools/pre-execute` checks the calls
  that dump a whole file: `read` without `offset`/`limit`, and `bash` whole-file readers (`cat`,
  `less`, `more`, `most`, `nl`, `tac`, `strings`, `xxd`, `hexdump`, `od`, `base64`, `wc`, `sed`
  unless it carries a `-n 'a,bp'` range, `tail -n +N`). A target larger than
  `CASEOS_READ_GUARD_MAX_BYTES` (default 2MiB) is denied, and the denial names the file size and
  says how to read it in segments; the hit is recorded as `mem-guard-read-deny`. `stat` failures,
  relative paths without a resolvable session cwd, and any parse ambiguity (redirections, command
  substitution, unbalanced quotes) are allowed — the guard only fires when it is certain. Root
  context listeners receive every agent's calls, so subagent sessions are covered as well.
- **Visibility** — even below the soft threshold a `mem-guard-sample` lands every 5 minutes
  (`heapUsed` / `rss` / `heapLimitBytes`), so the growth curve is visible before the cliff; a soft
  crossing records `mem-guard-soft` at the same 5-minute cadence. If a check itself hangs on a
  host-teardown await for longer than `max(2×checkMs, 60s)`, it records `mem-guard-skip`
  (`reason: "check-stuck"`) and clears `checking`, so later ticks are not silenced forever.
- **Hard threshold** — only in the idle state (no running subagent and no tool activity for 90s) it
  records `mem-guard-skip` and prints a restart prompt on stderr. It does **not** exit the host:
  `main.js` treats any host close — exit 0 included — as a failed stop and never respawns the child
  (see "Backend recycle" below for why the plugin cannot trigger one).
- `mem-guard-skip` also records the busy case, cooldown skips and recovery failures, always with
  `heapUsed` (plus `hardBytes` / `released` / `reason` where they apply).

Kill switch: `CASEOS_MEM_GUARD=0` (no interval, no listeners, no boot line — the read guard is part of
this gate, so it goes too; `CASEOS_READ_GUARD=0` turns off only the read guard).

## Host watchdog child process (out-of-process evidence)

In-process timers cannot testify while the host event loop is blocked: on the 2026-10-21 10:48 OOM
the host was stuck for 45 seconds and the 15s `mem-guard` interval wrote nothing. `gates/memory-guard.js`
therefore forks `gates/host-watchdog-child.js` at apply time — a separate node process that keeps
sampling while the host is blocked:

- IPC heartbeats every 1000ms (`seq`, `t`, `heapUsed`, `heapTotal`, `rss`), timer `unref`ed; send
  failures are silent.
- Every `CASEOS_WATCHDOG_SAMPLE_MS` (5000) the child reads the parent's RSS with
  `ps -o rss= -p <ppid>` (async, 2s timeout; macOS reports KB, stored as bytes).
- **Stall** — no heartbeat for `CASEOS_WATCHDOG_STALL_MS` (10000) while the parent is alive:
  `host-stall` once (stalled ms, last `seq` / `heapUsed`, current RSS), `host-stall-tick` every sample
  (RSS curve), and `host-stall-end` when heartbeats resume (duration + peak RSS).
- **Surge** — RSS grows by `CASEOS_WATCHDOG_SURGE_BYTES` (512MiB) inside any 30s window, or RSS first
  crosses `CASEOS_WATCHDOG_RSS_ALERT_BYTES` (2.6GiB): `host-mem-surge` with window start/end RSS and
  the latest heartbeat `heapUsed`; 60s throttle per kind.
- **Parent death** — IPC disconnect or a failed `process.kill(ppid, 0)`: `host-exit` (last heartbeat
  age, last `heapUsed` / RSS, the last 10 RSS samples) plus the names of `crash-*.log` files in
  `~/Library/Logs/DeepSeek Harness/` newer than the child's start (names only, never read), then the
  child exits — no orphan ever survives the host.
- `host-watchdog-boot` on start (pid, ppid, execPath, thresholds) and `host-watchdog-sample` every
  5 minutes (RSS / peak / stall and surge counters).

The child **never** kills, signals or restarts the host — it only records. The parent tracks the
child: if it exits unexpectedly it is re-forked at most 3 times with increasing delay
(`CASEOS_WATCHDOG_RESTART_MS`, default 2000; 1×, 2×, 3×), after which `host-watchdog-gave-up` is
written and restarts stop. `ctx.effect` teardown stops the heartbeat, disconnects IPC and `kill()`s the
child, so plugin reloads never accumulate processes. `CASEOS_HOST_WATCHDOG=0` disables it;
`CASEOS_MEM_GUARD=0` disables the whole memory guard including the child.

The host itself is the Desktop Electron binary running in node mode: the shell spawns it with
`ELECTRON_RUN_AS_NODE: "1"` (`/tmp/dsh-asar-extract/lib/main.js:245`, `:3652`, `:3794`), and the live
host confirms it (`nodeArgv: ["--expose-internals"]`). The fork therefore reuses `process.execPath`
and sets `ELECTRON_RUN_AS_NODE=1`; `mem-guard-boot` now records `execPath` and
`process.versions.electron` next to `nodeArgv`, so this can be re-verified after every restart.

Cost: one idle node child (measured: about 67MB RSS under the Electron binary in node mode, about
45MB under plain node) plus one `ps` call every 5s; with the watchdog off neither exists.

## Subagent release, decided by the leader (session-evictor)

The host keeps every promoted session resident: the session-controller promote chain drops the
`dispose` from the `{ agent, dispose }` returned by `ctx.agents.resume()`
(`dsh-api-session-controller/lib/index.js:396-403`), while the resume owner is the long-lived
controller scope (`dsh-agent/lib/index.js:466-470`) — so every followed session (including subagent
sessions in caseos workflows) would live until the host exits. This gate **does not decide
anything on its own**:

- the **main/leader session is never automatically unloaded**;
- **no subagent is automatically unloaded either** — the leader decides, per subagent, through the
  `release_subagent` tool (only the main session sees and may call it; subagent calls are refused);
- the periodic scan (`CASEOS_EVICT_SCAN_MS`, default 60s) is **pure telemetry**: it reports how many
  finished subagents the leader could release, and never calls `dispose`.

`gates/session-evictor.js` still wraps `AgentRegistry.prototype.resume` at activation: `ctx.agents`
is a cordis traceable proxy that re-reads `resume` from the prototype chain on every method access
(`cordis/lib/index.js:84-157`, `:675`, `:686`, `:763-764`), so session-controller's
`this.ctx.agents.resume` passes through the wrapper. The wrapper only records the handle on the side
and returns it unchanged — that captured handle is what `release_subagent` later disposes for
subagents that were cold-resumed. Sessions promoted before activation cannot be tracked; they are
reported in `mem-guard-evict-boot.untracked` and otherwise left alone.

`release_subagent` takes one parameter, `agent_ids: string[]`, and returns one result per id:
`released` / `not-loaded` / `refused` (with a reason), plus `heapUsedBefore` / `heapUsedAfter`.
Authorization and safety:

- the caller must be a main session (`session.header.origin !== "subagent"`); subagent callers are
  rejected and nothing is released;
- the target must be a **descendant of the caller** via the `header.parentSession` chain; a main
  session (the caller itself included) or an unrelated session is refused;
- the target must be finished: `agent.status === "idle"`, durable inbox has no pending input, the
  manager's `ChildLock.tails` has no in-flight continuation/delivery, and there is no in-flight
  `session-controller` resume/claim;
- the target must have **no live descendant** (release or reject grandchildren first — this
  implementation rejects, so a subtree is never torn down implicitly);
- no UI follow stream on the target: the `sessionController.history.follow` wrapper attributes
  active follows per session id; follows installed before the wrapper cannot be attributed and
  conservatively refuse every release while they are open (`follower-untracked`).

Refusal reasons (the `reason` field in the tool result and in `mem-guard-release`):

| Reason | Meaning |
|---|---|
| `main-session` | the target (or the caller) is a main session, not a subagent |
| `not-descendant` | the live/persisted `parentSession` chain does not reach the caller |
| `unknown-session` | neither a live/in-process header nor a persisted header exists for this id |
| `header-unreadable` | a persisted header exists but could not be read within 5s, or is corrupt/unsupported |
| `not-captured` | the agent is live, but no `dispose` handle was captured (promoted before activation) |
| `drain-parent-not-live` | the resident target's direct parent is no longer a live agent |
| `running`, `pending-inbox`, `operation-in-flight`, `subagent-operation-in-flight`, `live-descendant`, `followed`, `follower-untracked` | the target is not settled or not safe to release right now |
| `not-leader` | the caller is a subagent (the tool is leader-only) |
| `subagents-unavailable`, `still-registered`, `drain-failed: …`, `dispose-failed: …` | a host precondition disappeared or the release call failed; the target stays alive |

**Release path**: if the target is still in `subagents.manager.resident`, the gate calls the host's
`subagents.drainChildren(parent, [id])`; the host requires the **exact live direct parent**
(`dsh-subagent/lib/index.js:1372-1383`), so when the leader is the grandparent the gate uses the
activation's own direct parent, which must still be a live agent (otherwise `drain-parent-not-live`).
`drainDescendants` (`:1334`) is not used: it releases *all* descendants of a root, not one selected
grandchild. For a settled-but-loaded subagent the gate calls the captured `handle.dispose()`; a
target that is not in memory at all returns `not-loaded` (successful no-op), while a live agent
promoted before activation (no captured handle) is refused as `not-captured` rather than falsely
reported as released. Lineage for a not-in-memory target comes from its **persisted session
header**: `ctx.get("sessionPersistence").stat(id)` reads only the first line — or only the header
Zstandard frame, in bounded 8KB chunks (`dsh-session-persistence-jsonl/lib/index.js:2570-2601`,
`:3352-3403`) — and never parses the event log, promotes, or calls `observeSession`. A persisted
descendant that is not loaded is `not-loaded`; a missing header is `unknown-session`; the resolved
parent is written back to the in-process lineage memory so repeat calls do not read the file again,
and the ancestor walk is capped at 32 levels. Every attempt records
`mem-guard-release` (`caller`, `child`, `mode`: `drain` / `dispose` / `noop` / `refused`, `reason`,
`heapUsedBefore`, `heapUsedAfter`).

**What release frees**: `handle.dispose()` stops the loop, awaits idle, unwinds the scope, closes the
persistence handle and finally `detachAgent` / `detachSession`
(`dsh-agent-loop/lib/index.js:1740-1810`), so the SessionStore (`dsh-session:1886-1893`) and
AgentRegistry (`dsh-agent:544`) entries disappear. The gate also deletes the target's
`sessionQuery._observations.cache` entry when `refs === 0` (the cold-observation cache holds up to 5
sessions, `dsh-session-query/lib/index.js:327-341`) and prunes the persistence `coldLogMemo` (at most
2 entries) by session id as rebuildable cache. A released subagent that later receives
`send_message` cold-resumes through the manager's normal `coldResume → materialize → agents.resume`
path and is captured again, so nothing is lost.

The follow-attribution wrapper is installed during Host startup: `apply` tries immediately, and if
`session-controller` has not provided yet, `ctx.inject(["sessionController"], …)` installs it the
moment the service appears — before the shell's first follow. `followerProbe: "deferred"` in the
boot event means "waiting for session-controller"; the actual install is recorded by
`mem-guard-evict-follow` (`source`: `apply` / `inject` / `scan` / `release`, `preexistingFollowers`,
`elapsedMs`). Every five minutes `mem-guard-evict-scan` reports `tracked`, `candidates` (finished
subagents the leader could release right now), `resident`, `followerTotal`, `followerTracked`,
`followerUntracked`, `followerProbe`, `subagentProbe`, `heapUsed`.

Tool-registration telemetry is split on purpose: `mem-guard-evict-boot.releaseTool` is the apply-time
snapshot (it can be `false` when the `tools` service has not provided yet), while
`mem-guard-evict-tool` records the final state after either the root registration or the
`ctx.inject(["tools"], …)` fallback completes (`registered`, `via`: `root` / `inject`, `elapsedMs`).

When the heap crosses the soft threshold, the memory guard appends the non-blocking
`mem-guard-release-hint` to the leader's next tool result (see above); it lists the same candidates
and never releases anything itself.

The old `CASEOS_EVICT_IDLE_MS` env and the 50%-heap-pressure lower threshold are gone: with no
automatic release there is no idle bar to tune.

Kill switch: `CASEOS_EVICT=0` (no wrapper, no scan, no `release_subagent` tool, no events).

### Heap ceiling: 4GB is a V8 build limit — launch flags cannot move it (measured)

v2 set out to raise the ceiling to what a 128GB machine deserves. On this machine the measured answer
is that **the ceiling cannot be raised**, and the injection path is not the reason:

| Experiment (read-only, throwaway process) | Result |
|---|---|
| `ELECTRON_RUN_AS_NODE=1 "<app>" --max-old-space-size=1024/2048/3072/4095 -e 'console.log(require("v8").getHeapStatistics().heap_size_limit)'` | 1.09 / 2.09 / 3.09 / 4.09GiB, tracking the flag |
| Same with 4097 / 4352 / 4608 / 5120 / 6144 / 8192 / 12288 / 16384 / 32768 | **all 4395630592 (4.09GiB)**; old space is clamped at exactly 4096MiB |
| System node (26.11.1) with `NODE_OPTIONS=--max-old-space-size=8192` | 8.09GiB, works — the flag itself is fine |
| In-process `v8.setFlagsFromString("--max-old-space-size=8192")` | still 4.09GiB (the heap is configured when the isolate is created) |

The app bundles Electron 44.7.0 / V8 15.2 with `v8_enable_pointer_compression=1` and
`v8_enable_sandbox=1`; pointer compression hard-limits one process's V8 heap to 4GB (see Electron's
[Electron and the V8 Memory Cage](https://www.electronjs.org/blog/v8-memory-cage)). Any
`--max-old-space-size` above 4GB is silently clamped to 4096MiB, so **NODE_OPTIONS, extra spawn
arguments and even a different node binary are all ineffective** — this is a build-time property, not
a runtime knob.

The injection path itself does work (kept here for the upstream fix):
- `~/.dsh/{deepseek,manon,verispring}.env` is not read by the host at all; the host only loads
  `<DSH_HOME>/.env` and the invoking directory's `.env` (`dsh-app-boot`'s `loadLayeredEnv`), and
  `NODE_OPTIONS` is on the bootstrap-only list there, so a `.env` may not set it; even if accepted it
  is loaded inside the host process after V8 has already been configured.
- `export NODE_OPTIONS=...` in the login shell does reach the host's spawn environment: `main.js`
  reads the login-shell environment and filters it by a **blocklist** of `DSH_` / `ELECTRON_` prefixes
  only (`mergeLoginShellEnvironment`), so `NODE_OPTIONS` passes through. Electron only strips it when
  the parent process signature is not the app itself (macOS hardening); the host's parent *is* the app,
  so it is kept. The chain is live — it is just eaten by the 4GB cap.

**One-shot user verification (read-only, touches no files):**

```bash
# outputs 4395630592: 8192 is clamped to 4096MiB
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --max-old-space-size=8192 -e 'console.log(require("v8").getHeapStatistics().heap_size_limit)'

# control: plain node prints 8690597888, so the command and flag are right
node --max-old-space-size=8192 -e 'console.log(require("v8").getHeapStatistics().heap_size_limit)'
```

Every activation writes `mem-guard-boot`, so after a ⌘Q + relaunch you can check the real ceiling:

```bash
grep '"kind":"mem-guard-boot"' "${DSH_HOME:-$HOME/.dsh}/verispring-monitor.jsonl" | tail -1
```

**Why there is no "raise the ceiling" command:** because this binary cannot do it. Exceeding 4GB
requires an upstream/host-shape change: (1) rebuild Electron with `v8_enable_pointer_compression=false`
(adjusting the sandbox; Electron discourages it for memory/GC reasons); (2) shard the host into
multiple processes/isolates so each session group gets its own 4GB ceiling; or (3) fix the actual
retention — the append-only `Session.log` and the promote-on-open behavior — rather than the ceiling.

**app.asar patch (minimal diff; only useful together with a pointer-compression-free Electron build,
ineffective on its own):**

```diff
--- a/lib/main.js   DesktopHostProcess.start()
+++ b/lib/main.js
 const child = spawn(this.node, [
+  "--max-old-space-size=8192",
   "--expose-internals",
```

Risks: editing `app.asar` breaks the code signature and asar integrity (`EnableEmbeddedAsarIntegrityValidation`
refuses to start when it is on); every app update overwrites it; macOS Gatekeeper/quarantine needs a
re-sign; it is unsupported; and the measured V8 clamp still yields 4.09GiB, so the benefit is zero.
**This repository modifies nothing under /Applications.**

### Backend recycle: not reachable from a plugin (upstream ask)

The ideal would be a hard-threshold, idle-state "host recycle": respawn the host, restore sessions from
disk, and turn heap reclamation into a 1–2s invisible loop. The evidence says **no plugin-reachable seam
exists**:

- `DesktopBackendController.start()` has exactly three call sites: `reconcileBackend` at startup
  (main.js:13178 → :12313) and the update-install-failure recovery (:12283). Any host exit (exit 0
  included) → `fail` → `errorState` → `reportFatal(..., "host")` (:12254-12257) → native crash dialog;
  the dialog's Restart button is `app.relaunch()` + quit (:11844-11848): a whole-app restart, and a
  user click is required.
- The main-process IPC table (`DESKTOP_IPC`, :6981-7008) has no restart/reload channel; the host
  control protocol only carries `shutdown-complete` / `ready` / `platform-session` / `fatal` /
  `quit-inspection` / `update-tasks` (`dsh-desktop-host/lib/index.js:252-360`); the renderer
  (`client.js`) only reaches the host's HTTP/WS, not Electron main.
- v2 therefore does not implement recycle-triggered host restart; the hard threshold stays
  "monitor + stderr restart prompt".

**Upstream ask (ready to file):**

> Expose a host recycle path to the plugin/renderer layer: add e.g. a `dsh-desktop:recycle-host` IPC
> (`assertProductSender`) that runs `await backend.stop(); await backend.start(prepareHostEnvironment);
> await navigateMain(applicationUrl);` gated on the host's idle check, so a plugin inside the host
> (memory-guard) can request a warm backend restart when the V8 heap approaches its 4GB build limit.
> Today `DesktopBackendController.start()` is reachable only from startup and update-recovery, and a
> host exit only opens the fatal dialog.

## Receipts instead of polling

When a subagent finishes, DSH delivers a settlement receipt (including its closing report) into the leader's inbox and wakes the leader's turn; scout reports arrive as messages. The leader system prompt explains the discipline (end the turn after dispatching and wait for receipts; the final answer comes only after every dispatched work has been receipted and accepted), and **leader-guard enforces it at runtime**: while a child is running, `sleep`/loop waiting and a second `list_agents` in the same turn are denied, so polling is a refusal rather than a wish. The other half of the discipline — the leader's own writes and change commands — is a non-blocking hint instead of a denial, appended after the tool result (see row 8).

The bundle patch also configures the subagent tool: `backgroundMode: continuable`, `maxDepth: 1`,
and the executor persona; both presets turn `modelSelectionSettings` off on `tool-subagent`
(routes are enforced per role, so model selection has no effect, and when it is on the `subagent`
tool registers into each session's own layer where the routing wrapper cannot shadow it). The
dispatch entry uses DSH's official activation API and returns a child id immediately; use the
child continuation tools for subsequent messages. In headless/CLI runs the process exits with
the turn, so child work is not retained after the process ends.

## Context compaction (per role)

| Role | Mounted on | Trigger → summary cap |
|---|---|---|
| Main session (leader) | compaction group of the `standard` preset | 40% of the context window (~400k on a 1M window) → summary capped at 40k tokens |
| Scout/executor subagents | compaction group of the `verispring-subagent` preset | 60% of the context window (~600k) → summary capped at 60k tokens |

Both policies prune oversized tool results first (a result over 8192 characters keeps its first
4096 and last 1024), then condense the safely balanced history with DSH's structured template; no
verbatim tail is kept, and context overflow retries automatically. The summary length is chosen
by the model from a fixed template; the cap only bounds it, and real summaries usually run far shorter.

Subagents on `verispring-subagent`: the harness spawn request has no preset field and a child
inherits its parent's preset by default; dispatch-gate switches the child inside its creation
window (`agent/created`, before the first prompt) and records an `agent-preset/selected` event,
so a cold resume recomposes from the session log. The headless one-shot runner
(`dsh --profile … "<task>"`) composes no preset for the main session, so the main session does
not get the `standard` 400k policy — only a root-level `compaction-basic` if the profile enables
one; subagents are unaffected.

## Install

```bash
# Install / update (tracks main; pin a release with a tag like #v1.3.3)
dsh plugin --profile <your-profile> add github:brandonzyy/dsh-plugin-verispring

# Desktop app: Settings → Plugins → install, paste the same spec
```

The desktop app enables HMR by default (the base bundle turns it on whenever a profile
context exists), so installs initiated through the plugin manager **apply immediately** —
no restart needed. Already-running sessions keep their current tree; new sessions and new
dispatches pick up the new one. A restart is only required where HMR is explicitly disabled
(headless/SDK/ACP). Updates: uninstall and reinstall the same spec (the platform reserves
the Update button for official on-demand bundles).

## manon component (bundled)

`manon/` ships the full local code-graph CLI: the `manon-kg` entry, the
`matrixone_graph`/`codeindex`/`core` sources, and a frozen `requirements.txt`
(click/httpx/networkx/numpy/rich/PyYAML + the full tree-sitter language family — all
prebuilt wheels). Bridge resolution order: explicit `MANON_KG_BIN` > **bundled component**
(version-matched to this package) > legacy `~/manon/manon-kg`.

Indexing defaults to every mainstream language (Python/TS/TSX/JS/Java/PHP/Go/Rust/C/C++/C#/Ruby/Lua/Bash, matching the frozen tree-sitter packs) — a bare `sync` indexes all of them, with no shallow detection gating; missing packs degrade per language without crashing. `query -j` outputs a slim payload by default (compact fields, ≤40 entities, ≤60 relations, truncated descriptions/snippets); pass `--full` for the complete payload.

On first run the component bootstraps a Python venv and installs its dependencies (one-time
network, python3 ≥3.11 required), then works offline. The venv lives under
`${DSH_HOME:-~/.dsh}/manon-kg-runtime` (the installed package directory is read-only; the
runtime never writes into the package). tree-sitter language packs load
dynamically; a missing pack only downgrades that language. Keys come from
`~/.dsh/manon.env` + `~/.dsh/verispring.env`, sourced inside the bash command by the
injected invocation.

## Prerequisites (the gates tell you what is missing)

- **Profile composition**: the agent preset registry and a `preset-standard` entry (shipped by the
  desktop app and the web bundle). A bare `dsh-headless` profile has neither, and the plugin patch
  fails to load with `entry "preset-standard" not found`.
- **Spec files**: `~/.dsh/specs/子代理派遣规范.md` and `~/.dsh/specs/代码写作规范.md`
  (resolved against the home directory). Missing specs mean the corresponding gate keeps
  denying with directions — by design: every denial must be satisfiable.
- **Model route**: the profile needs a `verispring` (pi-ai) channel with a `deepseek-flash`
  model — the same channel that serves the leader's `claude-opus-5-5`; one gateway needs only
  one channel. The `deepseek-flash` entry must declare `reasoningEfforts` and
  `compat.forceAdaptiveThinking`, or pi-ai refuses to send an effort level
  (`UNSUPPORTED_REASONING_EFFORT`). The bundled `agentOptions` and `DEFAULT_ROUTES` in
  `gates/dispatch-gate.js` use the same route — keep them in sync (a saved panel wins via
  `~/.dsh/verispring.json`). For another gateway, change those two places plus the `baseURL`
  in the profile.
- **manon (optional)**: bundled — no local install needed. Keys live in `~/.dsh/manon.env`
  (`MANON_EMBEDDING_API_KEY`, sync embeddings) and `~/.dsh/verispring.env`
  (`VERISPRING_API_KEY`, deep-query fallback); the injected invocation sources both files
  itself, so model/endpoint overrides (`MANON_DEEPQUERY_*` / `MANON_EMBEDDING_*`) set there
  apply to every session. Without manon, every other gate is unaffected.

## Configuration panel (v1.3+)

After install, the bundle detail page displays the configuration directly. The panel uses
the DSH shared form controls and reads the live model catalog, so provider and model choices
stay aligned with the Models configuration. The three agent route slots are editable and apply on save; the main session uses the native DSH model picker.
While the panel has never been saved (everything at defaults), the plugin rewrites no
enforcement surface — `verispring.json` and `manon.env` keep your
native values:

| Panel field | Persisted to | Takes effect |
|---|---|---|
| Surveying/execution provider / model / effort | `~/.dsh/verispring.json` | each route is enforced by the dispatch gate; execution defaults are also written to `tool-subagent` |
| Manon Deep Query provider / model / effort | `MANON_DEEPQUERY_*` keys in `~/.dsh/manon.env` | flows into manon-kg with the sourced invocation |
| embedding endpoint / model | `MANON_EMBEDDING_*` keys in `~/.dsh/manon.env` | re-run sync after switching models |

The panel schema is built from `@deepseek-ai/schemastery`, resolved by candidate path — the
plugin's own directory, the profile directory, then the host install tree — because a `link:`
install resolves bare specifiers from the repo's real directory, and a repo without
`node_modules` would otherwise fail the whole entry's import. When none of them resolve, the
panel is unavailable (one stderr line names the missing dependency and the command that fixes
it) while routing, gates and dispatch keep working.

Writes are rooted at the Harness home (`DSH_HOME`), so multi-home/probe environments never
cross-contaminate; `manon.env` upserts only the panel-owned keys and preserves your
credential lines. The plugin ships the `verispring` `llm-pi-ai` route. Surveying and execution
each have independent provider, model, and reasoning-effort selectors. The Verispring key is
stored through DSH credentials; saving it discovers the gateway model list and refreshes the
catalog. The embedding model remains a text field.

## Model configuration guide

Three agent route slots are configurable in the plugin panel; the main session uses DSH's native model picker.

| Slot | Where | Recommendation |
|---|---|---|
| Surveying / execution agents | independently selected in the plugin panel | **DeepSeek Flash** for both by default; each route can choose its own provider, model, and effort |
| Manon Deep Query | choose the verispring provider, model, and effort in the panel; key falls back to `VERISPRING_API_KEY` | **DeepSeek Flash + off** (shipped as recommended); saving writes `~/.dsh/manon.env` and the sourced invocation uses it. |
| embedding | env: `MANON_EMBEDDING_URL` / `MANON_EMBEDDING_MODEL` / `MANON_EMBEDDING_API_KEY` (defaults to SiliconFlow `BAAI/bge-m3`) | the built-in bge-m3 is the recommendation; switching requires a re-sync to rebuild vectors |

Main-session gateway config (goes into the profile's `cordis.patch.yml`). The leader's
`claude-opus-5-5` and every `deepseek-flash` dispatch share one `verispring` channel (pi-ai) —
one gateway needs only one channel. The `deepseek-flash` entry must declare `reasoningEfforts`
and `compat.forceAdaptiveThinking`, otherwise pi-ai refuses to send an effort level
(`UNSUPPORTED_REASONING_EFFORT`). The bundled `cordis.patch.yml` already carries these
entries; override them in the profile as needed:

```yaml
- id: llm-pi-ai
  config:
    providers:
      verispring:
        displayName: Verispring
        apiKeyEnv: VERISPRING_API_KEY
        api: anthropic-messages
        baseURL: https://api.verispring.cn
        streamIdleTimeoutMs: 600000
        models:
          - id: claude-opus-5-5
            name: Claude Opus 5.5
            contextWindow: 1000000
            maxTokens: 128000
            input:
              - text
              - image
            compat:
              forceAdaptiveThinking: true
            reasoningEfforts:
              low: low
              medium: medium
              high: high
              xhigh: xhigh
              max: max
          - id: deepseek-flash
            name: deepseek-flash
            contextWindow: 1000000
            maxTokens: 256000
            input:
              - text
              - image
            reasoningEfforts:
              off: off
              low: low
              high: high
              max: max
            compat:
              forceAdaptiveThinking: true

- id: agent-default-model
  config:
    provider: verispring
    model: claude-opus-5-5
```


> **Exclusive discounts**: contact the package author — **20% off Claude, 50% off DeepSeek Flash**; WeChat: `jinyong0716`.

## Compatibility

`peerDependencies` pins `@deepseek-ai/cordis` `4.0.4 || ~4.0.5-alpha.1`, and `engines.dsh`
covers dsh 0.2.0-rc.2 through 0.2.1-rc.1. Incompatible installs are rejected up front; the official
exemption flow exists for force-installs.

## Tests and upgrade smoke check

`pnpm test` runs the three gate behavior suites and the smoke check in order:
`node scripts/test-dispatch-gate.mjs`, `node scripts/test-leader-guard.mjs`,
`node scripts/test-scout-relay.mjs`, then `pnpm smoke`. Mock suites cannot prove the host
actually loads the gates, so `pnpm smoke` after a dsh upgrade does manifest and syntax checks
and, when `DSH_BIN` and `DSH_SMOKE_PROFILE` are set, adds the official `--dump-config`
composition check against an isolated profile; that check must find the dispatch gate,
configuration entry and subagent preset.

## Dependencies and upgrade surface

- The plugin itself imports `node:fs` / `node:os` / `node:path` / `node:url` only — no npm
  runtime dependencies. The manon component freezes its Python dependencies in
  `manon/requirements.txt`.
- cordis surface in use: `ctx.tools.guard`, `ctx.on("tools/result")`, `ctx.on("agent/created")`,
  `ctx.on("subagent/end")`, `ctx.on("agent/error")`, `ctx.on("tools/pre-execute")`,
  `ctx.tools.restrict({allow/deny})`, `ctx.tools.schemas/get/register`, `ctx.systemPrompt.section`,
  `ctx.inject`, `ctx.logger.warn`.
- The manon component tracks the upstream manon repository; after upstream changes, re-test
  sync/query/deep-query as a set before updating the component here.

## Uninstall

```bash
dsh plugin --profile <your-profile> remove dsh-plugin-verispring
```

Desktop: deselect and remove on the plugins page.

## License

MIT
