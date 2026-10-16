# dsh-plugin-verispring

Code-level enforcement of the dsh three-role session architecture (leader / resident scout / executor), plus a bundled local code-graph (manon) component, packaged as a dsh bundle.
[中文](README.zh.md) | English

## What it enforces

| # | Gate | Behavior |
|---|---|---|
| 1 | Dispatch spec gate | `subagent` / `subagent_fork` requires a prior read of `~/.dsh/specs/子代理派遣规范.md` (result text marker or argument path match; per-session state) |
| 2 | Resident scout | One `scout`-prefixed dispatch per session; repeats are denied with a `send_message` reuse pointer; escape hatch `touch /tmp/dsh-caseos-scout-reset-<pid>` (path is in the denial) |
| 3 | Map first | Non-scout dispatch requires `<cwd>/.project-map.md` (project root = `.git`/`.manon` present; otherwise fail-open) |
| 4 | Pinned model | Explicit `provider`/`model` on `subagent` must be `verispring`/`deepseek-flash`; omitting fields falls back to the pinned default route |
| 5 | Commit gate | `git commit` requires a prior read of `~/.dsh/specs/代码写作规范.md` |
| 6 | Leader scope | Leader tool face shrinks to 10 slim tools; executors get the full face back; scouts are hard-denied `edit`/`write`. Kill switch `CASEOS_SCOUT=0` |
| 7 | manon bridge | Resolves the local graph CLI (`MANON_KG_BIN` > bundled `manon/manon-kg` > legacy `~/manon/manon-kg`) and, when present, injects a concise usage section: command surface, store location, scout ownership, semantics in `~/.dsh/specs/Manon调用规则.md`. **The load-bearing part is the invocation rule**: dsh's subprocess service strips KEY/TOKEN-shaped env vars from children (anti-leak), so a bare `manon-kg sync` always fails with a missing key — the injected form sources `~/.dsh/manon.env` inside the bash command first (the scrub only strips the first hop; grandchildren inherit freely). Secret values never pass through or get printed |

The bundle patch also configures the subagent tool: `backgroundMode: continuable`, `maxDepth: 1`,
executor persona, and default route `verispring`/`deepseek-flash`.

## Install

```bash
# Preferred: registry install (version-pinned; mainland China resolves via the built-in
# npmmirror fallback automatically)
dsh plugin --profile <your-profile> add dsh-plugin-verispring

# Fallback: install straight from GitHub (tracks the repo, no registry involved)
dsh plugin --profile <your-profile> add github:brandonzyy/dsh-plugin-verispring

# Desktop app: Settings → Plugins → install, paste either spec
```

Without HMR, running compositions keep their current tree; new sessions pick it up. The
desktop app needs a restart.

## manon component (bundled)

`manon/` ships the full local code-graph CLI: the `manon-kg` entry, the
`matrixone_graph`/`codeindex`/`core` sources, and a frozen `requirements.txt`
(click/httpx/networkx/numpy/rich/PyYAML + the full tree-sitter language family — all
prebuilt wheels). Bridge resolution order: explicit `MANON_KG_BIN` > **bundled component**
(version-matched to this package) > legacy `~/manon/manon-kg`.

On first run the component bootstraps a Python venv and installs its dependencies (one-time
network, python3 ≥3.11 required), then works offline. tree-sitter language packs load
dynamically; a missing pack only downgrades that language. Keys come from
`~/.dsh/manon.env` + `~/.dsh/verispring.env`, sourced inside the bash command by the
injected invocation.

## Prerequisites (the gates tell you what is missing)

- **Spec files**: `~/.dsh/specs/子代理派遣规范.md` and `~/.dsh/specs/代码写作规范.md`
  (resolved against the home directory). Missing specs mean the corresponding gate keeps
  denying with directions — by design: every denial must be satisfiable.
- **Model route**: the profile needs a `verispring` provider with a `deepseek-flash`
  model (via `llm-pi-ai` or an equivalent adapter). For another gateway, update
  `agentOptions` in `cordis.patch.yml` and `PIN_PROVIDER`/`PIN_MODEL` in
  `gates/dispatch-gate.js`, keeping the two in sync.
- **manon (optional)**: bundled — no local install needed. Keys live in `~/.dsh/manon.env`
  (`MANON_EMBEDDING_API_KEY`, sync embeddings) and `~/.dsh/verispring.env`
  (`VERISPRING_API_KEY`, deep-query); the injected invocation sources both files itself.
  Without manon, every other gate is unaffected.

## Compatibility

`peerDependencies` pins `@deepseek-ai/cordis` `4.0.4 || ~4.0.5-alpha.1` — covering dsh
0.2.0-rc.2 and 0.2.1-alpha.2. Incompatible installs are rejected up front; the official
exemption flow exists for force-installs.

## Dependencies and upgrade surface

- The plugin itself imports `node:fs` / `node:os` / `node:path` / `node:url` only — no npm
  runtime dependencies. The manon component freezes its Python dependencies in
  `manon/requirements.txt`.
- cordis surface in use: `ctx.tools.guard`, `ctx.on("tools/result")`, `ctx.on("agent/created")`,
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
