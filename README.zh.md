# dsh-plugin-verispring

Verispring 三角色会话架构 + 本地知识图谱 manon，大幅度优化主会话上下文，大幅节省顶级模型API费用。
[English](README.md) | 中文

## 它强制什么

| # | 门禁 | 行为 |
|---|---|---|
| 1 | 派遣规范门 | `subagent` / `subagent_fork` 前本会话必须出现过《子代理派遣规范》内容（读结果含规范首行标记即记为已读；状态持久化在会话日志里，跨进程重启不丢） |
| 2 | scout 常驻（按可达性） | 每会话首笔派遣由运行时定为测绘（description 只是展示标签）。权威事实是**可达性**，不是 description 前缀：可达测绘还在时再派测绘一律拒绝，指路 `send_message` 复用（测绘应询结束显示 finished/inactive 属正常，`send_message` 会冷恢复它）；它真的不可达后（`end` 停止原因非 `completed`，或 `send_message` 报 unavailable），下一笔派遣自动接替为测绘并重新注入地图。子代理角色 spawn 时落盘（`session-state/<子会话id>.json`），重载后按落盘角色与标题恢复 |
| 3 | 地图前置 + 基准 | 非测绘派遣要求 `<会话工作区>/.project-map.md` 存在（`.git`/`.manon` 在场才认定项目根，否则 fail-open）；对该文件的 `write`/`edit` 成功即把当前 HEAD 登记为地图基准，HEAD 前进过基准就拒绝执行派遣（指路测绘增量校对 + 用 `write` 整文件重写登记新基准）。地图在而基准缺失同样拒绝，不再 fail-open——陈旧地图不会永久放行。仅 `CASEOS_SCOUT=0` 或读不到 HEAD 时放行 |
| 4 | 任务书闸 + 并发上限 | 执行任务书是成果描述，不是调研请求：含调研型措辞（`gates/dispatch-gate.js` 的 `BRIEF_LINT_TERMS`）即拒绝并指路 `send_message` 测绘——**带否定的说法豁免**（命中词前 6 个字符内有否定词，如「不要通读实现」「禁止先调研」）。同一领导会话里运行中的执行子代理有上限（缺省 8），超限拒绝并提示结束回合等回执。两者各有开关（`CASEOS_BRIEF_LINT=0`、`CASEOS_MAX_EXECUTORS`） |
| 5 | 模型钉死 | 路由在运行时按角色强制注入：首笔派遣走面板测绘路由，其后走执行路由；调用里显式写的 `provider`/`model` 一律忽略。`subagent_fork` 一律拒绝 |
| 6 | 提交门 | `git commit` 前必须先读 `~/.dsh/specs/代码写作规范.md`；提交形状强制 `-F 文件 -- 显式路径`，`timeout`/`env`/`nice`/`nohup`/`stdbuf` 等包装命令穿透识别 |
| 7 | 领导面限定 | 领导会话工具面收缩到复核五件（`bash`/`edit`/`write`/`read`/`read_image`）+ 派遣面（`subagent`/`send_message`/`interrupt_agent`/`list_agents`），名单与领导视图里实际存在的工具取交集（桌面工具在 preset 层，headless 在根层），派遣工具以瘦身定义遮蔽；`subagent-base` 在 root 层无条件隐藏（路由执行体异常时模型无路可绕）。测绘/执行子代理用 `verispring-subagent` preset 的全量工具面，测绘随派遣请求硬禁 `edit`/`write`。逃生开关 `CASEOS_SCOUT=0` 关闭分工条款中的测绘部分 |
| 8 | 领导守卫（leader-guard） | 两类处置。**拒绝（不变）**：有子代理运行时 `bash` 里的 `sleep`/循环等待被拒；同一回合第二次 `list_agents` 被拒。**提示（1.3.66 起）**：白名单（`.project-map.md`、路径含 `/reports/`、`~/.dsh/AGENTS.md`，外加 `CASEOS_LEADER_WRITE_ALLOW` 前缀）之外的 `edit`/`write` 与 `bash` 变更命令——`git commit/push/merge/rebase/restore/stash`（只有 `git stash list` / `git stash show` 按只读静默）、`npm`/`pnpm` 的 publish/install、`sed -i`/`perl -i`、`rm -rf`、工作区重定向——**不再拒绝**：调用照常执行，在工具结果后经宿主 `tools/post-execute` 的 `additionalContexts` 追加一次提示（「有明确边界的代码和写作任务，请交给执行子代理；领导自己只做小修正、地图、报告和验收所需的写入」），同一回合只提示一次，monitor 记 `leader-write-hint`（规则名 + 摘要）。子代理会话不受限。逃生开关 `CASEOS_LEADER_GUARD=0` |
| 9 | 测绘接力（scout-relay） | 三条原本只在提示词里的闭环：`ask_scout` 让执行者把定位/事实问题代发给常驻测绘并等它新答复（sender 取领导 Agent，`sendMessage` 按血缘授权）；非测绘子代理收尾文本里的「结构增量」段自动转给测绘；异常结束（`error`/`aborted`/`refusal`）落检查点，领导续接时由插件携现场代发。非测绘子代理另有注入的 ≤4 行定位纪律（有可达测绘指 `ask_scout`，没有则写进汇报）+ 必带的「结构增量」段。逃生开关 `CASEOS_SCOUT_RELAY=0`；`CASEOS_ASK_SCOUT_TIMEOUT_MS` 控制等待时限 |
| 10 | manon 桥接 | 解析本地图谱 CLI（`MANON_KG_BIN` > 组件自带 `manon/manon-kg` > 旧地 `~/manon/manon-kg`），存在则按角色注入：测绘拿全量（命令面、source 调用铁则、维护纪律），领导只拿"图谱事实找测绘"，执行只拿一行说明。manon 是测绘专责，领导和执行都不直接调用；语义详见 `~/.dsh/specs/Manon调用规则.md`。**承重墙是调用铁则**：dsh 子进程服务会把 KEY/TOKEN 形状的环境变量从子进程剥掉（防泄漏），直接跑 `manon-kg sync` 必报缺密钥——注入的调用式让 bash 命令先 `source ~/.dsh/manon.env` 再执行（清洗只剥第一层，孙进程自由继承）。密钥值不经过也不打印 |
| 11 | 密钥卫生 | 凭据/环境文件（`manon.env`、`verispring.env`、项目 `.env*`）禁止 read、禁止用 `cat`/`sed` 等命令输出（按命令段判定，受控 source 与 manon 输出管道不误伤）；无参数 `env`/`printenv`、`ps eww`、`/proc/*/environ`、无 `--format` 的 `docker inspect` 这类整环境倾倒一律拦截 |
| 12 | 运行监控 | 角色漂移、门禁拦截、测绘可达性变化、子代理 start/end（角色 + 路由 + 停止原因，启动成功后才记）追加落盘 `~/.dsh/verispring-monitor.jsonl`，事后审计无需解压会话日志 |

