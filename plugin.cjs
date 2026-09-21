"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const kit = require("@sessionbus/kit");
const version = require("./package.json").version;
const { ACTIONS } = kit;
const skillContent = fs.readFileSync(path.join(__dirname, "skills/sessionbus.md"), "utf8");

// Match the MCP tool's closed union; the public kit validates each action.
function argumentSchema() {
  const properties = {};
  for (const field of ["session_id", "host", "message", "target", "group", "product", "name", "resume_session_id", "notify_target", "input", "run_id"]) properties[field] = { type: "string" };
  for (const field of ["targets", "extra_groups"]) properties[field] = { type: "array", items: { type: "string" } };
  for (const field of ["persistent", "notify", "forget"]) properties[field] = { type: "boolean" };
  for (const field of ["auto_close_ms", "timeout_ms"]) properties[field] = { type: "integer" };
  properties.idle_message = { type: "string", enum: ["stage", "run"] };
  properties.trace = { type: "string", enum: ["off", "events", "content"] };
  properties.mode = { type: "string", enum: ["off", "events", "content"] };
  const open = {};
  for (const field of ["cwd", "permission_mode", "model", "reasoning_effort"]) open[field] = { type: "string" };
  open.arguments = { type: "array", items: { type: "string" } };
  properties.open = { type: "object", additionalProperties: false, properties: open };
  return { type: "object", additionalProperties: false, properties, description: "Use only the fields listed for the selected action in the tool description. send has no summary field; put the complete content in message." };
}

function assertKnownArguments(value, schema, location = "arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`sessionbus ${location} must be an object`);
  for (const field of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties, field)) throw new Error(`sessionbus ${location}.${field} is not supported`);
    const property = schema.properties[field];
    if (property.type === "object") assertKnownArguments(value[field], property, `${location}.${field}`);
  }
}

