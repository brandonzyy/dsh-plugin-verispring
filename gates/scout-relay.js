// 三条原本只写在提示词里的闭环的运行时实现：
// - ask_scout（P2）：执行者把定位/事实问题代发给测绘，等到测绘的新答复再返回；
// - 结构增量自动转交（P4）：非测绘子代理收尾文本里的「结构增量」段直接转给测绘；
// - 失败检查点（P5）：子代理异常结束时把现场落盘，领导续接时由插件携检查点代发。
//
// 身份事实与 gates/dispatch-gate.js 同源（这里只读；写入权仍归 dispatch-gate，
// 执行者正在并行改它，本文件不得出现第二条写入路径）：
//   领导会话状态 <stateDir>/<领导会话id>.json {version:1, scoutId?, scoutUnreachable?}
//     —— 读法与 dispatch-gate.js:192 readStateFile、:200 scoutIdIn、:225 reachableScoutId 一致；
//   子代理角色   <stateDir>/<子代理id>.json   {version:1, role: "scout"|"executor"}
// 状态目录与检查点目录同根：<dshHome>/caseos/session-state、<dshHome>/caseos/checkpoints。
//
// 代发必须以领导 Agent 为 sender：subagents.sendMessage 只校验 sender 是活的 Agent，
// 执行者当 sender 会被 authorizeLineage 以 UNAUTHORIZED 拒绝。领导工具面（leader-scope
// 的 LEADER_ALLOW 白名单）看不到本文件注册的全局工具，正好只留给执行者。
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { monitorEvent } from "./monitor-log.js";

const TOOL_NAME = "ask_scout";
const ASK_TIMEOUT_ENV = "CASEOS_ASK_SCOUT_TIMEOUT_MS";
const DEFAULT_ASK_TIMEOUT_MS = 600000;
// 等测绘答复时的最短轮询间隔：whenIdle 立即 resolve 时也要退让，否则变成忙等。
const MIN_POLL_MS = 150;
const CHECKPOINT_TEXT_LIMIT = 4000;
const RELAY_ENV = "CASEOS_SCOUT_RELAY";
// 无可达测绘时的统一拒绝文案：执行者据此把问题写进汇报，由领导处理。
const UNAVAILABLE_TEXT = "无可达测绘，请在汇报里写明问题，由领导处理";
// 失败收尾：error/aborted（含 refusal）都是「没干完」，续接必须带现场。
const FAILED_STOP_REASONS = new Set(["error", "aborted", "refusal"]);
// 插件自己发起的调用没有调用方信号可用；用永不中止的信号满足宿主「必须给 signal」的契约。
const NO_SIGNAL = new AbortController().signal;

function readCaseosState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {}
  return {};
}

// 与 dispatch-gate.js:192 readStateFile 同格式（version/scoutId/scoutUnreachable）。
function readStateFile(stateDir, sessionId) {
  if (!sessionId) return {};
  return readCaseosState(`${stateDir}/${sessionId}.json`);
}

function scoutIdIn(state) {
  const scoutId = state?.scoutId;
  return typeof scoutId === "string" && scoutId ? scoutId : void 0;
}

// 与 dispatch-gate.js:225 reachableScoutId 同判据：不可达标记优先于 scoutId。
function reachableScoutId(stateDir, leaderId) {
  const state = readStateFile(stateDir, leaderId);
  if (state.scoutUnreachable) return void 0;
  return scoutIdIn(state);
}

// 子代理角色由 dispatch-gate 在 spawn 时落盘，这里只读。
function childRole(stateDir, sessionId) {
  const role = readCaseosState(`${stateDir}/${sessionId}.json`).role;
  return role === "scout" || role === "executor" ? role : void 0;
}

// subagent/end 只带子代理 id（宿主把 parent 当作用域键，不传给监听器）。父会话按
// dispatch-gate 的懒重建思路从状态目录反查：哪个领导会话的 scoutId 正好是这个子代理。
function scoutOwnerOf(stateDir, childId) {
  let names = [];
  try {
    names = readdirSync(stateDir);
  } catch {
    return void 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const owner = name.slice(0, -".json".length);
    if (scoutIdIn(readCaseosState(`${stateDir}/${name}`)) === childId) return owner;
  }
  return void 0;
}

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