### 环境变量

| 变量 | 缺省 | 作用 |
|---|---|---|
| `CASEOS_SCOUT` | 开 | `0` 关闭分工条款中的测绘部分与地图新鲜度/基准判定 |
| `CASEOS_BRIEF_LINT` | 开 | `0` 关闭执行任务书的调研措辞拦截 |
| `CASEOS_MAX_EXECUTORS` | `8` | 每领导会话运行中执行子代理上限（`0` 等于禁止一切执行派遣）。插件上限 8 与宿主 `maxActiveSubagents` 的缺省值 8 同值（测绘也计入宿主名额），因此测绘在运行时第 8 个执行者可能被宿主以 `ACTIVATION_LIMIT_REACHED` 拒绝 |
| `CASEOS_LEADER_GUARD` | 开 | `0` 在装配时关闭领导守卫 |
| `CASEOS_LEADER_WRITE_ALLOW` | 空 | 以 `:` 分隔的额外可写路径前缀（领导 `edit`/`write`） |
| `CASEOS_SCOUT_RELAY` | 开 | `0` 不注册 `ask_scout`，且停止转交、检查点与提示注入 |
| `CASEOS_ASK_SCOUT_TIMEOUT_MS` | `600000` | `ask_scout` 等测绘答复的时限，超时返回超时文案 |

### monitor 事件

