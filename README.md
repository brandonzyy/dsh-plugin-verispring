# dsh-plugin-verispring

Verispring three-role session architecture plus a bundled local knowledge graph (manon), substantially improving main-session context and reducing premium model API costs.
[中文](README.zh.md) | English

## What it enforces

| # | Gate | Behavior |
|---|---|---|
| 1 | Dispatch spec gate | `subagent` / `subagent_fork` requires the dispatch spec content to have appeared in the session (a read result containing the spec's first-line marker; state is persisted in the session log and survives restarts) |
| 2 | Resident scout | The first dispatch of a session is pinned to the scout role at runtime (`description` is a display label only); once resident, repeats are denied with a `send_message` reuse pointer; escape hatch `touch /tmp/dsh-caseos-scout-reset-<pid>` (path is in the denial), and the reset is persisted too |
| 3 | Map first | Non-scout dispatch requires `<session workspace>/.project-map.md` (project root = `.git`/`.manon` present; otherwise fail-open) |
| 4 | Pinned model | Routes are enforced at runtime per role: the first dispatch uses the panel's scout route, later ones the executor route; explicit `provider`/`model` on the call is ignored. `subagent_fork` is always denied |
| 5 | Commit gate | `git commit` requires a prior read of `~/.dsh/specs/代码写作规范.md` |
| 6 | Leader scope | The leader's tool face shrinks to the review five (`bash`/`edit`/`write`/`read`/`read_image`) plus the dispatch face (`subagent`/`send_message`/`interrupt_agent`/`list_agents`), intersected with the tools that actually exist in the leader's view (desktop serves them from the preset layer, headless from the root layer); dispatch tools are shadowed by slim definitions. Scout and executor subagents get the full face of the `verispring-subagent` preset, and scouts are hard-denied `edit`/`write` through the dispatch request. Kill switch `CASEOS_SCOUT=0` drops the scout part of the division clause |
| 7 | manon bridge | Resolves the local graph CLI (`MANON_KG_BIN` > bundled `manon/manon-kg` > legacy `~/manon/manon-kg`) and, when present, injects a concise usage section: command surface, store location, scout ownership, semantics in `~/.dsh/specs/Manon调用规则.md`. **The load-bearing part is the invocation rule**: dsh's subprocess service strips KEY/TOKEN-shaped env vars from children (anti-leak), so a bare `manon-kg sync` always fails with a missing key — the injected form sources `~/.dsh/manon.env` inside the bash command first (the scrub only strips the first hop; grandchildren inherit freely). Secret values never pass through or get printed |

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
- **Model route**: the profile needs a `verispring` provider with a `deepseek-flash`
  model (via `llm-pi-ai` or an equivalent adapter). For another gateway, update
  `agentOptions` in `cordis.patch.yml` and `DEFAULT_ROUTES` in
  `gates/dispatch-gate.js`, keeping the two in sync (a saved panel wins via `~/.dsh/verispring.json`).
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

Minimal main-session + gateway config (goes into the profile's `cordis.patch.yml`; pairs with
the plugin-pinned `verispring`/`deepseek-flash` route):

```yaml
- id: llm-pi-ai
  config:
    providers:
      verispring:
        displayName: Verispring
        apiKeyEnv: VERISPRING_API_KEY
        api: anthropic-messages
        baseURL: https://api.verispring.cn
        models:
          - id: claude-opus-5-5
            name: Claude Opus 5.5
            contextWindow: 1000000
            maxTokens: 128000
            compat:
              forceAdaptiveThinking: true
            reasoningEfforts:
              low: low
              medium: medium
              high: high
              xhigh: xhigh
              max: max
          - id: deepseek-flash
            name: DeepSeek Flash
            contextWindow: 1000000
            maxTokens: 384000
            reasoningEfforts:
              'off': null
              low: low
              high: high
              max: max
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

## Upgrade smoke check

Run `pnpm smoke` after a dsh upgrade for manifest and syntax checks. Set `DSH_BIN` and
`DSH_SMOKE_PROFILE` to add an official `--dump-config` composition check against an isolated
profile; the check must find the dispatch gate, configuration entry and subagent preset.

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
