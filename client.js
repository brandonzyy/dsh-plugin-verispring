// verispring 配置面板（客户端贡献）：注册进插件页的 plugins.row.config 槽
// （键 = dsh-plugin-verispring#verispring-config），为 verispring-config 行渲染配置表单。
// 产物契约：闭包工厂 —— window.__ModuleLoader__.load({id, factory(require)})，
// 外部依赖（react）经注入的 require 从加载器模块表解析；宿主半边（verispring-config.js）
// 把值落盘到执法面，本卡片经 settings 传输写 live Config。
// 防御式：apply 与组件全程 try/catch——本模块出错只损失面板，不拖垮插件页。
window.__ModuleLoader__.load({
  id: "dsh-plugin-verispring",
  factory: (require) => {
    const React = require("react");

    const FIELDS = [
      ["subagentProvider", "子代理渠道（scout + 执行层）"],
      ["subagentModel", "子代理模型"],
      ["mainSessionProvider", "主会话默认渠道"],
      ["mainSessionModel", "主会话默认模型"],
      ["mainSessionEffort", "主会话思考强度（留空跟随模型默认）"],
      ["deepQueryUrl", "manon deep-query 端点"],
      ["deepQueryModel", "manon deep-query 模型"],
      ["embeddingUrl", "embedding 端点"],
      ["embeddingModel", "embedding 模型（换后需重新 sync）"],
    ];

    const box = { marginBottom: 10 };
    const label = { display: "block", fontSize: 12, opacity: 0.75, marginBottom: 3 };
    const input = { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 13 };
    const button = { marginTop: 12, padding: "6px 14px", fontSize: 13, cursor: "pointer" };

    function ConfigCard(props) {
      try {
        const { view, form } = props;
        if (view === "summary") {
          return React.createElement("span", null, "四个模型位：子代理 / 主会话默认（含思考强度）/ deep-query / embedding");
        }
        if (view !== "page" || !form) return null;
        const snapshot = form.state;
        if (!snapshot || snapshot.status !== "ready") return null;
        const value = snapshot.value ?? {};
        const [draft, setDraft] = React.useState({});
        const dirty = FIELDS.some(([key]) => draft[key] !== undefined && draft[key] !== (value[key] ?? ""));
        const rows = FIELDS.map(([key, text]) =>
          React.createElement("div", { key, style: box },
            React.createElement("label", { style: label }, text),
            React.createElement("input", {
              style: input,
              value: draft[key] !== undefined ? draft[key] : (value[key] ?? ""),
              onChange: (event) => setDraft((prev) => ({ ...prev, [key]: event.target.value })),
            })));
        return React.createElement("div", null, rows,
          React.createElement("button", {
            style: button,
            disabled: !dirty,
            onClick: () => {
              const ops = Object.entries(draft)
                .filter(([key, v]) => v !== (value[key] ?? ""))
                .map(([key, v]) => ({ op: "set", path: [key], value: v }));
              if (ops.length === 0) return;
              void form.mutate(ops);
              setDraft({});
            },
          }, dirty ? "保存" : "已保存"));
      } catch (error) {
        return React.createElement("span", { style: { opacity: 0.6 } }, `配置面板异常: ${String(error).slice(0, 120)}`);
      }
    }

    const plugin = {
      inject: ["slots", "configForms"],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register(
            { name: "plugins.row.config", key: "dsh-plugin-verispring#verispring-config" },
            ConfigCard,
          )), "verispring-config: panel");
        } catch (error) {
          console.error("verispring-config client:", error);
        }
      },
    };

    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    exports.apply = plugin.apply;
    exports.inject = plugin.inject;
    return module.exports;
  },
});