// 会话事件正文：assistant/message 落 data.message.content（dsh-agent-loop）；
// user/message 直接落 content（SessionEventMap['user/message'] = UserMessage）。
// assistant 选取规则同 dsh-subagent/lib/types/assistant-output.js：最后一条非空。
function eventText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content;
  return Array.isArray(content) ? blocksText(content) : "";
}

// 只取子会话自己的事件：会话日志头部是父会话的种子事件（inheritedEventCount），
// 混进来会把父会话的 assistant 正文与 edit/write 当成子代理的现场。
function ownEvents(session, events) {
  const inherited = Number(session?.inheritedEventCount ?? 0);
  return inherited > 0 ? events.slice(inherited) : events;
}

function snapshotOf(agent) {
  try {
    const session = agent?.session;
    return ownEvents(session, session?.snapshotEvents?.() ?? []);
  } catch {
    return [];
  }
}

function lastAssistantText(events) {
  let text = "";
  for (const event of events) {
    if (event?.type !== "assistant/message") continue;
    const next = eventText(event).trim();
    if (next) text = next;
  }
  return text;
}

// 只取「发出提问之后」的 assistant 消息：以提问那条 user/message 为水位线（消息本身
// 先落进子会话日志，冷恢复后同样能定位到），取其后最后一条非空 assistant 正文。
function answerAfterMarker(events, marker) {
  let markerIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === "user/message" && eventText(event).includes(marker)) markerIndex = index;
  }
  if (markerIndex < 0) return void 0;
  let answer;
  for (let index = markerIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const text = eventText(event).trim();
    if (text) answer = text;
  }
  return answer;
}

