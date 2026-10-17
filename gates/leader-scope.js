// 领导/测绘/执行三面工具架构（工具面口径 = ~/.dsh/specs/子代理派遣规范.md：领导原生
// 工具为复核五件 bash/edit/write/read/read_image 与派遣面 subagent/send_message/
// interrupt_agent/list_agents）：
// - 领导会话（origin != subagent）创建时 restrict({allow}) 收缩继承来的工具面（全局层与
//   preset 层都受限）；名单先与领导视图里实际存在的工具求交集——点名不存在的工具即抛错，
//   而桌面把模型可见工具全放在 preset 层、headless 全在全局层，两处的存在集不同。
//   派遣面工具再以「瘦身定义」重注册进领导自己的层：截断描述与参数说明，执行闭包不变。
// - 测绘/执行智能体（origin == subagent）不受领导面影响：子代理的作用域链挂在其 preset 下，
//   不经过领导，全量工具面来自 verispring-subagent；测绘的 deny edit/write 由 dispatch-gate
//   随派遣请求下发（toolFilter）。
// - CASEOS_SCOUT=0 关闭分工条款中的测绘部分。
const LEADER_ALLOW = new Set([
  "bash", "edit", "write", "read", "read_image",
  "subagent", "send_message", "interrupt_agent", "list_agents",
]);

// 派遣面工具的瘦身文案。subagent 的遮蔽注册由 dispatch-gate 完成（路由执行体在它那，
// 同层二次注册会抛错），这里导出文案供其复用；本文件只瘦身其余派遣工具。
export const SLIM_DESC = {
  subagent:
    "派遣执行类工作；任务书须自足。本会话首笔派遣由运行时定为测绘智能体，其后为执行智能体；渠道、模型、思考强度按角色取面板配置，调用里写的无效。默认后台运行，返回子代理 id，结束后有通知；运行中可 send_message 纠偏。",
  send_message: "向运行中的子代理发消息：纠偏、补充约束或追加任务。",
  interrupt_agent: "让某个子代理停止当前工作。",
  list_agents: "列出你启动的子代理及其状态。",
};

// 参数说明截到 60 字符；结构（type/properties/required/enum/items）原样保留
export function slimSchema(schema) {
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

const plugin = {
  inject: ["tools", "systemPrompt"],
  apply(ctx) {
    // 派遣面工具的瘦身定义（排除 subagent：它由 dispatch-gate 连同路由执行体一起注册）；
    // 复核五件保持原版。
    const slimDefs = (agent) => {
      const defs = [];
      for (const name of Object.keys(SLIM_DESC)) {
        if (name === "subagent") continue;
        const orig = ctx.tools.get(name, agent);
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
        : "常驻测绘智能体：派执行任务前，先确保有一个 description 以“测绘智能体”开头的只读智能体常驻（它被硬禁改码）。测绘智能体只派遣一次，之后 send_message 复用；重复派遣与无地图派遣（仓库根没有 .project-map.md）会被插件拒绝。产出=入口表 ≤20 行，由你用 write 落盘为仓库根 .project-map.md；仓库已有该文件时测绘智能体只做增量校对。执行任务书的定位与事实先 send_message 问它，执行完成后让它把新结构事实并入地图。";
    ctx.systemPrompt.section({
      name: "caseos:leader-dispatch",
      order: ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
      text: (context) =>
        isSubagent(context.scope)
          ? ""
          : "分工（强制，无规模例外）：一切执行类工作——读码、改码、跑测试与门禁、查 Manon 图谱、检索——一律派 subagent 完成；你只指挥、复核与验收，不亲自改码。子代理后台运行，结束有通知，运行中可 send_message 纠偏、interrupt_agent 叫停。" +
            scoutClause +
            "监理纪律：给出最终答复前，所有已派子代理必须已交付并经你验收；未交付时用 list_agents 轮询等待（可派只读占位子代理作唤醒定时器），绝不以等待中的文本结束回合。",
    });

    ctx.on("agent/created", async ({ agent }) => {
      if (agent === void 0 || isSubagent(agent)) return;
      agent.ctx.inject(["tools"], (rtc) => {
        let known = new Set();
        try {
          known = new Set(rtc.tools.schemas(agent).map((schema) => schema.name));
        } catch {}
        const allow = [...LEADER_ALLOW].filter((name) => known.has(name));
        if (allow.length === 0) {
          process.stderr.write("leader-scope: 领导视图里没有可收缩的工具，跳过 restrict\n");
          return;
        }
        try {
          rtc.tools.restrict({ allow });
          process.stderr.write(`leader-scope: 领导工具面收缩为 [${allow.join(", ")}]\n`);
        } catch (error) {
          process.stderr.write(`leader-scope: restrict 失败: ${String(error?.stack ?? error)}\n`);
          return;
        }
        // 瘦身定义遮蔽继承的原版：模型面更小，执行仍是原闭包
        for (const def of slimDefs(agent)) {
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