`~/.dsh/verispring-monitor.jsonl` 的 `kind`：`subagent-start` / `subagent-start-failed` / `subagent-end` / `subagent-error`（生命周期 + 角色 + 路由）、`child-route-updated`、`role-route-mismatch`、`scout-unreachable`、`dispatch-deny`（带 `rule`：`brief-lint`、`map-baseline-missing`、`map-stale`、`executor-cap`）、`gate-deny`（派遣规范门/测绘常驻/缺地图，以及 codestyle 与 manon 的拒绝）、`leader-guard-deny`（带 `rule`：`sleep-in-loop`、`sleep-long`、`sleep-background`、`list-agents-repeat`）、`leader-write-hint`（带 `rule`：`write-whitelist`、`git-mutation`、`package-mutation`、`in-place-edit`、`recursive-remove`、`workspace-redirect`——非阻断的领导写入提示）、`ask-scout`、`structure-forward`、`checkpoint-saved` / `checkpoint-save-failed` / `checkpoint-injected` / `checkpoint-inject-failed`、`scout-relay-error`。

## 回执制（不轮询）

子代理完成任务时 DSH 会把结算回执（含收尾报告）注入领导收件箱并唤醒领导回合；测绘的回报以消息直达。领导系统提示负责解释纪律（派遣后直接结束回合等回执，全部回执验收后才给最终答复），**由 leader-guard 在运行时执行**：有子代理运行时 `sleep`/循环等待、同一回合第二次 `list_agents` 都会被拒——轮询不是劝告，是拒绝。纪律的另一半——领导自己的写入与变更命令——改为非阻断提示，追加在工具结果之后（见第 8 行）。

组合包 patch 还把子代理工具配置为：`backgroundMode: continuable`（后台可续派遣，`send_message`
纠偏）、`maxDepth: 1`（不派孙代理）、执行层 persona；两个 preset 的 `tool-subagent` 关闭
`modelSelectionSettings`（路由按角色强制注入，模型选择无效；开启时 `subagent` 工具注册进每个
会话自己的层，路由包装无法遮蔽）。派遣入口使用 DSH 官方 activation API，立即返回子代理 ID；
后续消息通过子代理续接工具发送。headless/CLI 场景进程随回合退出，子代理工作不会在进程结束后保留。

## 上下文压缩（分角色）

| 角色 | 挂载位置 | 触发 → 摘要上限 |
|---|---|---|
| 主会话（领导） | `standard` preset 的 compaction 组 | 上下文窗口 40%（1M 窗口即约 400k）→ 摘要上限 40k token |
| 测绘/执行子代理 | `verispring-subagent` preset 的 compaction 组 | 上下文窗口 60%（约 600k）→ 摘要上限 60k token |

两条策略都先剪枝超大工具结果（单条超过 8192 字符保留首 4096、尾 1024），再按 DSH 结构化模板
合并可安全压缩的历史，不额外保留原文尾部；上下文溢出时自动重试。摘要长度由模型按固定模板决定，
上限只是封顶，实际摘要通常远短于上限。

子代理挂 `verispring-subagent`：harness 的 spawn 请求没有 preset 字段，子代理默认继承父会话
preset；dispatch-gate 在子代理创建窗口（`agent/created`，早于首个 prompt）把它切过去并写入
`agent-preset/selected` 事件，冷恢复时按会话记录重新组合。headless 一次性驱动器
（`dsh --profile … "<任务>"`）不为主会话组合任何 preset，主会话不吃 `standard` 的 400k 策略，
只受 profile 根层启用的 `compaction-basic`（若有）约束；子代理不受影响。

## 安装

```bash
# 安装 / 更新（跟随仓库 main；固定版本用 #v1.3.3 这类 tag）
dsh plugin --profile <你的profile> add github:brandonzyy/dsh-plugin-verispring

# 桌面版：设置 → 插件 → 安装，粘贴同一条 spec
```

桌面版默认启用 HMR（base 组合包随 profile 上下文开启），插件管理器发起的安装**即时生效**，无需重启；
已经在跑的会话保持旧组合，新会话/新派遣拿到新树。仅当 HMR 被显式禁用（如 headless/SDK/ACP）时才需要重启。
更新方式：卸载后重装同一条 spec（非官方插件的「更新」按钮按平台设计仅提供给官方按需插件）。

## manon 组件（随包分发）

`manon/` 内置本地图谱 CLI 全套：`manon-kg` 入口 + `matrixone_graph`/`codeindex`/`core`
源码 + 冻结的 `requirements.txt`（click/httpx/networkx/numpy/rich/PyYAML + tree-sitter
全语言家族，均为预编译 wheel）。桥接解析顺序：`MANON_KG_BIN` 显式指路 > **组件自带**
（与本包版本配对）> 旧地 `~/manon/manon-kg`（历史本机安装）。