// 改过的文件：tool/call 里 name ∈ {edit, write} 的参数。宿主把 arguments 落成 JSON
// 字符串（SessionEventMap['tool/call']），模型面也有对象形态，两种都吃。
function callArguments(data) {
  const raw = data?.arguments;
  if (raw !== null && typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {}
  return {};
}

function editedFilesOf(events) {
  const files = [];
  for (const event of events) {
    if (event?.type !== "tool/call") continue;
    const name = event.data?.name;
    if (name !== "edit" && name !== "write") continue;
    const args = callArguments(event.data);
    const path = args.path ?? args.file_path ?? args.file;
    if (typeof path === "string" && path && !files.includes(path)) files.push(path);
  }
  return files;
}

// 结构增量段：标题行变体包括 ## 结构增量、### 结构增量：x、**结构增量**、结构增量：、
// 「- 结构增量：x」；标题行自身的剩余内容算正文。截断边界按标题形态定：
//   markdown 标题  -> 下一个同级或更高级标题；
//   加粗/裸标签    -> 下一个一级或二级标题（视作二级段）；
//   列表项标签     -> 同层或更高层的下一个列表项 / 任何标题（同级条目起就是别的段了）。
const ATX_HEADING = /^\s{0,3}(#{1,6})\s*(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const STRUCTURE_LABEL = /结构增量/;

function plainText(text) {
  return text.replace(/[\s\p{P}\p{S}]/gu, "");
}

function structureSection(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!STRUCTURE_LABEL.test(line)) continue;
    const atx = ATX_HEADING.exec(line);
    const atxTitle = atx !== null && atx[2].trim().startsWith("结构增量");
    const boldTitle = /^\s*\*\s*\*\s*结构增量\s*\*\s*\*/.test(line);
    const listItem = LIST_ITEM.exec(line);
    const listedTitle = listItem !== null && /^\s*(?:[-*+]|\d+[.)])\s*结构增量\s*[：:]/.test(line);
    const looseTitle = /^\s*结构增量\s*[：:]/.test(line);
    if (!atxTitle && !boldTitle && !listedTitle && !looseTitle) continue;

    const headingLevel = atxTitle ? atx[1].length : 2;
    const listIndent = listedTitle ? listItem[1].length : -1;
    // 丢掉标题标记本身（#、**、列表符号、标签），只留正文。
    const head = line
      .replace(/^\s*(?:#{1,6}\s*)?(?:[-*+]|\d+[.)])?\s*(?:\*\s*\*\s*)?结构增量(?:\s*\*\s*\*)?\s*[：:]?\s*/, "")
      .trim();
    const body = head ? [head] : [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      const nextHeading = ATX_HEADING.exec(next);
      if (nextHeading && nextHeading[1].length <= headingLevel) break;
      const nextItem = LIST_ITEM.exec(next);
      if (listIndent >= 0 && nextItem !== null && nextItem[1].length <= listIndent) break;
      body.push(next);
    }
    return body.join("\n").trim();
  }
  return void 0;
}

// 段落存在且去掉空白与标点后不是「无」（含列表符号、句号）才算有增量。
export function extractStructureDelta(text) {
  const section = structureSection(text);
  if (section === void 0) return void 0;
  const plain = plainText(section);
  if (plain === "" || plain === "无") return void 0;
  return section;
}

function errorTextOf(info) {
  const cause = info?.error ?? info?.cause;
  if (!cause) return void 0;
  return String(cause?.message ?? cause).slice(0, 500);
}

export default {
  name: "caseos-scout-relay",
  inject: ["tools", "agents", "subagents", "profileContext", "systemPrompt"],
  apply(ctx) {
    // 整体开关：关掉即不注册工具、不挂监听，运行时回到纯提示词行为。
    if (process.env[RELAY_ENV] === "0") return;

    const dshHome = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    const stateDir = `${dshHome}/caseos/session-state`;
    const checkpointDir = `${dshHome}/caseos/checkpoints`;

    // 服务一律从活上下文现取：面板改配置会重跑 apply，闭包 ctx 一读就是 inactive context。
    const liveOf = (agent) => {
      try {
        return agent?.ctx ?? ctx.root;
      } catch {
        return ctx.root;
      }
    };
    // 宿主服务的取法：活上下文 get() 优先，退回属性访问；两者都可能因作用域失活抛错，
    // 最后兜到 root。全程不缓存，重载后读到的是新作用域的服务。
    const serviceOf = (agent, name) => {
      const live = liveOf(agent);
      try {
        const viaGet = live.get?.(name);
        if (viaGet !== void 0) return viaGet;
      } catch {}
      try {
        return live[name] ?? ctx.root[name];
      } catch {
        return ctx.root[name];
      }
    };
    const agentsOf = (agent) => serviceOf(agent, "agents");
    const subagentsOf = (agent) => serviceOf(agent, "subagents");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const askTimeoutMs = () => {
      const configured = Number(process.env[ASK_TIMEOUT_ENV]);
      return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ASK_TIMEOUT_MS;
    };

    // 子代理现场：事件 + 父会话 id。end 时子代理通常已从 agents 注册表摘掉，父会话
    // 只能从持久化会话头取（sessionQuery 用法同 dsh-subagent/lib/types/manager.js:1178，
    // 父会话在 source.header.parentSession）。
    const childSnapshot = async (childId, scope) => {
      const agent = agentsOf(scope)?.get?.(childId);
      const parent = agent?.session?.header?.parentSession;
      let events = snapshotOf(agent);
      if (events.length > 0) return { events, parent };
      // end 时子 Agent 已摘出注册表，会话对象通常还在 sessions 服务里。
      try {
        const session = serviceOf(scope, "sessions")?.get?.(childId);
        events = ownEvents(session, session?.snapshotEvents?.() ?? []);
        if (events.length > 0) return { events, parent: session?.header?.parentSession ?? parent };
      } catch {}
      const query = serviceOf(scope, "sessionQuery");
      if (!query?.observeSession) return { events, parent };
      let observation;
      try {
        observation = await query.observeSession(childId);
      } catch {
        return { events, parent };
      }
      try {
        return {
          events: ownEvents(observation, [...(observation?.events ?? [])]),
          parent: observation?.header?.parentSession ?? parent,
        };
      } finally {
        try {
          observation?.[Symbol.dispose]?.();
        } catch {}
      }
    };

    // ---- P2：ask_scout ---------------------------------------------------
    const askScout = async (args, exec) => {
      const startedAt = Date.now();
      const question = typeof args?.question === "string" ? args.question.trim() : "";
      const childId = exec?.agent?.id ?? "";
      const header = exec?.agent?.session?.header ?? {};
      const leaderId = header.parentSession;
      const fail = (reason) => {
        monitorEvent(dshHome, {
          kind: "ask-scout",
          child: childId,
          question: question.slice(0, 200),
          elapsedMs: Date.now() - startedAt,
          result: "unavailable",
          reason,
        });
        return new Error(UNAVAILABLE_TEXT);
      };
      if (!question) throw new Error("ask_scout 需要 question");
      if (header.origin !== "subagent" || !leaderId) throw fail("not-subagent");
      // 测绘自己的提问直接拒：角色文件是 spawn 时定型的权威事实（dispatch-gate 写）。
      if (childRole(stateDir, childId) === "scout") throw fail("scout-itself");
      const scoutId = reachableScoutId(stateDir, leaderId);
      if (!scoutId) throw fail("no-scout");
      if (childId === scoutId) throw fail("scout-itself");

      const leader = agentsOf(exec.agent)?.get?.(leaderId);
      const subagents = subagentsOf(exec.agent);
      if (!leader || typeof subagents?.sendMessage !== "function") throw fail("leader-not-live");

      const marker = `【执行者 ${childId} 经 ask_scout 提问`;
      const text = `${marker}，请只答事实，带 路径:行号】${question}`;
      const signal = exec?.signal ?? NO_SIGNAL;
      try {
        await subagents.sendMessage(leader, scoutId, [{ type: "text", text }], { signal });
      } catch (error) {
        throw fail(`send-failed:${String(error?.message ?? error).slice(0, 120)}`);
      }

      const deadline = Date.now() + askTimeoutMs();
      let interval = 250;
      for (;;) {
        const scout = agentsOf(exec.agent)?.get?.(scoutId);
        const answer = answerAfterMarker(snapshotOf(scout), marker);
        if (answer !== void 0) {
          monitorEvent(dshHome, {
            kind: "ask-scout",
            child: childId,
            scout: scoutId,
            question: question.slice(0, 200),
            elapsedMs: Date.now() - startedAt,
            result: "answered",
          });
          return { status: "answered", scoutId, answer };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        // 测绘冷恢复后才出现在 agents 里：每轮重取。whenIdle 让出这一回合；它可能已
        // resolve（测绘当时是 idle），所以再垫一个最短轮询间隔，避免无节制空转。
        const idle = typeof scout?.whenIdle === "function"
          ? scout.whenIdle().then(() => sleep(MIN_POLL_MS))
          : Promise.resolve();
        await Promise.race([idle, sleep(Math.min(remaining, interval))]);
        interval = Math.min(interval * 2, 2000);
      }
      monitorEvent(dshHome, {
        kind: "ask-scout",
        child: childId,
        scout: scoutId,
        question: question.slice(0, 200),
        elapsedMs: Date.now() - startedAt,
        result: "timeout",
      });
      return { status: "timeout", scoutId, answer: "" };
    };

    const askTool = {
      name: TOOL_NAME,
      description:
        "把定位与事实问题（某实现/入口在哪、某结构怎么走、某约束在哪定义）代发给常驻测绘，等它答复后返回带 路径:行号 的正文。"
        + "定位与事实问测绘，不要自己通读实现；读码只用于核对测绘给出的事实。"
        + "领导与测绘自己调用、或没有可达测绘时会直接报错，此时把问题写进汇报交由领导处理。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问测绘的事实问题：模块、符号、现象，越具体越容易得到坐标。" },
        },
        required: ["question"],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["answered", "timeout"] },
            scoutId: { type: "string" },
            answer: { type: "string" },
          },
          required: ["status", "scoutId"],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: "text",
          text: value.status === "answered"
            ? value.answer
            : `已转交测绘 ${value.scoutId}，未在时限内答复；答复会送达领导，请先做不依赖该事实的部分`,
        }],
      },
      async execute(args, exec) {
        return askScout(args, exec);
      },
    };
    try {
      ctx.root.tools.register(askTool);
    } catch (error) {
      process.stderr.write(`caseos-scout-relay: ${TOOL_NAME} 注册失败: ${String(error)}\n`);
    }

    // ---- 非测绘子代理的定位纪律 ------------------------------------------
    // 提示词只解释运行时已有的两条闭环（ask_scout、结构增量自动转交），判定在代码里。
    // 无可达测绘时同一段改成「写进汇报」，免得执行者去等一个不存在的测绘。
    const headerOf = (scope) => {
      try {
        return scope?.session?.header ?? {};
      } catch {
        return {};
      }
    };
    const locatorText = (scope) => {
      const header = headerOf(scope);
      if (header.origin !== "subagent" && header.parentSession === void 0) return "";
      if (childRole(stateDir, header.id) === "scout") return "";
      const scoutId = header.parentSession ? reachableScoutId(stateDir, header.parentSession) : void 0;
      const ask = scoutId
        ? `定位与事实用 ask_scout 问常驻测绘 ${scoutId}，不要自己通读实现；读码只用于核对它给出的事实。`
        : "当前没有可达测绘：定位与事实问题写进汇报交领导处理，不要为此通读实现。";
      return [
        ask,
        "收尾汇报必须单独一段「结构增量」：新增/移动/改名/删除的符号与入口，带 路径:行号；没有就写「无」。",
        "该段由插件自动转给测绘，你不需要自己通知测绘。",
      ].join("\n");
    };
    ctx.systemPrompt.section({
      name: "caseos:scout-relay",
      order: ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
      text: (context) => locatorText(context.scope),
    });

    // ---- P4 + P5：子代理收尾事实 ----------------------------------------
    // agent/error 与 subagent/end 分两条事件到达：错误正文先落这里，end 时取用。
    const agentErrors = new Map();

    const forwardStructureDelta = async (childId, leaderId, text) => {
      const delta = extractStructureDelta(text);
      if (delta === void 0) return;
      const scoutId = reachableScoutId(stateDir, leaderId);
      if (!scoutId) {
        monitorEvent(dshHome, { kind: "structure-forward", child: childId, chars: delta.length, result: "unavailable" });
        return;
      }
      const leader = agentsOf()?.get?.(leaderId);
      const subagents = subagentsOf();
      if (!leader || typeof subagents?.sendMessage !== "function") {
        monitorEvent(dshHome, { kind: "structure-forward", child: childId, scout: scoutId, chars: delta.length, result: "leader-not-live" });
        return;
      }
      try {
        await subagents.sendMessage(
          leader,
          scoutId,
          [{
            type: "text",
            text: `【结构增量自动转交 · 执行者 ${childId}】请 git status --short 自校后核实坐标，并入入口表，回报最新全表。\n${delta}`,
          }],
          { signal: NO_SIGNAL },
        );
        monitorEvent(dshHome, { kind: "structure-forward", child: childId, scout: scoutId, chars: delta.length, result: "forwarded" });
      } catch (error) {
        monitorEvent(dshHome, {
          kind: "structure-forward",
          child: childId,
          scout: scoutId,
          chars: delta.length,
          result: "send-failed",
          error: String(error?.message ?? error).slice(0, 200),
        });
      }
    };

    const saveCheckpoint = (childId, leaderId, info, lastText, events) => {
      const error = agentErrors.get(childId) ?? errorTextOf(info);
      agentErrors.delete(childId);
      const checkpoint = {
        childId,
        parent: leaderId,
        stopReason: info?.stopReason,
        ...(error ? { error } : {}),
        lastAssistantText: lastText.slice(0, CHECKPOINT_TEXT_LIMIT),
        editedFiles: editedFilesOf(events),
        at: new Date().toISOString(),
      };
      try {
        mkdirSync(checkpointDir, { recursive: true });
        writeFileSync(`${checkpointDir}/${childId}.json`, `${JSON.stringify(checkpoint)}\n`);
        monitorEvent(dshHome, {
          kind: "checkpoint-saved",
          child: childId,
          stopReason: checkpoint.stopReason,
          files: checkpoint.editedFiles.length,
        });
      } catch (error_) {
        monitorEvent(dshHome, {
          kind: "checkpoint-save-failed",
          child: childId,
          error: String(error_?.message ?? error_).slice(0, 200),
        });
      }
    };

    const onSubagentEnd = async (info) => {
      const childId = info?.id;
      if (!childId) return;
      // 测绘自己的 end 归 dispatch-gate 管（可达性判定）：不转交、不落检查点。
      if (childRole(stateDir, childId) === "scout") return;
      const { events, parent } = await childSnapshot(childId);
      const leaderId = parent ?? scoutOwnerOf(stateDir, childId);
      if (leaderId && reachableScoutId(stateDir, leaderId) === childId) return;
      const lastText = blocksText(info?.lastAssistantMessage).trim() || lastAssistantText(events);
      if (leaderId && lastText) await forwardStructureDelta(childId, leaderId, lastText);
      if (FAILED_STOP_REASONS.has(info?.stopReason)) saveCheckpoint(childId, leaderId, info, lastText, events);
      // 这次收尾没落检查点也必须清掉错误草稿：同一个 id 可能被续接后再次报错。
      agentErrors.delete(childId);
    };

    ctx.root.on("subagent/end", async (info) => {
      try {
        await onSubagentEnd(info);
      } catch (error) {
        monitorEvent(dshHome, {
          kind: "scout-relay-error",
          child: info?.id,
          stage: "subagent-end",
          error: String(error?.message ?? error).slice(0, 200),
        });
      }
    });

    ctx.root.on("agent/error", ({ agent, error } = {}) => {
      if (agent?.session?.header?.origin !== "subagent") return;
      const text = String(error?.message ?? error);
      if (text) agentErrors.set(agent.id, text.slice(0, 500));
    });

    // ---- P5 续接注入：领导 send_message 命中检查点 ----------------------
    // 走 tools/pre-execute 瀑布而不是 tools.guard：宿主 guard 是同步的（返回值即拒绝），
    // 拿不到异步代发的结果；瀑布由宿主 await，成功才拒绝原调用、失败必须放行。
    ctx.on("tools/pre-execute", async (exec, next) => {
      const upstream = await next();
      try {
        // 别的门禁的拒绝优先：它们已经拒绝的调用不该被本插件改写成"已代发"。
        if (upstream?.kind !== "allow") return upstream;
        if (exec?.name !== "send_message") return upstream;
        const caller = exec.agent;
        if (!caller || caller.session?.header?.origin === "subagent") return upstream;
        const targetId = typeof exec.arguments?.agent_id === "string" ? exec.arguments.agent_id : "";
        const message = typeof exec.arguments?.message === "string" ? exec.arguments.message : "";
        if (!targetId || !message) return upstream;
        const checkpoint = readCaseosState(`${checkpointDir}/${targetId}.json`);
        if (!checkpoint?.childId) return upstream;
        // 只接管本会话自己的检查点：别的领导会话的现场不得被这个会话消费掉。
        if (checkpoint.parent && checkpoint.parent !== caller.id) return upstream;
        const subagents = subagentsOf(caller);
        if (typeof subagents?.sendMessage !== "function") return upstream;

        const files = Array.isArray(checkpoint.editedFiles) ? checkpoint.editedFiles : [];
        const merged = [
          `【插件检查点：上次因 ${checkpoint.stopReason ?? "中断"} 中断】已改文件：${files.length > 0 ? files.join("、") : "（无记录）"}；中断前最后结论：${checkpoint.lastAssistantText || "（无）"}`,
          "——请从检查点继续，不要从头调研——",
          message,
        ].join("\n");
        try {
          await subagents.sendMessage(caller, targetId, [{ type: "text", text: merged }], {
            signal: exec?.signal ?? NO_SIGNAL,
          });
        } catch (error) {
          monitorEvent(dshHome, {
            kind: "checkpoint-inject-failed",
            child: targetId,
            error: String(error?.message ?? error).slice(0, 200),
          });
          return upstream;
        }
        try {
          rmSync(`${checkpointDir}/${targetId}.json`, { force: true });
        } catch {}
        monitorEvent(dshHome, {
          kind: "checkpoint-injected",
          child: targetId,
          stopReason: checkpoint.stopReason,
          files: files.length,
        });
        return { kind: "deny", reason: `已由插件携检查点代发给 ${targetId}，无需重发` };
      } catch {
        return upstream;
      }
    });
  },
};
