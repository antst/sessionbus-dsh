"use strict";

const os = require("node:os");
const path = require("node:path");
const kit = require("@sessionbus/kit");
const version = require("./package.json").version;
const { ACTIONS } = kit;

const name = "sessionbus-dsh";
const inject = [
  "agents", "appReady", "appExit", "commands", "permissionPresets",
  "sessionController", "sessions", "sessionTitle", "tools",
];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\0\r\n]/u.test(value);
}

function clean(error) {
  return String(error?.message || error || "DSH plugin failed").replace(/[\0\r\n]/gu, " ").slice(0, 4096);
}

function readConfiguration(ctx, config = {}, ambient = process.env) {
  const launch = ctx.launchEnvironment || ctx.get?.("launchEnvironment");
  const value = (key) => {
    if (launch) return launch.get(key)?.value;
    return Object.hasOwn(ambient, key) ? ambient[key] : undefined;
  };
  const token = value("SESSIONBUS_LAUNCH_TOKEN");
  delete process.env.SESSIONBUS_LAUNCH_TOKEN;
  const mode = token === undefined ? "peer" : "lane";
  if (config.mode !== undefined && config.mode !== mode) throw new Error(`mode ${config.mode} conflicts with launch environment`);
  let groups = Object.hasOwn(config, "groups") ? config.groups : JSON.parse(value("SESSIONBUS_GROUPS") || "[]");
  if (!Array.isArray(groups) || groups.some((group) => !text(group)) || new Set(groups).size !== groups.length) throw new Error("groups are invalid");
  const socket = Object.hasOwn(config, "socket") ? config.socket : value("SESSIONBUS_SOCKET") || path.join(value("XDG_STATE_HOME") || path.join(value("HOME") || os.homedir(), ".local/state"), "sessionbus/run/presence.sock");
  const localKey = Object.hasOwn(config, "local_key") ? config.local_key : value("SESSIONBUS_LOCAL_KEY");
  if (!text(socket) || localKey !== undefined && !text(localKey)) throw new Error("connection settings are invalid");
  return { settings: { mode, groups: [...groups], socket, localKey }, token };
}

function captureContext(ctx) {
  const services = Object.fromEntries(inject.map((service) => [service, ctx[service]]));
  let launchEnvironment;
  try { launchEnvironment = ctx.launchEnvironment || ctx.get?.("launchEnvironment"); } catch {}
  const fiber = ctx.fiber;
  return {
    active: () => fiber?.uid !== null,
    context: {
      ...services,
      launchEnvironment,
      on: ctx.on.bind(ctx),
      effect: ctx.effect.bind(ctx),
    },
  };
}

function settings(ctx, config = {}, ambient = process.env) {
  return readConfiguration(ctx, config, ambient).settings;
}

function connectionEnvironment(config, token) {
  return {
    SESSIONBUS_SOCKET: config.socket,
    ...(config.localKey === undefined ? {} : { SESSIONBUS_LOCAL_KEY: config.localKey }),
    ...(token === undefined ? {} : { SESSIONBUS_LAUNCH_TOKEN: token }),
  };
}

function nativeName(value) {
  const at = value.lastIndexOf("@");
  return at < 0 ? value : value.slice(0, at);
}

function textOf(message) {
  return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : "";
}

function terminal(reason) {
  const native_stop_reason = reason?.kind;
  if (native_stop_reason === "completed") return { outcome: "completed", native_stop_reason };
  if (native_stop_reason === "aborted" || native_stop_reason === "interrupted") return { outcome: "interrupted", native_stop_reason };
  if (["blocked", "error", "max-tokens"].includes(native_stop_reason)) return { outcome: "failed", native_stop_reason };
  throw new Error(`unknown DSH turn end reason ${JSON.stringify(reason)}`);
}

class NativeSession {
  constructor(ctx, createUserMessage) {
    this.ctx = ctx;
    this.createUserMessage = createUserMessage;
    this.receipts = new Map();
    this.removeEvents = ctx.on("session/event", (session, event) => this.event(session, event), { global: true });
  }

