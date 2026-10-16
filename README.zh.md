# dsh-plugin-verispring

dsh（DeepSeek Harness）三角色会话架构（领导 / 常驻测绘兵 scout / 执行层）的代码级强制 + 本地图谱 manon 组件，打成一个组合包（bundle）。
[English](README.md) | 中文

## 它强制什么

| # | 门禁 | 行为 |
|---|---|---|
| 1 | 派遣规范门 | `subagent` / `subagent_fork` 前必须先读 `~/.dsh/specs/子代理派遣规范.md`（读结果含规范首行标记或参数路径命中即记为已读，按会话隔离） |
| 2 | scout 常驻 | `description` 以 `scout` 开头的派遣每会话只许一次；重复派遣拒绝，指路 `send_message` 复用；逃生口 `touch /tmp/dsh-caseos-scout-reset-<pid>`（拒绝信息里带路径） |
| 3 | 地图前置 | 非 scout 派遣要求 `<cwd>/.project-map.md` 存在（`.git`/`.manon` 在场才认定项目根，否则 fail-open） |
| 4 | 模型钉死 | `subagent` 显式指定 `provider`/`model` 时必须为 `verispring`/`deepseek-flash`；不带字段吃默认路由（同为钉死模型） |
| 5 | 提交门 | `git commit` 前必须先读 `~/.dsh/specs/代码写作规范.md` |
| 6 | 领导面限定 | 领导会话工具面收缩到 10 件瘦身工具；执行层子代理装回全量工具；scout 硬禁 `edit`/`write`。逃生开关 `CASEOS_SCOUT=0` 关闭分工条款 |
| 7 | manon 桥接 | 解析本地图谱 CLI（`MANON_KG_BIN` > 组件自带 `manon/manon-kg` > 旧地 `~/manon/manon-kg`），存在则向所有会话注入精简用法：命令面、存储位置、scout 维护纪律、语义详见 `~/.dsh/specs/Manon调用规则.md`。**承重墙是调用铁则**：dsh 子进程服务会把 KEY/TOKEN 形状的环境变量从子进程剥掉（防泄漏），直接跑 `manon-kg sync` 必报缺密钥——注入的调用式让 bash 命令先 `source ~/.dsh/manon.env` 再执行（清洗只剥第一层，孙进程自由继承）。密钥值不经过也不打印 |

组合包 patch 还把子代理工具配置为：`backgroundMode: continuable`（后台可续派遣，`send_message`
纠偏）、`maxDepth: 1`（不派孙代理）、执行层 persona、默认路由 `verispring`/`deepseek-flash`。

## 安装

```bash
# 首选：registry 安装（版本固定；中国大陆自动经 npmmirror 内置回退源解析）
dsh plugin --profile <你的profile> add dsh-plugin-verispring

# 备用：GitHub 直装（跟随仓库当前状态，不走 registry）
dsh plugin --profile <你的profile> add github:brandonzyy/dsh-plugin-verispring

# 桌面版：设置 → 插件 → 安装，粘贴以上任一 spec
```

桌面版默认启用 HMR（base 组合包随 profile 上下文开启），插件管理器发起的安装**即时生效**，无需重启；
已经在跑的会话保持旧组合，新会话/新派遣拿到新树。仅当 HMR 被显式禁用（如 headless/SDK/ACP）时才需要重启。

## manon 组件（随包分发）

`manon/` 内置本地图谱 CLI 全套：`manon-kg` 入口 + `matrixone_graph`/`codeindex`/`core`
源码 + 冻结的 `requirements.txt`（click/httpx/networkx/numpy/rich/PyYAML + tree-sitter
全语言家族，均为预编译 wheel）。桥接解析顺序：`MANON_KG_BIN` 显式指路 > **组件自带**
（与本包版本配对）> 旧地 `~/manon/manon-kg`（历史本机安装）。

组件版首次运行自举 Python venv 并装依赖（一次性联网，需 python3 ≥3.11），此后离线可用；
tree-sitter 语言包按需动态加载，缺包只降级该语言不崩。密钥沿用 `~/.dsh/manon.env` +
`~/.dsh/verispring.env`，由注入的调用式在 bash 命令内 source。

## 前置约定（不满足时门禁会告诉你缺什么）

