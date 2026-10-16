// 领导/测绘/执行三面工具架构（C，2026-10-15 用户定稿；进门票 <5000 压缩版）：
// - 领导会话（origin != subagent）创建时两步：
//     1) agent.ctx.tools.restrict({ allow })——声明面收缩到复核五件 + subagent；
//     2) 把这 6 个工具以「瘦身定义」重注册进领导自己的层（own-layer 遮蔽全局原版）：
//        截断工具描述与参数说明。执行闭包保留原版，参数校验不受瘦身影响；
//        list_agents/interrupt_agent/send_message 不进白名单——前台一次性派遣模式下
//        这三件物理不可用（subagent 调用阻塞到子代理结束，无并发可管理）。
// - 测绘/执行智能体（origin == subagent）：创建时把白名单外的全局工具按原版重注册进
//   子代理自己的层（own-layer 注册豁免祖先限制），全量工具面不变。
// 已知边界：领导保有 bash（复核需要），本插件收缩声明面并引导分工，不防对抗性绕过。
const LEADER_ALLOW = new Set([
  "subagent", "send_message", "interrupt_agent", "list_agents",
]);

const SLIM_DESC = {
  subagent:
    "派遣执行类工作给执行智能体；任务书须自足。测绘智能体需在 description 开头写“测绘智能体”，并显式带渠道、模型、思考强度；执行智能体默认使用面板配置。默认后台运行，返回子代理 id，结束后有通知；运行中可 send_message 纠偏。",
  send_message: "向运行中的子代理发消息：纠偏、补充约束或追加任务。",
  interrupt_agent: "让某个子代理停止当前工作。",
  list_agents: "列出你启动的子代理及其状态。",
};

// 参数说明截到 60 字符；结构（type/properties/required/enum/items）原样保留
function slimSchema(schema) {
  if (Array.isArray(schema)) return schema.map(slimSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "description" && typeof v === "string" && v.length > 60) out[k] = v.slice(0, 57) + "...";
    else out[k] = slimSchema(v);
  }
  return out;
}

function isSubagent(agent) {
  try {
    const header = agent?.session?.header;
    return header?.origin === "subagent" || header?.parentSession !== void 0;
  } catch {
    return false;
  }
}

// 常驻只读测绘智能体：description 以“测绘智能体”或 scout 开头（描述符在创建期写入子代理会话）
function isScout(agent) {
  try {
    const session = agent?.session;
    if (!session?.eventAt) return false;
    for (let i = 0; i < 24; i++) {
      let e;
      try { e = session.eventAt(i); } catch { return false; }
      if (!e) return false;
      if (e.type === "subagent/descriptor") {
        const label = e.data?.label ?? "";
        return typeof label === "string" && (label.toLowerCase().startsWith("scout") || label.startsWith("测绘智能体"));
      }
    }
  } catch {}
  return false;
}

const plugin = {
  inject: ["tools", "systemPrompt"],
  apply(ctx) {
    // 白名单之外的全局工具原版定义，子代理创建时装回其自己的层
    const heavyDefs = () => {
      const defs = [];
      for (const schema of ctx.tools.schemas(undefined)) {
        if (LEADER_ALLOW.has(schema.name)) continue;
        const def = ctx.tools.get(schema.name);
        if (def !== void 0) defs.push(def);
      }
      return defs;
    };

    // 白名单内工具的瘦身定义（profile 层取原版定义，遮蔽用）
    const slimDefs = () => {
      const defs = [];
      for (const name of LEADER_ALLOW) {
        const orig = ctx.tools.get(name);
        if (orig === void 0) continue;
        defs.push({
          ...orig,
          description: SLIM_DESC[name] ?? orig.description,
          parameters: slimSchema(orig.parameters ?? {}),
        });
      }
      return defs;
    };

    // 领导可见的分工声明（子代理渲染为空）。这是派遣行为的承重墙，措辞弱化即回退亲做。
    const scoutClause =
      process.env.CASEOS_SCOUT === "0"
        ? ""
        : "常驻测绘智能体：派执行任务前，先确保有一个 description 以“测绘智能体”开头的只读智能体常驻（它被硬禁改码）。测绘智能体只派遣一次，之后 send_message 复用；重复派遣与无地图派遣（仓库根没有 .project-map.md）会被插件拒绝。产出=入口表 ≤20 行，由你落盘为仓库根 .project-map.md；仓库已有该文件时测绘智能体只做增量校对。执行任务书的定位与事实先 send_message 问它，执行完成后让它把新结构事实并入地图。";
    ctx.systemPrompt.section({
      name: "caseos:leader-dispatch",
      order: ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
      text: (context) =>
        isSubagent(context.scope)
          ? ""
          : "分工（强制，无规模例外）：一切执行类工作——读码、改码、跑测试与门禁、查 Manon 图谱、检索——一律派 subagent 完成；你只指挥、复核与验收，不亲自读码改码。子代理后台运行，结束有通知，运行中可 send_message 纠偏、interrupt_agent 叫停。" +
            scoutClause +
            "监理纪律：给出最终答复前，所有已派子代理必须已交付并经你验收；未交付时用 list_agents 轮询等待（可派只读占位子代理作唤醒定时器），绝不以等待中的文本结束回合。",
    });

    ctx.on("agent/created", async ({ agent }) => {
      if (agent === void 0) return;
      if (isSubagent(agent)) {
        const defs = heavyDefs();
        const scout = isScout(agent);
        if (scout) process.stderr.write("leader-scope: 识别到测绘智能体，将施加只读约束\n");
        agent.ctx.inject(["tools"], (rtc) => {
          for (const def of defs) {
            try {
              rtc.tools.register(def);
            } catch (error) {
              ctx.logger.warn(`leader-scope: 子代理装回 "${def?.name}" 失败: ${String(error)}`);
            }
          }
          if (scout) {
            try {
              rtc.tools.restrict({ deny: ["edit", "write"] });
              process.stderr.write("leader-scope: 测绘智能体只读约束生效（deny edit/write）\n");
            } catch (error) {
              process.stderr.write(`leader-scope: scout 只读约束失败: ${String(error)}\n`);
            }
          }
        });
        return;
      }
      agent.ctx.inject(["tools"], (rtc) => {
        try {
          rtc.tools.restrict({ allow: [...LEADER_ALLOW] });
        } catch (error) {
          process.stderr.write(`leader-scope: restrict 失败: ${String(error?.stack ?? error)}\n`);
          return;
        }
        // 瘦身定义遮蔽全局原版：模型面更小，执行仍是原闭包
        for (const def of slimDefs()) {
          try {
            rtc.tools.register(def);
            process.stderr.write(`leader-scope: ${def.name} 瘦身注册成功\n`);
          } catch (error) {
            process.stderr.write(`leader-scope: ${def?.name} 瘦身失败: ${String(error)}\n`);
          }
        }
      });
    });
  },
};

export default plugin;