  async open(request) {
    const options = request.open || {};
    let resolved;
    if (request.resume_session_id) {
      resolved = await this.ctx.sessionController.resolveAgent(request.resume_session_id);
    } else {
      const created = await this.ctx.sessionController.create(options.cwd ? { cwd: options.cwd } : {});
      resolved = await this.ctx.sessionController.resolveAgent(created.sessionId);
    }
    if (resolved.error) throw resolved.error;
    const agent = resolved.agent;
    const expected = request.resume_session_id || agent.id;
    if (agent.id !== expected || agent.session.id !== expected) throw new Error("DSH resolved a different native session");
    if (options.cwd !== undefined && agent.session.header.cwd !== options.cwd) throw new Error("DSH resolved a different native cwd");
    await this.ctx.sessionController.rename({ sessionId: agent.id, title: nativeName(request.name) });
    if (options.model !== undefined || options.reasoning_effort !== undefined) {
      const model = options.model || `${agent.options?.provider || ""}/${agent.options?.model || ""}`;
      const slash = model.indexOf("/");
      if (slash < 1 || slash === model.length - 1) throw new Error(`unsupported value model=${model}`);
      await this.ctx.sessionController.selectModel({ sessionId: agent.id, provider: model.slice(0, slash), model: model.slice(slash + 1), ...(options.reasoning_effort === undefined ? {} : { reasoningEffort: options.reasoning_effort }) });
    }
    if (options.permission_mode !== undefined) {
      if (!this.ctx.permissionPresets.names.includes(options.permission_mode)) throw new Error(`unsupported value permission_mode=${options.permission_mode}`);
      this.ctx.permissionPresets.set(agent.session, options.permission_mode);
    }
    await this.ctx.sessions.flush(agent.session);
    this.agent = agent;
    return { session_id: agent.id };
  }

  message(body) {
    return this.createUserMessage({ content: [{ type: "text", text: body }], source: { kind: "plugin", plugin: name, form: "relay" } });
  }

  receipt(message, session, cancel) {
    if (cancel?.aborted) throw cancel.reason || new Error("cancelled");
    const accepted = { ...deferred(), session };
    const abort = () => accepted.reject(cancel.reason || new Error("cancelled"));
    cancel?.addEventListener("abort", abort, { once: true });
    accepted.promise.catch(() => {});
    accepted.close = () => {
      cancel?.removeEventListener("abort", abort);
      if (this.receipts.get(message.id) === accepted) this.receipts.delete(message.id);
    };
    this.receipts.set(message.id, accepted);
    return accepted;
  }

  event(session, event) {
    if (event.type === "agent/inbox/spliced") {
      for (const message of event.data.inserted || []) {
        const receipt = this.receipts.get(message.id);
        if (receipt?.session === session) receipt.resolve();
      }
    }
    const run = this.active;
    if (!run || session !== this.agent?.session) return;
    if (event.type === "turn/start") run.openTurn = event.data.turn;
    if (event.type === "user/message" && event.data.id === run.message.id) {
      if (!Number.isSafeInteger(run.openTurn)) {
        run.endError = new Error("DSH consumed input outside a turn");
        return;
      }
      run.turn = run.openTurn;
    }
    if (event.type === "assistant/message" && run.turn === event.data.turn) run.output += textOf(event.data.message);
    if (event.type === "turn/end" && run.turn === event.data.turn) {
      try { run.end = terminal(event.data.reason); }
      catch (error) { run.endError = error; }
    }
  }

  async run(cancel, token, input) {
    if (token.Interrupted()) return { outcome: "interrupted", result: "" };
    const message = this.message(input);
    const record = { message, openTurn: null, turn: null, output: "", cancelled: deferred() };
    const receipt = this.receipt(message, this.agent.session, cancel);
    this.active = record;
    token.Native = record;
    record.cancelled.promise.catch(() => {});
    const abort = () => { record.cancelled.reject(cancel.reason || new Error("cancelled")); this.receipts.get(message.id)?.reject(cancel.reason || new Error("cancelled")); };
    cancel.addEventListener("abort", abort, { once: true });
    try {
      try { this.agent.followup(message); }
      catch (error) { receipt.reject(error); throw error; }
      await receipt.promise;
      const idle = this.agent.whenIdle();
      idle.catch(() => {});
      await Promise.race([idle, record.cancelled.promise]);
      if (record.endError) throw record.endError;
      if (record.end) return { ...record.end, result: record.output };
      if (record.cancelReason) return { outcome: "interrupted", native_stop_reason: record.cancelReason, result: record.output };
      throw new Error("DSH reached idle without turn/end");
    } finally {
      receipt.close();
      cancel.removeEventListener("abort", abort);
      if (this.active === record) this.active = null;
      if (token.Native === record) token.Native = null;
    }
  }

