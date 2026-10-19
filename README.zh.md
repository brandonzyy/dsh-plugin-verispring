# dsh-plugin-verispring

Verispring 三角色会话架构 + 本地知识图谱 manon，大幅度优化主会话上下文，大幅节省顶级模型API费用。
[English](README.md) | 中文

## 它强制什么

| # | 门禁 | 行为 |
|---|---|---|
| 1 | 派遣规范门 | `subagent` / `subagent_fork` 前本会话必须出现过《子代理派遣规范》内容（读结果含规范首行标记即记为已读；状态持久化在会话日志里，跨进程重启不丢） |
| 2 | scout 常驻 | 每会话首笔派遣由运行时定为测绘（description 只是展示标签）；测绘常驻后重复派遣拒绝，指路 `send_message` 复用；逃生口 `touch /tmp/dsh-caseos-scout-reset-<pid>`（拒绝信息里带路径），重置动作同样持久化。子代理角色 spawn 时落盘（`session-state/<子会话id>.json`），重载后按落盘角色与标题恢复，测绘不再被静默重归类为执行 |
| 3 | 地图前置 + 新鲜度 | 非测绘派遣要求 `<会话工作区>/.project-map.md` 存在（`.git`/`.manon` 在场才认定项目根，否则 fail-open）；且 main 自上次地图登记后又前进过时拒绝执行派遣，指路测绘增量校对 + 重写地图登记新基准（`write` 该文件即登记当前 HEAD；首建前与 `CASEOS_SCOUT=0` 时 fail-open） |
| 4 | 模型钉死 | 路由在运行时按角色强制注入：首笔派遣走面板测绘路由，其后走执行路由；调用里显式写的 `provider`/`model` 一律忽略。`subagent_fork` 一律拒绝 |
| 5 | 提交门 | `git commit` 前必须先读 `~/.dsh/specs/代码写作规范.md`；提交形状强制 `-F 文件 -- 显式路径`，`timeout`/`env`/`nice`/`nohup`/`stdbuf` 等包装命令穿透识别 |
| 6 | 领导面限定 | 领导会话工具面收缩到复核五件（`bash`/`edit`/`write`/`read`/`read_image`）+ 派遣面（`subagent`/`send_message`/`interrupt_agent`/`list_agents`），名单与领导视图里实际存在的工具取交集（桌面工具在 preset 层，headless 在根层），派遣工具以瘦身定义遮蔽；`subagent-base` 在 root 层无条件隐藏（路由执行体异常时模型无路可绕）。测绘/执行子代理用 `verispring-subagent` preset 的全量工具面，测绘随派遣请求硬禁 `edit`/`write`。逃生开关 `CASEOS_SCOUT=0` 关闭分工条款中的测绘部分 |
| 7 | manon 桥接 | 解析本地图谱 CLI（`MANON_KG_BIN` > 组件自带 `manon/manon-kg` > 旧地 `~/manon/manon-kg`），存在则按角色注入：测绘拿全量（命令面、source 调用铁则、维护纪律），领导只拿"图谱事实找测绘"，执行只拿一行说明。manon 是测绘专责，领导和执行都不直接调用；语义详见 `~/.dsh/specs/Manon调用规则.md`。**承重墙是调用铁则**：dsh 子进程服务会把 KEY/TOKEN 形状的环境变量从子进程剥掉（防泄漏），直接跑 `manon-kg sync` 必报缺密钥——注入的调用式让 bash 命令先 `source ~/.dsh/manon.env` 再执行（清洗只剥第一层，孙进程自由继承）。密钥值不经过也不打印 |
| 8 | 密钥卫生 | 凭据/环境文件（`manon.env`、`verispring.env`、项目 `.env*`）禁止 read、禁止用 `cat`/`sed` 等命令输出（按命令段判定，受控 source 与 manon 输出管道不误伤）；无参数 `env`/`printenv`、`ps eww`、`/proc/*/environ`、无 `--format` 的 `docker inspect` 这类整环境倾倒一律拦截 |
| 9 | 运行监控 | 角色漂移、门禁拦截、scout 重置、子代理 start/end（角色 + 路由 + 停止原因）追加落盘 `~/.dsh/verispring-monitor.jsonl`，事后审计无需解压会话日志 |

## 回执制（不轮询）

子代理完成任务时 DSH 会把结算回执（含收尾报告）注入领导收件箱并唤醒领导回合；测绘的回报以消息直达。领导系统提示已改为：派遣后直接结束回合等回执，禁止 sleep 循环、占位子代理或反复 `list_agents` 轮询；全部回执验收后才给最终答复。

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
- **模型路由**：profile 需有 `verispring` provider 及 `deepseek-flash` 模型
  （经 `llm-pi-ai` 或等价适配器配置）。换网关时改包内 `cordis.patch.yml` 的 `agentOptions`
  与 `gates/dispatch-gate.js` 的 `DEFAULT_ROUTES`，两处保持一致（面板保存后以 `~/.dsh/verispring.json` 为准）。
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

写入根为 Harness home（`DSH_HOME`），多 home / 探针环境互不串扰；`manon.env` 只 upsert 面板键，用户凭据行原样保留。测绘智能体和执行智能体分别选择渠道、模型、思考强度；Verispring key 通过 DSH 凭据库保存，保存后自动发现网关模型目录并刷新选项，embedding 模型保留文本输入。

## 模型配置建议

三个智能体路由位在插件面板配置；主会话使用 DSH 原生模型选择器。

| 模型位 | 配置处 | 建议 |
|---|---|---|
| 测绘智能体 / 执行智能体 | 插件面板分别选择 | 默认都用 **DeepSeek Flash**；两套路由可独立选择渠道、模型和思考强度 |
| Manon Deep Query | 面板选择 verispring 渠道、模型、思考强度；密钥回退 `VERISPRING_API_KEY` | **DeepSeek Flash + off**（出厂即推荐）；保存后写入 `~/.dsh/manon.env`，随注入调用式生效。 |
| embedding | 环境变量：`MANON_EMBEDDING_URL` / `MANON_EMBEDDING_MODEL` / `MANON_EMBEDDING_API_KEY`（默认硅基流动 `BAAI/bge-m3`） | 内置 bge-m3 即推荐；更换需重新 sync 重建向量 |

主会话 + 网关最小配置（放进 profile 的 `cordis.patch.yml`；与插件钉死的 `verispring`/`deepseek-flash` 路由配套）：

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

> **专属优惠**：找插件发布包作者领取——**Claude 8 折，DeepSeek Flash 5 折**；微信：`jinyong0716`。

## 兼容性

`peerDependencies` 钉 `@deepseek-ai/cordis` `4.0.4 || ~4.0.5-alpha.1`，`engines.dsh` 覆盖
dsh 0.2.0-rc.2 至 0.2.1-rc.1。版本不满足时安装被拒；确要强装走官方豁免流程
（`dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <runtime> --accept-risk`）。

升级 dsh 后运行 `pnpm smoke`，它检查版本声明、源码语法和插件入口。设置 `DSH_BIN` 与
`DSH_SMOKE_PROFILE` 后，会再执行官方 `--dump-config` 组合检查，确认派遣门禁、配置入口和子代理 preset 均已装配。

## 依赖与升级边界

- 插件本体只 import `node:fs` / `node:os` / `node:path` / `node:url`，零 npm 第三方依赖；
  manon 组件的 Python 依赖冻结在 `manon/requirements.txt`。
- 依赖的 cordis 表面：`ctx.tools.guard`、`ctx.on("tools/result")`、`ctx.on("agent/created")`、
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