索引默认即全主流语言（Python/TS/TSX/JS/Java/PHP/Go/Rust/C/C++/C#/Ruby/Lua/Bash，与冻结
的 tree-sitter 包一一对应），不依赖浅层语言检测——任何仓开箱 `sync` 就是全语言索引；
缺包语言自动降级不崩。`query -j` 默认瘦身输出（紧凑字段，实体 ≤40 条、关系 ≤60 条、
描述/代码片段截断），全量 payload 加 `--full`。

组件版首次运行自举 Python venv 并装依赖（一次性联网，需 python3 ≥3.11），此后离线可用；
venv 落在 `${DSH_HOME:-~/.dsh}/manon-kg-runtime`（安装包目录只读，运行环境不入包）。
tree-sitter 语言包按需动态加载，缺包只降级该语言不崩。密钥沿用 `~/.dsh/manon.env` +
`~/.dsh/verispring.env`，由注入的调用式在 bash 命令内 source。

## 前置约定（不满足时门禁会告诉你缺什么）

- **profile 组合**：需含 agent preset 注册表与 `preset-standard`（桌面版 / web 组合包自带）。
  纯 `dsh-headless` profile 没有这一条目，插件 patch 加载即报 `entry "preset-standard" not found`。
- **规范文件**：`~/.dsh/specs/子代理派遣规范.md` 与 `~/.dsh/specs/代码写作规范.md`（路径按
  主目录解析）。缺规范时对应门禁会持续拦截并指路——这是特性：拒绝必须可满足。
- **模型路由**：profile 需有 `verispring-ds` provider 及 `deepseek-flash` 模型，由包内
  `cordis.patch.yml` 的 `verispring-deepseek` 条目经本插件的 `deepseek-gateway` 注册
  （复用 `dsh-llm-deepseek` 的适配器，这样思考档位才会以 `output_config.effort` 发出）。
  `gates/dispatch-gate.js` 的 `DEFAULT_ROUTES` 与包内 `agentOptions` 同为此路由，两处保持一致
  （面板保存后以 `~/.dsh/verispring.json` 为准）。换网关时改这两处 + 插件的 `baseURL`。
- **manon（可选）**：组件自带，无需本机安装；密钥放 `~/.dsh/manon.env`
  （`MANON_EMBEDDING_API_KEY`，sync 的向量嵌入）与 `~/.dsh/verispring.env`
  （`VERISPRING_API_KEY`，deep-query 缺省回退）——注入的调用式会自行 source 这两个文件，
  模型/端点的环境变量覆盖（`MANON_DEEPQUERY_*` / `MANON_EMBEDDING_*`）也写在这里即随会话生效。
  不用 manon 时包内其余门禁不受影响。

## 配置面板（v1.3+）

安装后组合包详情页直接显示配置。面板使用 DSH 共用表单控件并读取实时模型目录，渠道和模型选项与模型设置保持一致，保存即生效。面板从未保存（全部取默认）时插件不改写任何执法面——`verispring.json`、`manon.env` 里的原生配置不被默认值覆盖：

| 面板字段 | 落盘位置 | 生效方式 |
|---|---|---|
| 测绘/执行智能体渠道 / 模型 / 思考强度 | `~/.dsh/verispring.json` | 两套路由分别由派遣门禁执法；执行路由同时写回 tool-subagent 默认值 |
| Manon Deep Query 渠道 / 模型 / 思考强度 | `~/.dsh/manon.env` 的 `MANON_DEEPQUERY_*` | 随注入调用式 source 进 manon-kg |
| embedding 端点 / 模型 | `~/.dsh/manon.env` 的 `MANON_EMBEDDING_*` | 更换模型后需重新 sync 重建向量 |

面板 schema 依赖 `@deepseek-ai/schemastery`，按候选路径解析——插件自身目录、profile 目录、宿主安装树。`link:` 安装时裸标识符会从仓库真目录解析，仓库没有 `node_modules` 就会让整条目 import 失败；三处都解析不到时只降级面板（stderr 一行给出缺失依赖与修复命令），路由、门禁与派遣照常工作。

写入根为 Harness home（`DSH_HOME`），多 home / 探针环境互不串扰；`manon.env` 只 upsert 面板键，用户凭据行原样保留。测绘智能体和执行智能体分别选择渠道、模型、思考强度；Verispring key 通过 DSH 凭据库保存，保存后自动发现网关模型目录并刷新选项，embedding 模型保留文本输入。