  interrupt(_cancel, token) {
    if (token.Native) {
      token.Native.cancelReason = "aborted:user";
      this.agent.cancel({ kind: "user" }, { keepInbox: true });
    }
  }

  async deliver(cancel, request, agent = this.agent) {
    const message = this.message(request.body);
    if (agent.status === "running") {
      const receipt = this.receipt(message, agent.session, cancel);
      try {
        try { agent.steer(message); }
        catch (error) { receipt.reject(error); throw error; }
        await receipt.promise;
      } finally { receipt.close(); }
    } else {
      const event = await agent.session.append("user/message", message, { surfaceOp: "append" });
      if (event?.type !== "user/message" || event.data?.id !== message.id) throw new Error("DSH did not commit the delivered message");
    }
    return { disposition: "injected" };
  }

  async close() {
    if (!this.agent) return;
    if (this.agent.status === "running") this.agent.cancel({ kind: "disposed" });
    await this.agent.whenIdle();
    await this.ctx.sessions.flush(this.agent.session);
    this.removeEvents();
  }
}

function identity(ctx, agent, groups, title) {
  const sessionID = String(agent?.session?.id || agent?.id || "");
  const cwd = agent?.session?.header?.cwd;
  if (!text(sessionID) || !text(cwd)) throw new Error("DSH root identity is incomplete");
  const current = title === undefined ? ctx.sessionTitle.get(agent.session)?.title : title;
  const provider = agent.options?.provider;
  const model = agent.options?.model;
  return { product: "dashi", session_id: sessionID, name: text(current) ? current : sessionID, groups: [...groups], info: { cwd, ...(text(provider) && text(model) ? { model: `${provider}/${model}` } : {}) } };
}

