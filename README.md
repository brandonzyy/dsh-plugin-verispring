# dsh-plugin-verispring

A three-role session architecture plugin (leader — scout — executor) with a bundled local
knowledge graph (manon). The main session keeps the premium model but never reads the codebase
itself; the heavy work runs on DeepSeek Flash and the main-session context stays clean — which
cuts premium model API costs substantially.

*leader dispatches → scout maps the repo and answers facts → executor builds → receipt back to the leader*

[中文](README.zh.md) | English

## What it does

### Three-role division, enforced by dispatch discipline

The leader plans, dispatches and reviews. A resident scout owns the repository map and touches code
read-only; executors write code and run commands. The role comes from the dispatch itself, an
executor dispatch is refused while no scout is reachable, and executors start only once the map
exists and is fresh. Briefs go straight to the child and results come back as settlement receipts,
so the main session is never polluted by raw exploration. The manon graph is scout-owned — leaders
and executors never invoke it directly; they ask the scout. Running executors per leader session are
capped (default 8), so a dispatch fan-out cannot turn into a crowd.

### Model division that saves money

The main session runs the premium model (Claude Opus 5.5 by default); scouts and executors default
to DeepSeek Flash. The route is enforced at runtime per role — a provider/model passed on the
dispatch call is ignored — so the cheap route cannot be slipped past. Both agent routes are picked in
the plugin panel; the main session uses DSH's native model picker.

### Cache cost defense

Tool definitions and system sections are frozen per session, so new copy shipped in a release never
rewrites the prompt prefix of a session already running. Compaction is per role: the main session at
40% of its window, subagents at 60%. A main session that has been idle for 55 minutes with more than
50K tokens is compacted once — flattening the large cache write that follows an expired cache TTL.
The accepted cost: oversized tool results stay in context until a compaction summarises them.

### Memory and host guards

Heap thresholds warn and prune the plugin's own indexes long before the cliff; an out-of-process
watchdog keeps sampling while the host event loop is stuck; an oversized whole-file read is refused
with a segmented-read hint; and the leader can release finished subagents to hand memory back. The
host is never killed behind your back — the hard threshold only records a restart prompt.

### Secret hygiene

Credential files (`manon.env`, `verispring.env`, project `.env*`) cannot be read or echoed, and
whole-environment dumps are refused. Key values never reach a session log.

### Observability

Role drift, gate denials, dispatches, releases and memory events all land in
`~/.dsh/verispring-monitor.jsonl`, so audits no longer require decompressing session logs.

### Kill switches

The gates are controlled by environment variables (`CASEOS_*`), so any of them can be turned off —
one at a time or all together — without uninstalling anything: e.g. `CASEOS_MEM_GUARD=0` disables the
memory guard and its watchdog, `CASEOS_SCOUT=0` drops the scout part of the division clause.

## Install

```bash
# Install / update (tracks main; pin a release with a tag like #v1.3.3)
dsh plugin --profile <your-profile> add github:brandonzyy/dsh-plugin-verispring

# Desktop app: Settings → Plugins → install, paste the same spec
```

The desktop app enables HMR, so an install through the plugin manager applies immediately — no
restart needed. Already-running sessions keep their current tree; new sessions and dispatches pick up
the new one. Only setups with HMR disabled (headless/SDK/ACP) need a restart. To update, uninstall
and reinstall the same spec.

**Prerequisites** — the profile needs the agent preset registry and a `preset-standard` entry
(desktop and web bundles ship them); `~/.dsh/specs/子代理派遣规范.md` and
`~/.dsh/specs/代码写作规范.md` must exist (the gates keep denying with directions otherwise); the
`verispring` channel must serve the leader model and a `deepseek-flash` entry that declares
`reasoningEfforts` and `compat.forceAdaptiveThinking`. manon is bundled and optional: it bootstraps a
Python venv on first run (one-time network, python3 ≥3.11), with keys in `~/.dsh/manon.env` and
`~/.dsh/verispring.env`.

> **Exclusive discounts**: contact the package author — **20% off Claude, 50% off DeepSeek Flash**;
> WeChat: `jinyong0716`.

## Test

`npm test` runs the gate behavior suites plus the smoke check (`npm run smoke`). Mock suites cannot
prove the host really loads the gates, so after a dsh upgrade run `npm run smoke` on its own: it
checks the manifest, the syntax and the plugin entry, and with `DSH_BIN` and `DSH_SMOKE_PROFILE` set
it adds the official `--dump-config` composition check against an isolated profile.

## License

MIT
