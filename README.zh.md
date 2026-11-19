# dsh-plugin-verispring

三角色会话架构插件（领导 — 测绘 — 执行）+ 自带本地知识图谱 manon。主会话保留顶级模型，但自己
不再通读代码：重活交给 DeepSeek Flash，主会话上下文保持干净，从而大幅节省顶级模型 API 费用。

*领导派遣 → 测绘建图并回答事实 → 执行者出手 → 回执回到领导*

[English](README.md) | 中文

## 它做什么

### 三角色分工，由派遣纪律强制执行

领导负责规划、派遣与验收；常驻测绘掌握仓库地图、对代码只读；执行者写码、跑命令。角色由派遣本身
决定，没有可达测绘时执行派遣会被拒，地图不存在或不新鲜时执行者也不会启动。任务书直达子会话，
结果以结算回执返回——主会话不会被原始探索污染。manon 图谱是测绘专责工具，领导与执行都不直接调用，
有图谱问题就问测绘。同一领导会话里同时运行的执行者默认上限 8 个，派遣不会摊成一堆并发。

### 地图新鲜度与转交核实

新鲜度闸先 `git fetch`，再比登记基准与 `origin/<默认分支>`；落后即拒，文案给落后提交数与改动文件数。
基准登记同样取 origin sha；无 origin 的仓沿用本地 HEAD。fetch 失败放行并记 `map-fresh-fetch-failed`。
**升级迁移**：旧基准（无 `basis` 字段，本地 HEAD 口径）首次比较时，不落后 origin 则静默升级；落后则
写 `graceUntil` 放行 24 小时（`CASEOS_MAP_GRACE_HOURS` 调整，0=无宽限，事件 `map-baseline-migrate-grace`），
期内重写一次 `.project-map.md` 即换成新基准，过期按 `map-stale` 拒绝。

执行者回执转交测绘时，插件先 fetch 并附 origin sha、迁移目录最大编号、`git worktree list` 原文。合并状态只认
`git merge-base --is-ancestor <sha> origin/<默认分支>` 的输出，没有输出写「未核实」；测绘只回报增量与已核对条目。

### 全局工作规范供给

全局规范只有一个读取点：`$DSH_HOME/CLAUDE.md`（默认 `~/.dsh/CLAUDE.md`），与 `$DSH_HOME/specs/` 同根。
规范作者的机器上它是指向 `~/.claude/CLAUDE.md` 的软链；团队成员机上放组织下发的规范包。插件以根作用域动态系统段
`caseos:global-work-spec` 在每次提示词装配时读取完整正文，领导、测绘、执行三类会话都覆盖，
`send_message` 续接与冷恢复同样生效；子代理任务书不能豁免。任务涉及正文引用的专项 specs 时，
按源内路径完整读取对应规范。

源缺失、空白或读取失败时，新 subagent 派遣与既有子代理的工具调用一律以 `spec-source-missing`
拒绝并记入 monitor；领导普通工具不受影响。源恢复后下一轮即恢复，无缓存。

### 省钱的模型分工

主会话用顶级模型（默认 Claude Opus 5.5），测绘与执行默认 DeepSeek Flash。路由在运行时按角色强制
注入——派遣调用里写的 provider/model 一律被忽略——便宜路由不是建议而是纪律。两套智能体路由都在
插件面板选择，主会话用 DSH 原生模型选择器。

### 缓存成本防线

工具定义与常规系统段逐会话冻结，新版本改的文案不会让在跑会话重写提示前缀；全局规范段是有意的
动态例外，每轮重新读取。压缩按角色分档：主会话在窗口 40% 触发，子代理 60%。主会话空闲 55 分钟
且超过 50K token 时自动压一次——摊平缓存 TTL 过期后那笔大额缓存写入。认账的代价：超大工具结果
会一直留在上下文里，直到某次压缩把它摘要掉。

### 内存与宿主守护

堆阈值在触顶前很早就告警并剪掉插件自己的索引；进程外看门狗在宿主事件循环卡住时照常采样；超大
文件整读被拒并给出分段读法；领导可以点名释放已结束的子代理把内存交还。宿主绝不会被悄悄杀掉——
硬阈值只记一条重启提示。

### 密钥卫生

整环境倾倒一律拦截。凭据文件不再设读取闸，取值时只点名需要的键。

### 可观测

角色漂移、门禁拦截、派遣、释放与内存事件全部落到 `~/.dsh/verispring-monitor.jsonl`，事后审计
无需解压会话日志。

### 守护开关

内存守卫、测绘分工等能力提供 `CASEOS_*` 开关，可以按需关闭对应能力，不必卸载：比如
`CASEOS_MEM_GUARD=0` 关掉内存守卫与看门狗，`CASEOS_SCOUT=0` 去掉分工条款里的测绘部分。
全局工作规范供给及其失败关闭门禁不参与这些开关。

## 安装

```bash
# 安装 / 更新（跟随仓库 main；固定版本用 #v1.3.3 这类 tag）
dsh plugin --profile <你的profile> add github:brandonzyy/dsh-plugin-verispring

# 桌面版：设置 → 插件 → 安装，粘贴同一条 spec
```

桌面版默认启用 HMR，通过插件管理器安装即时生效——无需重启。已在跑的会话保持旧组合，新会话与新
派遣拿到新树；仅当 HMR 被显式禁用（headless/SDK/ACP）时才需要重启。更新方式：卸载后重装同一条
spec。

**自动更新**（v1.6.0 起）：装好后无需再手动重装——插件每 6 小时对比 GitHub main 上的版本，
发现新版本自动经宿主插件管理器重装同一条 spec（与上面手动更新完全同路径），桌面版 HMR 即时
生效；更新动作落 `~/.dsh/verispring-monitor.jsonl`（auto-update-applied / auto-update-failed）。
`CASEOS_AUTO_UPDATE=0` 关闭；`CASEOS_UPDATE_CHECK_MS` 改检查周期（下限 10 分钟）；
`CASEOS_UPDATE_SPEC` / `CASEOS_UPDATE_BRANCH` 覆盖重装来源。headless/SDK 等没有插件管理面的
宿主上自动更新不激活（gate 里不绕过宿主自己跑 pnpm）。

**前置条件** —— profile 需含 agent preset 注册表与 `preset-standard`（桌面版 / web 组合包自带）；
`~/.dsh/specs/子代理派遣规范.md` 与 `~/.dsh/specs/代码写作规范.md` 需存在（缺规范时门禁会持续
拦截并指路）；`$DSH_HOME/CLAUDE.md` 需存在、可读且非空白（否则子代理派遣与子代理工具调用被拒）；
`verispring` 渠道需同时服务领导模型与一条声明了 `reasoningEfforts` 和
`compat.forceAdaptiveThinking` 的 `deepseek-flash` 条目。manon 随包分发、可选：首次运行自举
Python venv（一次性联网，需 python3 ≥3.11），密钥放 `~/.dsh/manon.env` 与 `~/.dsh/verispring.env`。

> **专属优惠**：找插件发布包作者领取——**Claude 8 折，DeepSeek Flash 5 折**；微信：`jinyong0716`。

## 测试

`npm test` 依次跑各门禁行为测试与冒烟（`npm run smoke`）。mock 测试证明不了真实宿主装载门禁，
所以升级 dsh 后单独跑一次 `npm run smoke`：检查版本声明、源码语法与插件入口；设置了 `DSH_BIN` 与
`DSH_SMOKE_PROFILE` 时会追加官方 `--dump-config` 组合检查。

## License

MIT