function createRuntime(ctx, config, dependencies, prepared) {
  const configured = prepared || readConfiguration(ctx, config, dependencies.ambient);
  const values = configured.settings;
  const active = dependencies.active || (() => true);
  let launchToken = configured.token;
  const native = new NativeSession(ctx, dependencies.createUserMessage);
  const peers = new Map();
  let worker;
  let workerExit = Promise.resolve();
  let ready = false;
  let warned = false;
  const warn = (error) => { if (active() && !warned) { warned = true; dependencies.stderr(`sessionbus: ${clean(error)}\n`); } };
  const root = (agent) => ctx.agents.roots().includes(agent);
  const present = (agent) => {
    if (values.mode !== "peer" || !ready || !root(agent) || peers.has(agent)) return;
    try {
      const current = identity(ctx, agent, values.groups);
      const peer = dependencies.connectPeer(current, (cancel, request) => native.deliver(cancel, request, agent), connectionEnvironment(values));
      peers.set(agent, { peer, identity: current, rehello: Promise.resolve() });
    } catch (error) { warn(error); }
  };
  const forget = (agent) => { peers.get(agent)?.peer.shutdown(); peers.delete(agent); };
  let removeCreated = () => {}, removeDisposed = () => {}, removeTitle = () => {};
  if (values.mode === "peer") {
    removeCreated = ctx.on("agent/created", ({ agent }) => present(agent));
    removeDisposed = ctx.on("agent/disposed", ({ agent }) => forget(agent));
    removeTitle = ctx.on("session/event", (session, event) => {
      if (event.type !== "session/title") return;
      const agent = ctx.agents.get(session.id);
      const record = peers.get(agent);
      if (!record || agent.session !== session) return;
      const next = identity(ctx, agent, values.groups, event.data.title);
      record.identity = next;
      record.rehello = record.rehello.then(() => record.peer.rehello({ name: next.name, info: next.info })).catch(warn);
    }, { global: true });
  }
  const caller = (agent) => worker && native.agent === agent ? worker.caller : peers.get(agent)?.peer.caller;
  const execute = (argumentsValue, execution) => {
    const client = caller(execution?.agent);
    if (!client) throw new Error("sessionbus requires an exact live DSH root");
    return client.action(argumentsValue.action, argumentsValue.arguments || {});
  };
  ctx.tools.register(dependencies.defineTool({
    name: "sessionbus",
    description: "List and control sessionbus sessions.",
    parameters: { action: { type: "string", enum: ACTIONS, required: true }, arguments: { type: "object", additionalProperties: true } },
    output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }] },
    execute,
  }));
  ctx.commands.register({
    name: "sessionbus",
    description: "list sessionbus sessions",
    handler: async (invocation) => ({ kind: "success", text: JSON.stringify(await execute({ action: "list", arguments: {} }, { agent: invocation.agent })) }),
  });
  const start = () => {
    ready = true;
    if (values.mode === "lane") {
      const environment = connectionEnvironment(values, launchToken);
      launchToken = undefined;
      worker = dependencies.serveWorker({
        hello: () => ({ product: "dashi", version, supported_open_fields: ["cwd", "permission_mode", "model", "reasoning_effort"], extra_arguments: [] }),
        open: (_cancel, request) => native.open(request),
        run: (cancel, token, input) => native.run(cancel, token, input),
        interrupt: (cancel, token) => native.interrupt(cancel, token),
        deliver: (cancel, request) => native.deliver(cancel, request),
        close: () => native.close(),
      }, environment);
      workerExit = worker.closed.then(async () => {
        const failure = await worker.serving?.catch((error) => error);
        if (!active()) return;
        if (failure && !worker.opened) { warn(failure); ctx.appExit(1); } else ctx.appExit(0);
      });
    } else {
      for (const agent of ctx.agents.roots()) present(agent);
    }
  };
  const removeReady = ctx.appReady.onReady(start);
  const close = () => {
    removeReady(); removeCreated(); removeDisposed(); removeTitle();
    for (const agent of peers.keys()) forget(agent);
    worker?.shutdown(); native.removeEvents();
  };
  ctx.effect(() => close, "sessionbus-dsh.lifecycle");
  return { close, execute, native, peers, settings: values, start, get worker() { return worker; }, get workerExit() { return workerExit; } };
}

async function activate(ctx, config = {}, dependencies = {}, prepared) {
  const configured = prepared || readConfiguration(ctx, config, dependencies.ambient);
  const [{ createUserMessage }, { defineTool }] = await Promise.all([
    dependencies.createUserMessage ? { createUserMessage: dependencies.createUserMessage } : (dependencies.importLLM || (() => import("@deepseek-ai/dsh-llm")))(),
    dependencies.defineTool ? { defineTool: dependencies.defineTool } : (dependencies.importTools || (() => import("@deepseek-ai/dsh-tools")))(),
  ]);
  if (dependencies.active && !dependencies.active()) return;
  return createRuntime(ctx, config, { ...kit, active: () => true, stderr: (line) => process.stderr.write(line), ...dependencies, createUserMessage, defineTool }, configured);
}

function apply(ctx, config = {}, dependencies = {}) {
  let captured, prepared;
  try {
    captured = captureContext(ctx);
    prepared = readConfiguration(captured.context, config, dependencies.ambient);
  } catch (error) {
    (dependencies.stderr || ((line) => process.stderr.write(line)))(`sessionbus: ${clean(error)}\n`);
    try { ctx.appExit(1); } catch {}
    return;
  }
  const runtimeDependencies = { stderr: (line) => process.stderr.write(line), ...dependencies, active: captured.active };
  void activate(captured.context, config, runtimeDependencies, prepared).catch((error) => {
    if (!captured.active()) return;
    runtimeDependencies.stderr(`sessionbus: ${clean(error)}\n`);
    captured.context.appExit(1);
  });
}

module.exports = { ACTIONS, NativeSession, activate, apply, connectionEnvironment, createRuntime, identity, inject, name, settings, terminal };