- **规范文件**：`~/.dsh/specs/子代理派遣规范.md` 与 `~/.dsh/specs/代码写作规范.md`（路径按
  主目录解析）。缺规范时对应门禁会持续拦截并指路——这是特性：拒绝必须可满足。
- **模型路由**：profile 需有 `verispring` provider 及 `deepseek-flash` 模型
  （经 `llm-pi-ai` 或等价适配器配置）。换网关时改包内 `cordis.patch.yml` 的 `agentOptions`
  与 `gates/dispatch-gate.js` 的 `PIN_PROVIDER`/`PIN_MODEL`，两处保持一致。
- **manon（可选）**：组件自带，无需本机安装；密钥放 `~/.dsh/manon.env`
  （`MANON_EMBEDDING_API_KEY`，sync 的向量嵌入）与 `~/.dsh/verispring.env`
  （`VERISPRING_API_KEY`，deep-query 缺省回退）——注入的调用式会自行 source 这两个文件，
  模型/端点的环境变量覆盖（`MANON_DEEPQUERY_*` / `MANON_EMBEDDING_*`）也写在这里即随会话生效。
  不用 manon 时包内其余门禁不受影响。

## 配置面板（v1.2+）

安装后 dsh 设置/插件页会出现本条目的**原生配置页**（由 Config schema 自动生成），四个模型位逐项可配，保存即生效：

| 面板字段 | 落盘位置 | 生效方式 |
|---|---|---|
| 子代理渠道 / 模型 | `~/.dsh/verispring.json` | 派遣门禁即时读取强制执法；同时写回 profile patch 的 tool-subagent `agentOptions` 作默认路由 |
| 主会话默认渠道 / 模型 / 思考强度 | profile patch 的 `agent-default-model` 条目 | configEditor 活重载；会话内用原生模型选择器可临时覆盖 |
| deep-query 端点 / 模型 | `~/.dsh/manon.env` 的 `MANON_DEEPQUERY_*` | 随注入调用式 source 进 manon-kg |
| embedding 端点 / 模型 | `~/.dsh/manon.env` 的 `MANON_EMBEDDING_*` | 更换模型后需重新 sync 重建向量 |

写入根为 Harness home（`DSH_HOME`），多 home / 探针环境互不串扰；`manon.env` 只 upsert 面板键，用户凭据行原样保留。已配置渠道/模型的图形化下拉选择器（读 llm-pi-ai 条目）为二期 client-ui 卡片。

## 模型配置建议

四个模型位：两个要你配，两个出厂即推荐。

| 模型位 | 配置处 | 建议 |
|---|---|---|
| 主会话 | profile 的 `agent-default-model`（或会话内模型选择器） | **Claude Opus 5.5**——指挥、复核、写任务书吃推理；预算敏感可降 Sonnet 档 |
| 子代理（scout + 执行） | 插件已钉死 `verispring`/`deepseek-flash` | **DeepSeek Flash**——测绘与执行是高频低复杂度调用，快且省；确要换，改包内 `cordis.patch.yml` 的 `agentOptions` 与 `gates/dispatch-gate.js` 的 `PIN_PROVIDER`/`PIN_MODEL`（两处保持一致） |
| manon deep-query | 环境变量：`MANON_DEEPQUERY_LLM_URL` / `MANON_DEEPQUERY_LLM_MODEL` / `MANON_DEEPQUERY_API_KEY`（缺省回退 `VERISPRING_API_KEY`；默认 verispring deepseek-flash） | **DeepSeek Flash**（出厂即推荐）；写进 `~/.dsh/manon.env` 即随注入调用式生效。非 deepseek 模型自动省略 thinking 字段（GLM 等可直接换） |
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
            name: DeepSeek V4.1 Flash
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

> **专属优惠**：找插件发布包作者领取——**Claude 7.8 折，DeepSeek Flash 5 折**。

## 兼容性

`peerDependencies` 钉 `@deepseek-ai/cordis` `4.0.4 || ~4.0.5-alpha.1`（对应 dsh 0.2.0-rc.2 与
0.2.1-alpha.2）。版本不满足时安装被拒；确要强装走官方豁免流程
（`dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <runtime> --accept-risk`）。

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