const name = "sessionbus-dsh";
const productPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const inject = [
  "agents", "appReady", "appExit", "permissionPresets", "sessionController",
  "sessions", "sessionTitle", "skills", "tools",
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
  if (config.product === undefined) throw new Error("product is required; re-run sessionbus-dsh-install --product <name> <profile>");
  if (typeof config.product !== "string" || !productPattern.test(config.product)) throw new Error("product must match ^[a-z0-9][a-z0-9-]{0,31}$");
  const launch = ctx.launchEnvironment || ctx.get?.("launchEnvironment");
  const value = (key) => {
    if (launch) return launch.get(key)?.value;
    return Object.hasOwn(ambient, key) ? ambient[key] : undefined;
  };
  const token = value("SESSIONBUS_LAUNCH_TOKEN");
  delete process.env.SESSIONBUS_LAUNCH_TOKEN;
  const mode = token === undefined ? "peer" : "lane";
  if (config.mode !== undefined && config.mode !== mode) throw new Error(`mode ${config.mode} conflicts with launch environment`);
  let groups = mode === "lane" ? [] : Object.hasOwn(config, "groups") ? config.groups : JSON.parse(value("SESSIONBUS_GROUPS") || "[]");
  if (!Array.isArray(groups) || groups.some((group) => !text(group)) || new Set(groups).size !== groups.length) throw new Error("groups are invalid");
  const explicitSocket = Object.hasOwn(config, "socket") ? config.socket : value("SESSIONBUS_SOCKET");
  const socket = explicitSocket ? path.resolve(explicitSocket) : value("XDG_RUNTIME_DIR")
    ? path.resolve(value("XDG_RUNTIME_DIR"), "sessionbus/presence.sock")
    : path.join("/tmp", `sessionbus-${process.getuid()}`, "presence.sock");
  const localKey = Object.hasOwn(config, "local_key") ? config.local_key : value("SESSIONBUS_LOCAL_KEY");
  if (!text(socket) || localKey !== undefined && !text(localKey)) throw new Error("connection settings are invalid");
  return { settings: { mode, product: config.product, groups: [...groups], socket, localKey }, token, trace: value("SESSIONBUS_DSH_TRACE") === "1" };
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

function renderDelivery(request) {
  const cleanAttribute = (value) => String(value).replace(/["<>\r\n]/gu, "");
  const escaped = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" };
  const metadata = JSON.stringify({ fromProduct: request.from.product, messageId: request.message_id, groups: request.from.groups || [] })
    .replace(/[<>&\u2028\u2029]/gu, (character) => escaped[character]);
  const body = request.body.replace(/<\/cross-session-message/giu, "<\\/cross-session-message");
  return `<cross-session-message from="${cleanAttribute(request.from.name || request.from.session_id)}" from-session="${cleanAttribute(request.from.session_id)}">\n[sessionbus-metadata: ${metadata}]\n${body}\n</cross-session-message>`;
}

function terminal(reason) {
  const native_stop_reason = reason?.kind;
  if (native_stop_reason === "completed") return { outcome: "completed", native_stop_reason };
  if (native_stop_reason === "aborted" || native_stop_reason === "interrupted") return { outcome: "interrupted", native_stop_reason };
  if (["blocked", "error", "max-tokens"].includes(native_stop_reason)) return { outcome: "failed", native_stop_reason };
  throw new Error(`unknown DSH turn end reason ${JSON.stringify(reason)}`);
}

class NativeSession {
  constructor(ctx, createUserMessage, ProtocolError) {
    this.ctx = ctx;
    this.createUserMessage = createUserMessage;
    this.ProtocolError = ProtocolError;
    this.receipts = new Map();
    this.deferredAdmissions = [];
    this.admissionScheduled = false;
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
    const accepted = { ...deferred(), session, observed: false };
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

  deferAdmission(call) {
    const result = deferred();
    this.deferredAdmissions.push({ call, result });
    if (!this.admissionScheduled) {
      this.admissionScheduled = true;
      // Let DSH's running-to-idle microtasks settle before one synchronous admission batch.
      setImmediate(() => {
        this.admissionScheduled = false;
        for (const admission of this.deferredAdmissions.splice(0)) {
          try { admission.result.resolve(admission.call()); }
          catch (error) { admission.result.reject(error); }
        }
      });
    }
    return result.promise;
  }

  event(session, event) {
    if (event.type === "agent/inbox/spliced") {
      for (const message of event.data.inserted || []) {
        const receipt = this.receipts.get(message.id);
        if (receipt?.session === session) { receipt.observed = true; receipt.resolve(); }
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
    const earlyError = event.type === "turn/end" && run.turn === null && run.openTurn === event.data.turn && event.data.reason?.kind === "error";
    if (event.type === "turn/end" && (run.turn === event.data.turn || earlyError)) {
      try {
        run.end = terminal(event.data.reason);
        if (earlyError) run.output = `${event.data.reason.error.code}: ${event.data.reason.error.message}`;
      }
      catch (error) { run.endError = error; }
    }
  }

  async run(cancel, token, input) {
    if (token.Interrupted()) return { outcome: "interrupted", result: "" };
    // @sessionbus/kit sdk/js/index.js:108-120 passes its text or delivery seed here.
    const delivery = typeof input?.delivery?.body === "string" ? input.delivery : undefined;
    const body = typeof input === "string" ? input : typeof input?.text === "string" ? input.text : delivery?.body;
    if (body === undefined) throw new Error("sessionbus received an unexpected run input seed shape");
    const message = this.message(delivery ? renderDelivery(delivery) : body);
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
      if (delivery) await token.ReportDelivery({ disposition: "injected" });
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

  async steerDelivery(cancel, request, agent) {
    const message = this.message(renderDelivery(request));
    const receipt = this.receipt(message, agent.session, cancel);
    try {
      try { agent.steer(message); }
      catch (error) {
        receipt.reject(error);
        return receipt.observed ? { disposition: "injected" } : { disposition: "rejected", reason: clean(error) };
      }
      try { await receipt.promise; }
      catch (error) {
        throw new this.ProtocolError({ code: -32603, message: "internal", data: { kind: "delivery_admission_uncertain", message_id: request.message_id, reason: clean(error) } });
      }
      return { disposition: "injected" };
    } finally { receipt.close(); }
  }

  deliver(cancel, request, agent = this.agent, live = () => agent === this.agent) {
    return this.deferAdmission(() => cancel?.aborted || !live()
      ? { disposition: "rejected", reason: "native owner closed" }
      : this.steerDelivery(cancel, request, agent));
  }

  laneDeliver(cancel, request, token) {
    return this.deferAdmission(() => {
      const run = token?.Native;
      if (cancel?.aborted || !run || this.active !== run || run.end || this.agent.status !== "running") {
        throw new this.ProtocolError({ code: -32004, message: "not_running" });
      }
      return this.steerDelivery(cancel, request, this.agent);
    });
  }

  async close() {
    if (!this.agent) return;
    if (this.agent.status === "running") this.agent.cancel({ kind: "disposed" });
    await this.agent.whenIdle();
    await this.ctx.sessions.flush(this.agent.session);
    this.removeEvents();
  }
}

function identity(ctx, agent, product, groups, title) {
  const sessionID = String(agent?.session?.id || "");
  if (!text(sessionID)) return;
  const cwd = agent?.session?.header?.cwd;
  if (!text(cwd)) throw new Error("DSH root identity is incomplete");
  const current = title === undefined ? ctx.sessionTitle.get(agent.session)?.title : title;
  const provider = agent.options?.provider;
  const model = agent.options?.model;
  return { product, session_id: sessionID, ...(text(current) ? { name: current } : {}), groups: [...groups], info: { cwd, ...(text(provider) && text(model) ? { model: `${provider}/${model}` } : {}) } };
}

function createRuntime(ctx, config, dependencies, prepared) {
  const configured = prepared || readConfiguration(ctx, config, dependencies.ambient);
  const values = configured.settings;
  const active = dependencies.active || (() => true);
  let launchToken = configured.token;
  const native = new NativeSession(ctx, dependencies.createUserMessage, dependencies.ProtocolError || kit.ProtocolError);
  const peers = new Map();
  const publicationErrors = new WeakSet();
  let worker;
  let workerExit = Promise.resolve();
  let ready = false;
  let warned = false;
  const warn = (error) => { if (active() && !warned) { warned = true; dependencies.stderr(`sessionbus: ${clean(error)}\n`); } };
  const trace = (message) => { if (configured.trace && active()) dependencies.stderr(`sessionbus trace: ${message}\n`); };
  const root = (agent) => ctx.agents.roots().includes(agent);
  trace(`mode=${values.mode} ready=false socket=${values.socket}`);
  const publicationError = (agent, error, record) => {
    if (record && peers.get(agent) === record) {
      record.peer?.shutdown();
      peers.delete(agent);
      // Leave it unpublished; a later title change may naturally call present() again.
    }
    if (active() && !publicationErrors.has(agent)) {
      publicationErrors.add(agent);
      dependencies.stderr(`sessionbus: ${clean(error)}\n`);
    }
  };
  const present = (agent) => {
    const isRoot = root(agent);
    const reason = values.mode !== "peer" ? "not-peer" : !ready ? "not-ready" : !isRoot ? "not-root" : peers.has(agent) ? "published" : "publish";
    trace(`present id=${agent?.session?.id || agent?.id || "unknown"} root=${isRoot} reason=${reason}`);
    if (reason !== "publish") return;
    try {
      const current = identity(ctx, agent, values.product, values.groups);
      if (!current) { trace(`present id=${agent?.id || "unknown"} root=${isRoot} reason=no-session-id`); return; }
      const record = { peer: undefined, identity: current, rehello: Promise.resolve() };
      const peer = dependencies.connectPeer(current, (cancel, request) =>
        native.deliver(cancel, request, agent, () => root(agent) && peers.get(agent) === record), connectionEnvironment(values), {
        connect: (socket) => {
          trace(`connect id=${current.session_id} socket=${socket}`);
          const stream = net.createConnection(socket);
          stream.once("connect", () => trace(`connect id=${current.session_id} state=connected`));
          stream.once("error", (error) => publicationError(agent, error, record));
          return stream;
        },
      });
      record.peer = peer;
      peers.set(agent, record);
      void peer.closed?.then(() => { if (peer.error) publicationError(agent, peer.error, record); });
    } catch (error) { publicationError(agent, error); }
  };
  const forget = (agent) => { peers.get(agent)?.peer.shutdown(); peers.delete(agent); };
  let removeCreated = () => {}, removeDisposed = () => {}, removeTitle = () => {};
  if (values.mode === "peer") {
    removeCreated = ctx.on("agent/created", ({ agent }) => { trace(`agent/created id=${agent?.session?.id || agent?.id || "unknown"} scope=global`); present(agent); }, { global: true });
    removeDisposed = ctx.on("agent/disposed", ({ agent }) => { trace(`agent/disposed id=${agent?.session?.id || agent?.id || "unknown"} scope=global`); forget(agent); }, { global: true });
    removeTitle = ctx.on("session/event", (session, event) => {
      if (event.type !== "session/title") return;
      const agent = ctx.agents.get(session.id);
      const record = peers.get(agent);
      if (!agent || agent.session !== session) return;
      if (!record) return present(agent);
      const next = identity(ctx, agent, values.product, values.groups, event.data.title);
      if (!next) return;
      const replace = next.session_id !== record.identity.session_id;
      record.identity = next;
      // kit rehello is (signal, name, info); a changed durable id needs a full replacement.
      record.rehello = record.rehello.then(() => replace ? record.peer.replace(next) : record.peer.rehello(undefined, next.name, next.info)).catch(warn);
    }, { global: true });
  }
  const caller = (agent) => worker && native.agent === agent ? worker.caller : peers.get(agent)?.peer.caller;
  const argumentsSchema = argumentSchema();
  const execute = (argumentsValue, execution) => {
    const client = caller(execution?.agent);
    if (!client) throw new Error("sessionbus requires an exact live DSH root");
    const args = argumentsValue.arguments || {};
    assertKnownArguments(args, argumentsSchema);
    return client.action(argumentsValue.action, args);
  };
  let removeGrant;
  try {
    // The peer floor guarantees this waterfall; this catch covers registration errors, not feature detection.
    removeGrant = ctx.on("tools/pre-execute", async (execution, next) =>
      execution.name === "sessionbus" ? { kind: "allow" } : next(), { prepend: true });
  } catch (error) { throw new Error(`cannot grant sessionbus tool permission: ${clean(error)}`); }
  const removeTool = ctx.tools.register(dependencies.defineTool({
    name: "sessionbus",
    description: "Call Sessionbus with an action from the list, send, spawn, describe, trace, run, start, wait, status, interrupt, close, forget, or ack enum. Use trace mode off, events or content for a direct child. Read the sessionbus skill for exact arguments, caller identity, delivery dispositions, lane policies, collection and acknowledgment discipline, tracing, and safe replies.",
    parameters: { action: { type: "string", enum: ACTIONS, required: true }, arguments: argumentsSchema },
    output: { schema: { type: "object", additionalProperties: true, properties: {} }, render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }] },
    execute,
  }));
  const removeSkill = ctx.skills.register({
    name: "sessionbus",
    description: "Discover and message Sessionbus peers, trace direct child traffic, and create, run, collect, close and resume Sessionbus lanes through the single tool.",
    source: "runtime",
    content: skillContent,
    invocation: { modelInvocable: true, userInvocable: true },
  });
  const start = () => {
    ready = true;
    trace(`mode=${values.mode} ready=true`);
    if (values.mode === "lane") {
      const environment = connectionEnvironment(values, launchToken);
      launchToken = undefined;
      worker = dependencies.serveWorker({
        hello: () => ({ product: values.product, version, supports_message_run: true, supported_open_fields: ["cwd", "permission_mode", "model", "reasoning_effort"], extra_arguments: [] }),
        open: (_cancel, request) => native.open(request),
        run: (cancel, token, input) => native.run(cancel, token, input),
        interrupt: (cancel, token) => native.interrupt(cancel, token),
        deliver: (cancel, request, _identity, token) => native.laneDeliver(cancel, request, token),
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
    trace(`mode=${values.mode} ready=false reason=close`);
    removeReady(); removeCreated(); removeDisposed(); removeTitle(); removeSkill(); removeGrant(); removeTool();
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
