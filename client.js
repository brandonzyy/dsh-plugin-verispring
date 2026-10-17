// verispring 配置面板：组合包级配置区。
// 通过 DSH 的共享表单、菜单和模型目录渲染，配置直接显示在组合包详情页。
window.__VSP_CLIENT__ = { script: "loaded", factory: false, applied: false };
window.__ModuleLoader__.load({
  id: "dsh-plugin-verispring",
  factory: (require) => {
    window.__VSP_CLIENT__.factory = true;
    const React = require("react");
    const { Button, IconChevronDownOutlineRegular, Menu, SettingsForm, SettingsValueField, Toast } = require("@deepseek-ai/dsh-client-ui-primitives");

    const PACKAGE_NAME = "dsh-plugin-verispring";
    const DEFAULTS = {
      scoutProvider: "verispring",
      scoutModel: "deepseek-flash",
      scoutEffort: "high",
      executorProvider: "verispring",
      executorModel: "deepseek-flash",
      executorEffort: "high",
      deepQueryProvider: "verispring",
      deepQueryModel: "deepseek-flash",
      deepQueryEffort: "off",
      embeddingUrl: "https://api.siliconflow.cn/v1",
      embeddingModel: "BAAI/bge-m3",
    };
    const FALLBACK_GROUPS = [{
      id: "verispring",
      name: "Verispring",
      models: [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: { efforts: ["low", "medium", "high", "xhigh", "max"].map(id => ({ id, name: id })) } },
        { id: "deepseek-flash", name: "DeepSeek Flash", reasoning: { efforts: [{ id: "off", name: "off" }, { id: "low", name: "low" }, { id: "high", name: "high" }, { id: "max", name: "max" }] } },
      ],
    }];
    const fieldStyle = { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" };
    const labelStyle = { color: "var(--dsw-alias-label-primary)", fontSize: 13, fontWeight: 500, lineHeight: 1.5 };
    const menuTriggerStyle = {
      boxSizing: "border-box",
      width: "100%",
      height: 34,
      justifyContent: "space-between",
      padding: "0 12px",
      border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "var(--dsw-radius-md)",
      background: "var(--dsw-alias-bg-layer-3)",
      color: "var(--dsw-alias-label-primary)",
      fontSize: 13,
      lineHeight: 1.5,
      fontWeight: 400,
      textAlign: "left",
    };
    const menuValueStyle = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
    const menuChevronStyle = { flex: "none", opacity: 0.65 };
    const modelGridStyle = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, alignItems: "stretch" };
    const modelCardStyle = { minWidth: 0, height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", padding: 12, border: "0.5px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-lg)", background: "var(--dsw-alias-bg-layer-2)" };
    const modelHeadingStyle = { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, margin: "0 0 4px" };
    const modelAdviceStyle = { overflow: "hidden", color: "var(--dsw-alias-label-tertiary)", fontSize: 12, fontWeight: 400, whiteSpace: "nowrap", textOverflow: "ellipsis" };
    const credentialFieldStyle = { display: "flex", flexDirection: "column", gap: 6, padding: "2px 0 8px" };
    const credentialInputStyle = { boxSizing: "border-box", width: "100%", height: 34, padding: "0 12px", border: "0.5px solid var(--dsw-alias-border-l4)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-bg-layer-3)", font: "inherit", fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-primary)" };
    if (typeof document !== "undefined" && !document.getElementById("verispring-menu-style")) {
      const style = document.createElement("style");
      style.id = "verispring-menu-style";
      style.textContent = ".verispring-menu{display:block;width:100%}.verispring-menu>[role=menu]{box-sizing:border-box;width:100%;min-width:100%}.verispring-menu>[role=menu] [role=menuitem]{box-sizing:border-box;width:100%;height:34px;min-height:34px;padding:6px 12px;font-size:13px;line-height:1.5}";
      document.head.appendChild(style);
    }

    let fallbackForm;
    let catalogStore;
    let credentialStore;
    let embeddingCredentialStore;
    let modelConfigForm;
    let clientRemote;
    let legacyConfigMigrationStarted = false;
    const CREDENTIAL_REF = "VERISPRING_API_KEY";
    const EMBEDDING_CREDENTIAL_REF = "MANON_EMBEDDING_API_KEY";
    const emptySubscribe = () => () => {};
    const emptySnapshot = () => undefined;

    function createCatalogStore(remote) {
      let state = { groups: [] };
      let promise;
      const listeners = new Set();
      const publish = (next) => {
        state = next;
        for (const listener of listeners) listener();
      };
      const store = {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        load: () => {
          if (promise) return promise;
          promise = remote.session.modelCatalog().then((response) => {
            if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
            publish({ groups: response.value.groups });
            return response.value;
          }).catch((error) => {
            publish({ groups: [] });
            return undefined;
          });
          return promise;
        },
        reload: () => {
          promise = undefined;
          return store.load();
        },
      };
      return store;
    }

    function createCredentialStore(remote, ref = CREDENTIAL_REF) {
      let state = { configured: false, writable: false };
      let promise;
      const listeners = new Set();
      const publish = (next) => {
        state = next;
        for (const listener of listeners) listener();
      };
      const store = {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        load: () => {
          if (promise) return promise;
          promise = remote.credentials.describe([ref]).then((response) => {
            if (!response.ok) throw new Error(response.error.message);
            const info = response.value[ref];
            publish({ configured: info?.configured === true, writable: info?.writable === true });
            return info;
          }).catch(() => {
            publish({ configured: false, writable: false });
            return undefined;
          });
          return promise;
        },
        set: async (value) => {
          const response = await remote.credentials.set(ref, value);
          if (!response.ok) throw new Error(response.error.message);
          publish({ configured: true, writable: true });
        },
      };
      return store;
    }

    function groupsFor(catalog) {
      return catalog.groups.length > 0 ? catalog.groups : FALLBACK_GROUPS;
    }

    function migrateLegacyMainSessionFields(form) {
      if (legacyConfigMigrationStarted) return;
      const snapshot = form.getSnapshot();
      const value = snapshot?.value;
      if (!value || snapshot.revision === undefined) return;
      const legacyKeys = ["mainSessionProvider", "mainSessionModel", "mainSessionEffort"]
        .filter(key => Object.prototype.hasOwnProperty.call(value, key));
      if (legacyKeys.length === 0) return;
      legacyConfigMigrationStarted = true;
      void form.mutate(legacyKeys.map(key => ({ op: "remove", path: [key] })), snapshot.revision)
        .catch(() => { legacyConfigMigrationStarted = false; });
    }

    function providerLabel(group) {
      return group.id === "verispring" ? "Verispring" : (group.name || group.id);
    }

    function providerChoices(groups) {
      return groups.map(group => ({ value: group.id, label: providerLabel(group) }));
    }

    function modelLabel(model) {
      if (model.id === "deepseek-flash") return "DeepSeek Flash";
      return String(model.name || model.id || "").replace(/^verispring[\/:]/i, "");
    }

    function modelChoices(groups, provider, current) {
      const group = groups.find(item => item.id === provider);
      const choices = (group?.models ?? []).map(model => ({ value: model.id, label: modelLabel(model) }));
      if (choices.length === 0 && current) choices.push({ value: current, label: modelLabel({ id: current }) });
      return choices;
    }

    function effortChoices(groups, provider, model, current) {
      const selected = groups.find(group => group.id === provider)?.models.find(item => item.id === model);
      const choices = (selected?.reasoning?.efforts ?? []).map(effort => ({ value: effort.id, label: effortLabel(effort.id, effort.name) }));
      if (choices.length === 0) choices.push({ value: "high", label: "High" });
      if (current && !choices.some(choice => choice.value === current)) choices.push({ value: current, label: current });
      return choices;
    }

    function effortLabel(id, name) {
      const labels = { off: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
      return labels[id] || name || id;
    }

    function defaultEffort(groups, provider, model, preferred) {
      const selected = groups.find(group => group.id === provider)?.models.find(item => item.id === model);
      const available = selected?.reasoning?.efforts ?? [];
      if (available.some(effort => effort.id === preferred)) return preferred;
      if (available.some(effort => effort.id === "high")) return "high";
      return available[0]?.id || preferred;
    }

    const routeBarStyle = {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      flex: "none",
      minWidth: 0,
      maxWidth: "100%",
      boxSizing: "border-box",
      margin: 0,
      padding: "1px 8px",
      border: "none",
      borderRadius: "999px",
      background: "transparent",
      color: "var(--dsw-alias-label-tertiary)",
      fontFamily: "inherit",
      fontWeight: "inherit",
      fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
      fontVariantNumeric: "tabular-nums",
      lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    };

    function routeProviderLabel(provider) {
      return provider === "verispring" ? "Verispring" : provider;
    }

    function routeModelLabel(model) {
      return model === "deepseek-flash" ? "deepseek flash" : model;
    }

    function SubagentRouteBar({ useSession, useProjection }) {
      const session = useSession(value => value);
      const projection = useProjection("modelSelection");
      if (!session?.subagent) return null;
      const selection = projection?.next ?? projection?.selection ?? projection;
      const provider = routeProviderLabel(selection?.provider || "未知渠道");
      const model = routeModelLabel(selection?.model || "未知模型");
      const effort = selection?.reasoningEffort || "未标注";
      return React.createElement("div", { style: routeBarStyle, role: "status" },
        `${provider} · ${model} · ${effort}`,
      );
    }

    function MenuSelect({ id, label, hint, value, choices, disabled, onChange }) {
      const [open, setOpen] = React.useState(false);
      const selected = choices.find(choice => choice.value === value);
      const anchor = React.createElement(Button, {
        variant: "outline",
        size: "md",
        id,
        disabled,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => setOpen(previous => !previous),
        style: menuTriggerStyle,
      },
      React.createElement("span", { style: menuValueStyle }, selected?.label ?? value),
      React.createElement(IconChevronDownOutlineRegular, { size: 14, style: menuChevronStyle }));
      return React.createElement("div", { style: fieldStyle },
        React.createElement("label", { htmlFor: id, style: labelStyle }, label),
        React.createElement(Menu, {
          open,
          anchor,
          items: choices.map(choice => ({ id: choice.value, label: choice.label })),
          selectedId: value,
          onSelect: (next) => { setOpen(false); onChange(next); },
          onClose: () => setOpen(false),
          align: "end",
          className: "verispring-menu",
          portal: false,
          compact: false,
        }),
        hint ? React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, hint) : null,
      );
    }

    function CredentialField({ configured, value, disabled, onEdit }) {
      const [editing, setEditing] = React.useState(false);
      React.useEffect(() => {
        if (configured && value === "") setEditing(false);
      }, [configured, value]);
      const displayed = configured && !editing && value === "" ? "••••••••••••" : value;
      return React.createElement("div", { style: credentialFieldStyle },
        React.createElement("p", { style: { display: "flex", alignItems: "center", gap: 8, margin: 0, color: "var(--dsw-alias-label-primary)", fontSize: 13, lineHeight: 1.5 } },
          "联系 Wechat：jinyong0716 获取，享受 8 折原厂高品质 Claude API（98+% 缓存命中率）",
        ),
        React.createElement("input", {
          id: "verispring-api-key", type: "password", autoComplete: "new-password",
          style: credentialInputStyle, value: displayed, disabled,
          onFocus: () => { if (configured && value === "") setEditing(true); },
          onBlur: () => { if (value === "") setEditing(false); },
          onChange: event => onEdit(event.target.value),
        }),
      );
    }

    function embeddingKeyField({ configured, value, disabled, onEdit }) {
      const [editing, setEditing] = React.useState(false);
      React.useEffect(() => {
        if (configured && value === "") setEditing(false);
      }, [configured, value]);
      const displayed = configured && !editing && value === "" ? "••••••••••••" : value;
      return React.createElement("div", { style: fieldStyle },
        React.createElement("label", { htmlFor: "verispring-embedding-key", style: labelStyle }, "Key"),
        React.createElement("input", {
          id: "verispring-embedding-key", type: "password", autoComplete: "new-password", style: credentialInputStyle, value: displayed, disabled,
          onFocus: () => { if (configured && value === "") setEditing(true); },
          onBlur: () => { if (value === "") setEditing(false); },
          onChange: event => onEdit(event.target.value),
        }),
      );
    }

    function textField(key, label, hint, value, disabled, edit) {
      return React.createElement(SettingsValueField, {
        key,
        id: `verispring-${key}`,
        label,
        hint,
        text: value,
        overridden: false,
        invalid: false,
        overriddenLabel: "已覆盖",
        resetLabel: "重置",
        invalidLabel: "值无效",
        disabled,
        onEdit: (next) => edit(key, next),
        onReset: () => edit(key, ""),
      });
    }

    async function discoverAndPersist(apiKey) {
      const response = await clientRemote.llm.discoverModels("llm-pi-ai", {
        provider: "verispring",
        baseURL: "https://api.verispring.cn",
        api: "anthropic-messages",
        apiKey,
      });
      if (!response.ok) throw new Error(`模型探针失败：${response.error.message}`);
      const current = modelConfigForm.getSnapshot();
      const configured = current.value?.providers?.verispring?.models ?? [];
      const byId = new Map(configured.map(model => [model.id, model]));
      const models = response.value.map(model => ({
        ...(byId.get(model.id) ?? {}),
        id: model.id,
        ...model.name ? { name: model.name } : {},
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      }));
      const accepted = await modelConfigForm.mutate([
        { op: "set", path: ["providers", "verispring", "models"], value: models },
      ], current.revision);
      if (!accepted) throw new Error("模型目录配置保存失败，请稍后重试");
      await catalogStore.reload();
    }

    async function probeEmbeddingEndpoint(url, model, apiKey = "") {
      let endpoint;
      try { endpoint = new URL(url.replace(/\/+$/, "") + (apiKey ? "/embeddings" : "")); } catch { throw new Error("Embedding 端点探针失败：地址无效"); }
      if (!/^https?:$/.test(endpoint.protocol)) throw new Error("Embedding 端点探针失败：只支持 HTTP(S) 地址");
      if (!model.trim()) throw new Error("Embedding 模型探针失败：模型名不能为空");
      try {
        const response = await fetch(endpoint.href, apiKey ? { method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: "verispring-probe" }) } : { method: "HEAD", mode: "no-cors" });
        if (apiKey && !response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        throw new Error(`Embedding 端点探针失败：${String(error)}`);
      }
    }

    function ConfigPage({ form }) {
      const snapshot = form.state;
      const [draft, setDraft] = React.useState({});
      const [keyDraft, setKeyDraft] = React.useState("");
      const [embeddingKeyDraft, setEmbeddingKeyDraft] = React.useState("");
      const [saving, setSaving] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const [success, setSuccess] = React.useState(false);
      const catalog = React.useSyncExternalStore(catalogStore?.subscribe ?? emptySubscribe, catalogStore?.getSnapshot ?? emptySnapshot);
      const credential = React.useSyncExternalStore(credentialStore?.subscribe ?? emptySubscribe, credentialStore?.getSnapshot ?? emptySnapshot) || { configured: false, writable: false };
      const embeddingCredential = React.useSyncExternalStore(embeddingCredentialStore?.subscribe ?? emptySubscribe, embeddingCredentialStore?.getSnapshot ?? emptySnapshot) || { configured: false, writable: false };
      React.useEffect(() => {
        void catalogStore?.reload();
      }, []);
      const value = snapshot?.value ?? DEFAULTS;
      const groups = groupsFor(catalog || { groups: [] });
      const baseValue = (key) => {
        const current = String(value[key] ?? DEFAULTS[key] ?? "");
        if (current !== "") return current;
        if (key === "deepQueryEffort") return "off";
        if (key.endsWith("Effort")) return "high";
        return current;
      };
      const read = (key) => draft[key] !== undefined ? draft[key] : baseValue(key);
      const edit = (key, next) => {
        setFailed(false);
        setSuccess(false);
        setDraft(previous => ({ ...previous, [key]: next }));
      };
      const providerChoicesFor = () => providerChoices(groups);
      const scoutProvider = read("scoutProvider");
      const scoutModel = read("scoutModel");
      const scoutEffort = read("scoutEffort");
      const executorProvider = read("executorProvider");
      const executorModel = read("executorModel");
      const executorEffort = read("executorEffort");
      const deepQueryProvider = read("deepQueryProvider");
      const deepQueryModel = read("deepQueryModel");
      const deepQueryEffort = read("deepQueryEffort");
      const configDirty = Object.keys(draft).some(key => draft[key] !== baseValue(key));
      const keyDirty = keyDraft.trim().length > 0;
      const embeddingKeyDirty = embeddingKeyDraft.trim().length > 0;
      const dirty = configDirty || keyDirty || embeddingKeyDirty;
      const disabled = !snapshot || snapshot.status !== "ready" || !snapshot.writable || saving;
      const save = async () => {
        if (!snapshot || !dirty || disabled) return;
        const operations = Object.entries(draft)
          .filter(([key, next]) => next !== baseValue(key))
          .map(([key, next]) => ({ op: "set", path: [key], value: next }));
        setSaving(true);
        setFailed(false);
        setSuccess(false);
        try {
          if (keyDirty) {
            await credentialStore.set(keyDraft.trim());
            await discoverAndPersist(keyDraft.trim());
            setKeyDraft("");
          }
          if (embeddingKeyDirty) {
            await probeEmbeddingEndpoint(read("embeddingUrl"), read("embeddingModel"), embeddingKeyDraft.trim());
            await embeddingCredentialStore.set(embeddingKeyDraft.trim());
            setEmbeddingKeyDraft("");
          } else {
            await probeEmbeddingEndpoint(read("embeddingUrl"), read("embeddingModel"));
          }
          if (operations.length > 0) {
            const accepted = await form.mutate(operations, snapshot.revision);
            if (!accepted) throw new Error("配置保存失败，请稍后重试");
            setDraft({});
          }
          setSuccess(true);
        } catch {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };
      const discard = () => { setDraft({}); setKeyDraft(""); setEmbeddingKeyDraft(""); };
      const labels = {
        unavailable: "配置服务暂不可用",
        readOnly: "当前配置为只读",
        saveFailed: "保存失败，模型探针或配置检查未通过",
        save: dirty ? "保存配置" : "已保存",
        saving: "保存中…",
      };
      const section = (title, hint) => React.createElement("section", { style: { margin: "12px 0 6px" } },
        React.createElement("h4", { style: { margin: "0 0 3px", color: "var(--dsw-alias-label-primary)", fontSize: 14 } }, title),
        hint ? React.createElement("p", { style: { margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, hint) : null);
      const embeddingCard = React.createElement("section", { style: modelCardStyle },
        React.createElement("h4", { style: modelHeadingStyle },
          React.createElement("span", { style: { flex: "none", color: "var(--dsw-alias-label-primary)", fontSize: 14 } }, "Embedding"),
          React.createElement("span", { style: modelAdviceStyle, title: "更换模型后需重新 sync 重建向量" }, "更换模型后需重新 sync 重建向量"),
        ),
        textField("embeddingUrl", "端点", "", read("embeddingUrl"), disabled, edit),
        textField("embeddingModel", "模型", "", read("embeddingModel"), disabled, edit),
        embeddingKeyField({ configured: embeddingCredential.configured, value: embeddingKeyDraft, disabled: !embeddingCredential.writable || saving, onEdit: setEmbeddingKeyDraft }),
      );
      const modelCard = (title, advice, providerKey, modelKey, effortKey) => React.createElement("section", { style: modelCardStyle },
        React.createElement("h4", { style: modelHeadingStyle },
          React.createElement("span", { style: { flex: "none", color: "var(--dsw-alias-label-primary)", fontSize: 14 } }, title),
          React.createElement("span", { style: modelAdviceStyle, title: advice }, advice),
        ),
        React.createElement(MenuSelect, { id: `verispring-${providerKey}`, label: "渠道", value: read(providerKey), choices: providerChoicesFor(providerKey), disabled, onChange: next => {
          edit(providerKey, next);
          const firstModel = modelChoices(groups, next, "")[0]?.value;
          if (firstModel) edit(modelKey, firstModel);
          edit(effortKey, defaultEffort(groups, next, firstModel, effortKey === "deepQueryEffort" ? "off" : "high"));
        } }),
        React.createElement(MenuSelect, { id: `verispring-${modelKey}`, label: "模型", value: read(modelKey), choices: modelChoices(groups, read(providerKey), read(modelKey)), disabled, onChange: next => {
          edit(modelKey, next);
          edit(effortKey, defaultEffort(groups, read(providerKey), next, effortKey === "deepQueryEffort" ? "off" : "high"));
        } }),
        React.createElement(MenuSelect, { id: `verispring-${effortKey}`, label: "思考强度", value: read(effortKey), choices: effortChoices(groups, read(providerKey), read(modelKey), read(effortKey)), disabled, onChange: next => edit(effortKey, next) }),
      );
      return React.createElement(React.Fragment, null,
        React.createElement(SettingsForm, { labels, state: {
          available: snapshot?.status === "ready",
          writable: snapshot?.writable === true && credential.writable,
          dirty, invalid: false, saving, failed,
        }, onSave: save, onDiscard: discard },
          section("Verispring API Key"),
          React.createElement(CredentialField, { configured: credential.configured, value: keyDraft, disabled: !credential.writable || saving, onEdit: setKeyDraft }),
          section("语言模型与 Embedding", "选择渠道后，模型与思考强度只显示该渠道目录"),
          React.createElement("div", { style: modelGridStyle },
            modelCard("测绘智能体", "建议：高精度模型，High", "scoutProvider", "scoutModel", "scoutEffort"),
            modelCard("执行智能体", "建议：DeepSeek Flash，High", "executorProvider", "executorModel", "executorEffort"),
            modelCard("Manon Deep Query", "建议：DeepSeek Flash，Off，查询响应快", "deepQueryProvider", "deepQueryModel", "deepQueryEffort"),
            embeddingCard,
          ),
        ),
        success ? React.createElement(Toast, { text: "全部成功连通✅", tone: "success", holdMs: 4000, onDone: () => setSuccess(false) }) : null,
      );
    }

    function ConfigCard(props) {
      try {
        const fallbackSnapshot = React.useSyncExternalStore(
          fallbackForm?.subscribe ?? emptySubscribe,
          fallbackForm?.getSnapshot ?? emptySnapshot,
        );
        if (props.view === "summary") {
          return React.createElement("span", null, "Verispring 配置：模型目录下拉选择、Manon Deep Query 与 embedding 配置");
        }
        const form = fallbackForm !== undefined ? { state: fallbackSnapshot, mutate: fallbackForm.mutate } : props.form;
        if (props.view !== "page" || !form) return null;
        return React.createElement(ConfigPage, { form });
      } catch (error) {
        return React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, `配置面板异常: ${String(error).slice(0, 120)}`);
      }
    }

    const plugin = {
      inject: ["slots", "configForms", "remote", "remote.session", "remote.credentials", "remote.llm"],
      apply(ctx) {
        window.__VSP_CLIENT__.applied = true;
        ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
          name: "conversation.composer.dock",
          id: "verispring-subagent-route",
          order: -100,
        }, SubagentRouteBar));
        try {
          clientRemote = ctx.remote;
          const source = ctx.configForms.get("verispring-config");
          fallbackForm = {
            getSnapshot: () => source.getSnapshot(),
            subscribe: (listener) => source.subscribe(listener),
            mutate: (ops, revision) => source.mutate(ops, revision),
          };
          migrateLegacyMainSessionFields(source);
          modelConfigForm = ctx.configForms.get("llm-pi-ai");
          catalogStore = createCatalogStore(ctx.remote);
          credentialStore = createCredentialStore(ctx.remote, CREDENTIAL_REF);
          embeddingCredentialStore = createCredentialStore(ctx.remote, EMBEDDING_CREDENTIAL_REF);
          void catalogStore.load();
          void credentialStore.load();
          void embeddingCredentialStore.load();
          ctx.effect(() => {
            const unsubscribe = modelConfigForm?.subscribe?.(() => { void catalogStore.reload(); });
            return () => unsubscribe?.();
          }, "verispring-config: model catalog refresh");
          ctx.effect(() => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
            { name: "plugins.bundle.config", key: PACKAGE_NAME },
            ConfigCard,
          )), "verispring-config: bundle panel");
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