## 模型配置建议

三个智能体路由位在插件面板配置；主会话使用 DSH 原生模型选择器。

| 模型位 | 配置处 | 建议 |
|---|---|---|
| 测绘智能体 / 执行智能体 | 插件面板分别选择 | 默认都用 **DeepSeek Flash**；两套路由可独立选择渠道、模型和思考强度 |
| Manon Deep Query | 面板选择 verispring 渠道、模型、思考强度；密钥回退 `VERISPRING_API_KEY` | **DeepSeek Flash + off**（出厂即推荐）；保存后写入 `~/.dsh/manon.env`，随注入调用式生效。 |
| embedding | 环境变量：`MANON_EMBEDDING_URL` / `MANON_EMBEDDING_MODEL` / `MANON_EMBEDDING_API_KEY`（默认硅基流动 `BAAI/bge-m3`） | 内置 bge-m3 即推荐；更换需重新 sync 重建向量 |

主会话的网关配置（放进 profile 的 `cordis.patch.yml`）。`verispring` = 领导面
`claude-opus-5-5`（pi-ai，自适应思考）；`verispring-ds` = 全部 `deepseek-flash` 派遣，
由本包 `cordis.patch.yml` 里的 `verispring-deepseek` 条目经 `deepseek-gateway` 注册
（内部复用 `dsh-llm-deepseek`，思考档位才会以 `output_config.effort` 发出）。这条 insert
随包自带，profile **不要再 insert 一次**（同 id 会冲突），只需要 profile 侧提供
`llm-pi-ai` 的 `verispring` 渠道：

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

- id: agent-default-model
  config:
    provider: verispring
    model: claude-opus-5-5
```

网关 anthropic 出口在「thinking 开 + 短回复」时会重复发一条 `message_start`；
`llm-deepseek` 会判 `MALFORMED_RESPONSE` 直接失败（走 pi-ai 时看不出来，它只更新 usage）。
网关修好之前，包内 `verispring-deepseek` 条目默认带 `dedupeDuplicateMessageStart: true`：
只丢弃该端点的重复 `message_start` 帧，其余逐帧透传。网关修复上线并复测后删掉该开关。

> **专属优惠**：找插件发布包作者领取——**Claude 8 折，DeepSeek Flash 5 折**；微信：`jinyong0716`。

## 兼容性

`peerDependencies` 钉 `@deepseek-ai/cordis` `4.0.4 || ~4.0.5-alpha.1`，`engines.dsh` 覆盖
dsh 0.2.0-rc.2 至 0.2.1-rc.1。版本不满足时安装被拒；确要强装走官方豁免流程
（`dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <runtime> --accept-risk`）。

## 测试与升级检查

`pnpm test` 依次跑三个门禁行为测试与冒烟：`node scripts/test-dispatch-gate.mjs`、
`node scripts/test-leader-guard.mjs`、`node scripts/test-scout-relay.mjs`，再跑 `pnpm smoke`。
mock 测试证明不了真实宿主装载门禁，所以升级 dsh 后跑 `pnpm smoke` 检查版本声明、源码语法与
插件入口；设置 `DSH_BIN` 与 `DSH_SMOKE_PROFILE` 后会再执行官方 `--dump-config` 组合检查，
确认派遣门禁、配置入口和子代理 preset 均已装配。

## 依赖与升级边界

- 插件本体只 import `node:fs` / `node:os` / `node:path` / `node:url`，零 npm 第三方依赖；
  manon 组件的 Python 依赖冻结在 `manon/requirements.txt`。
- 依赖的 cordis 表面：`ctx.tools.guard`、`ctx.on("tools/result")`、`ctx.on("agent/created")`、
  `ctx.on("subagent/end")`、`ctx.on("agent/error")`、`ctx.on("tools/pre-execute")`、
  `ctx.tools.restrict({allow/deny})`、`ctx.tools.schemas/get/register`、`ctx.systemPrompt.section`、
  `ctx.inject`、`ctx.logger.warn`。上游改这些签名时本包需要适配。
- manon 组件与上游 manon 仓库同源；上游改动后整组重测 sync/query/deep-query 再更新本包。

## 卸载

```bash
dsh plugin --profile <你的profile> remove dsh-plugin-verispring
```

桌面版在插件页取消选择并删除。卸载即回到无门禁状态（会话内已注入的系统提示条款随新会话消失）。

## License

MIT
