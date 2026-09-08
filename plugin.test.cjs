"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ACTIONS, activate, apply, createRuntime, settings, terminal } = require("./plugin.cjs");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Context {
  constructor() {
    this.fiber = { uid: 1 };
    this.listeners = new Map();
    this.roots = [];
    this.exits = [];
    this.calls = [];
    this.titles = new Map();
    this.agents = { roots: () => [...this.roots], get: (id) => this.roots.find((agent) => agent.session.id === id) };
    this.appReady = { onReady: (call) => { this.ready = call; return () => { this.ready = null; }; } };
    this.appExit = (code) => { this.exits.push(code); };
    this.sessionTitle = { get: (session) => this.titles.get(session) };
    this.permissionPresets = { names: ["ask", "never"], set: (session, preset) => this.calls.push(["permission", session.id, preset]) };
    this.sessions = { flush: async (session) => { this.calls.push(["flush", session.id]); } };
    this.sessionController = {
      create: async (request) => {
        this.calls.push(["create", request]);
        if (request.cwd) this.byID.get("session-fresh").session.header.cwd = request.cwd;
        return { sessionId: "session-fresh" };
      },
      resolveAgent: async (id) => ({ agent: this.byID.get(id) }),
      rename: async (request) => { this.calls.push(["rename", request]); },
      selectModel: async (request) => { this.calls.push(["model", request]); },
    };
    this.tools = { register: (tool) => { this.tool = tool; return () => {}; } };
    this.commands = { register: (command) => { this.command = command; return () => {}; } };
    this.byID = new Map();
  }
  get(name) { return name === "launchEnvironment" ? this.launchEnvironment : undefined; }
  on(name, call) {
    const list = this.listeners.get(name) || [];
    list.push(call);
    this.listeners.set(name, list);
    return () => this.listeners.set(name, list.filter((item) => item !== call));
  }
  emit(name, ...values) { for (const call of this.listeners.get(name) || []) call(...values); }
  effect(call) { this.dispose = call(); }
}

test("short print lifecycle disposes before imports without plugin output", async () => {
  const ctx = new Context();
  const llm = deferred(), tools = deferred(), output = [];
  apply(ctx, {}, {
    ambient: {},
    stderr: (line) => output.push(line),
    importLLM: () => llm.promise,
    importTools: () => tools.promise,
  });
  ctx.fiber.uid = null;
  llm.resolve({ createUserMessage() { throw new Error("late message factory used"); } });
  tools.resolve({ defineTool() { throw new Error("late tool factory used"); } });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(output, []);
  assert.deepEqual(ctx.exits, []);
  assert.equal(ctx.tool, undefined);
  assert.equal(ctx.command, undefined);
});

function agent(ctx, id = "session-fresh") {
  const session = {
    id,
    header: { cwd: "/workspace" },
    append: async (type, message, options) => {
      ctx.calls.push(["append", type, message, options]);
      return { type, data: message };
    },
  };
  const value = {
    id,
    session,
    status: "idle",
    options: { provider: "provider", model: "default" },
    cancel: (...args) => ctx.calls.push(["cancel", ...args]),
    whenIdle: async () => { ctx.calls.push(["idle", id]); },
  };
  ctx.roots.push(value);
  ctx.byID.set(id, value);
  return value;
}

function dependencies(ctx) {
  let sequence = 0;
  const closed = deferred();
  const serving = deferred();
  const result = {
    ambient: {},
    stderr: (line) => { result.errors.push(line); },
    errors: [],
    createUserMessage: (value) => ({ id: `message-${++sequence}`, ...value }),
    defineTool: (tool) => tool,
    serveWorker: (callbacks, environment) => {
      const worker = { caller: result.workerCaller, closed: closed.promise, serving: serving.promise, opened: false, shutdown: () => { result.workerStopped = true; } };
      result.callbacks = { ...callbacks, open: async (...args) => { const value = await callbacks.open(...args); worker.opened = true; return value; } };
      result.workerEnvironment = environment;
      result.worker = worker;
      return worker;
    },
    connectPeer: (identity, deliver, environment) => {
      const peer = {
        caller: { action: (action, request) => ({ action, request }) },
        deliver,
        environment,
        identity,
        rehello: async (next) => { peer.rehelloed = next; },
        shutdown: () => { peer.stopped = true; },
      };
      result.peers.push(peer);
      return peer;
    },
    peers: [],
    workerCaller: { action: (action, request) => ({ action, request, worker: true }) },
    closeWorker: () => { serving.resolve(new Error("connection closed")); closed.resolve(); },
    failWorker: (error) => { serving.reject(error); closed.resolve(); },
  };
  return result;
}

function lane(ctx, config = {}) {
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_LAUNCH_TOKEN: "token", SESSIONBUS_SOCKET: "/run/sessionbus.sock" };
  const runtime = createRuntime(ctx, config, deps);
  ctx.ready();
  return { deps, runtime };
}

async function openedLane() {
  const ctx = new Context();
  const native = agent(ctx);
  const values = lane(ctx);
  await values.deps.callbacks.open(null, { name: "worker@host", groups: [], open: {} });
  return { ctx, native, ...values };
}

async function heldRun() {
  const values = await openedLane();
  const idle = deferred(), idleStarted = deferred();
  values.native.status = "running";
  values.native.whenIdle = async () => {
    values.ctx.calls.push(["idle", values.native.id]);
    idleStarted.resolve();
    return idle.promise;
  };
  values.native.followup = (message) => {
    values.ctx.emit("session/event", values.native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } });
    values.ctx.emit("session/event", values.native.session, { type: "turn/start", data: { turn: 9 } });
    values.ctx.emit("session/event", values.native.session, { type: "user/message", data: message });
  };
  const token = { Native: null, Interrupted: () => false };
  const running = values.deps.callbacks.run(new AbortController().signal, token, "hold");
  await idleStarted.promise;
  return { ...values, idle, running, token };
}

test("settings use config, environment, and default precedence", () => {
  const ctx = new Context();
  const launch = new Map([
    ["SESSIONBUS_GROUPS", { value: '["env"]' }],
    ["SESSIONBUS_SOCKET", { value: "/env.sock" }],
    ["SESSIONBUS_LOCAL_KEY", { value: "env-key" }],
  ]);
  ctx.launchEnvironment = { get: (key) => launch.get(key) };
  assert.deepEqual(settings(ctx, { groups: ["config"], socket: "/config.sock", local_key: "config-key" }), {
    mode: "peer", groups: ["config"], socket: "/config.sock", localKey: "config-key",
  });
  assert.deepEqual(settings(ctx), { mode: "peer", groups: ["env"], socket: "/env.sock", localKey: "env-key" });
  assert.throws(() => settings(ctx, { mode: "lane" }), /conflicts/);
  assert.throws(() => settings(new Context(), { groups: ["same", "same"] }, { HOME: "/home/test" }), /groups/);
  assert.equal(settings(new Context(), {}, { HOME: "/home/test" }).socket, "/home/test/.local/state/sessionbus/run/presence.sock");
});

test("launch token is scrubbed and retained only by the kit handoff", async (t) => {
  const previous = process.env.SESSIONBUS_LAUNCH_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.SESSIONBUS_LAUNCH_TOKEN; else process.env.SESSIONBUS_LAUNCH_TOKEN = previous;
  });
  process.env.SESSIONBUS_LAUNCH_TOKEN = "ambient-copy";
  const ctx = new Context();
  const launch = new Map([["SESSIONBUS_LAUNCH_TOKEN", { value: "snapshot-secret" }], ["SESSIONBUS_SOCKET", { value: "/run/sessionbus.sock" }]]);
  ctx.launchEnvironment = { get: (key) => launch.get(key) };
  const deps = dependencies(ctx);
  const activating = activate(ctx, {}, deps);
  assert.equal(process.env.SESSIONBUS_LAUNCH_TOKEN, undefined);
  const runtime = await activating;
  assert.equal(Object.hasOwn(runtime.settings, "token"), false);
  ctx.ready();
  delete deps.workerEnvironment.SESSIONBUS_LAUNCH_TOKEN;
  deps.callbacks.hello();
  assert.equal(launch.get("SESSIONBUS_LAUNCH_TOKEN").value, "snapshot-secret");
  assert.equal(JSON.stringify(runtime).includes("snapshot-secret"), false);
});

test("worker hello and fresh open map every advertised field", async () => {
  const ctx = new Context();
  const native = agent(ctx);
  const { deps } = lane(ctx);
  assert.deepEqual(deps.callbacks.hello(), {
    product: "dashi", version: "0.1.0-pre.1", supported_open_fields: ["cwd", "permission_mode", "model", "reasoning_effort"], extra_arguments: [],
  });
  const result = await deps.callbacks.open(null, {
    name: "parent/worker@host", groups: [], open: { cwd: "/other", permission_mode: "never", model: "vendor/model/name", reasoning_effort: "high" },
  });
  assert.deepEqual(result, { session_id: native.id });
  assert.deepEqual(ctx.calls, [
    ["create", { cwd: "/other" }],
    ["rename", { sessionId: native.id, title: "parent/worker" }],
    ["model", { sessionId: native.id, provider: "vendor", model: "model/name", reasoningEffort: "high" }],
    ["permission", native.id, "never"],
    ["flush", native.id],
  ]);
  assert.deepEqual(deps.workerEnvironment, { SESSIONBUS_SOCKET: "/run/sessionbus.sock", SESSIONBUS_LAUNCH_TOKEN: "token" });
  const extra = agent(ctx, "session-extra");
  ctx.emit("agent/created", { agent: extra });
  assert.equal(deps.peers.length, 0);
});

test("resume keeps exact identity and uses the current model for effort", async () => {
  const ctx = new Context();
  const native = agent(ctx, "session-resume");
  const { deps } = lane(ctx);
  assert.deepEqual(await deps.callbacks.open(null, { name: "resumed@host", groups: [], resume_session_id: native.id, open: { reasoning_effort: "low" } }), { session_id: native.id });
  assert.equal(ctx.calls.some(([call]) => call === "create"), false);
  assert.deepEqual(ctx.calls.find(([call]) => call === "model")[1], { sessionId: native.id, provider: "provider", model: "default", reasoningEffort: "low" });
});

test("run correlates receipt, turn, output, and terminal", async () => {
  const { ctx, native, deps } = await openedLane();
  native.followup = (message) => {
    ctx.emit("session/event", native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } });
    ctx.emit("session/event", native.session, { type: "turn/start", data: { turn: 4 } });
    ctx.emit("session/event", native.session, { type: "user/message", data: message });
    ctx.emit("session/event", native.session, { type: "assistant/message", data: { turn: 4, message: { content: [{ type: "text", text: "one" }, { type: "text", text: " two" }] } } });
    ctx.emit("session/event", native.session, { type: "turn/end", data: { turn: 4, reason: { kind: "completed" } } });
  };
  const token = { Native: null, Interrupted: () => false };
  assert.deepEqual(await deps.callbacks.run(new AbortController().signal, token, "hello"), { outcome: "completed", native_stop_reason: "completed", result: "one two" });
  assert.equal(token.Native, null);
  assert.deepEqual(ctx.calls.at(-1), ["idle", native.id]);
});

test("input consumed outside a turn fails truthfully only after idle", async () => {
  const { ctx, native, deps } = await openedLane();
  const idle = deferred();
  native.whenIdle = () => idle.promise;
  native.followup = (message) => {
    ctx.emit("session/event", native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } });
    ctx.emit("session/event", native.session, { type: "user/message", data: message });
  };
  let settled = false;
  const running = deps.callbacks.run(new AbortController().signal, { Native: null, Interrupted: () => false }, "misordered");
  running.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  idle.resolve();
  await assert.rejects(running, /DSH consumed input outside a turn/);
});

test("cancel with turn end keeps the native aborted reason at idle", async () => {
  const { ctx, native, deps, idle, running, token } = await heldRun();
  let settled = false;
  running.then(() => { settled = true; }, () => { settled = true; });
  deps.callbacks.interrupt(null, token);
  ctx.emit("session/event", native.session, { type: "turn/end", data: { turn: 9, reason: { kind: "aborted", reason: { kind: "user" } } } });
  await Promise.resolve();
  assert.equal(settled, false);
  idle.resolve();
  assert.deepEqual(await running, { outcome: "interrupted", native_stop_reason: "aborted", result: "" });
});

test("cancel without turn end settles interrupted when the agent becomes idle", async () => {
  const { ctx, deps, idle, running, token } = await heldRun();
  deps.callbacks.interrupt(null, token);
  idle.resolve();
  assert.deepEqual(await running, { outcome: "interrupted", native_stop_reason: "aborted:user", result: "" });
  assert.deepEqual(ctx.calls.find(([call]) => call === "cancel"), ["cancel", { kind: "user" }, { keepInbox: true }]);
});

test("session close after a missing turn end keeps the interrupt terminal", async () => {
  const { ctx, native, deps, idle, running, token } = await heldRun();
  deps.callbacks.interrupt(null, token);
  idle.resolve();
  assert.deepEqual(await running, { outcome: "interrupted", native_stop_reason: "aborted:user", result: "" });
  native.status = "idle";
  await deps.callbacks.close();
  assert.deepEqual(ctx.calls.filter(([call]) => call === "cancel"), [["cancel", { kind: "user" }, { keepInbox: true }]]);
  assert.deepEqual(ctx.calls.at(-1), ["flush", native.id]);
});

test("a missing turn end cannot leak its turn into the next run", async () => {
  const { ctx, native, deps } = await openedLane();
  const idles = [deferred(), deferred()];
  let nextIdle = 0;
  native.status = "running";
  native.whenIdle = () => idles[nextIdle++].promise;
  let nextRun = 0;
  native.followup = (message) => {
    ctx.emit("session/event", native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } });
    if (nextRun++ === 0) ctx.emit("session/event", native.session, { type: "turn/start", data: { turn: 41 } });
    ctx.emit("session/event", native.session, { type: "user/message", data: message });
  };

  const firstToken = { Native: null, Interrupted: () => false };
  const first = deps.callbacks.run(new AbortController().signal, firstToken, "first");
  deps.callbacks.interrupt(null, firstToken);
  idles[0].resolve();
  assert.deepEqual(await first, { outcome: "interrupted", native_stop_reason: "aborted:user", result: "" });

  const second = deps.callbacks.run(new AbortController().signal, { Native: null, Interrupted: () => false }, "second");
  let settled = false;
  second.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  idles[1].resolve();
  await assert.rejects(second, /DSH consumed input outside a turn/);
});

test("pre-aborted run and active delivery create no native receipt", async () => {
  const { native, deps, runtime } = await openedLane();
  let nativeCalls = 0;
  native.followup = native.steer = () => { nativeCalls++; };
  native.status = "running";
  const cancel = new AbortController();
  cancel.abort(new Error("already cancelled"));
  await assert.rejects(deps.callbacks.run(cancel.signal, { Native: null, Interrupted: () => false }, "run"), /already cancelled/);
  await assert.rejects(deps.callbacks.deliver(cancel.signal, { body: "deliver" }), /already cancelled/);
  assert.equal(nativeCalls, 0);
  assert.equal(runtime.native.receipts.size, 0);
});

test("throwing followup and steer settle receipts and remove cancel listeners", async (t) => {
  const { native, deps, runtime } = await openedLane();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.removeListener("unhandledRejection", onUnhandled));
  const tracked = () => {
    const listeners = new Set();
    return { aborted: false, addEventListener: (_name, call) => listeners.add(call), removeEventListener: (_name, call) => listeners.delete(call), listeners };
  };
  const runCancel = tracked();
  native.followup = () => { throw new Error("followup failed"); };
  await assert.rejects(deps.callbacks.run(runCancel, { Native: null, Interrupted: () => false }, "run"), /followup failed/);
  native.status = "running";
  const deliverCancel = tracked();
  native.steer = () => { throw new Error("steer failed"); };
  await assert.rejects(deps.callbacks.deliver(deliverCancel, { body: "deliver" }), /steer failed/);
  native.followup = () => {};
  const cancelled = new AbortController();
  const running = deps.callbacks.run(cancelled.signal, { Native: null, Interrupted: () => false }, "cancelled");
  cancelled.abort(new Error("connection lost"));
  await assert.rejects(running, /connection lost/);
  await Promise.resolve();
  assert.equal(runCancel.listeners.size + deliverCancel.listeners.size, 0);
  assert.equal(runtime.native.receipts.size, 0);
  assert.deepEqual(unhandled, []);
});

for (const [reason, outcome] of [["completed", "completed"], ["aborted", "interrupted"], ["interrupted", "interrupted"], ["blocked", "failed"], ["error", "failed"], ["max-tokens", "failed"]]) {
  test(`turn end ${reason} maps to ${outcome}`, () => assert.deepEqual(terminal({ kind: reason }), { outcome, native_stop_reason: reason }));
}

test("pre-interrupted run creates no native work and interrupt is exact", async () => {
  const { ctx, native, deps } = await openedLane();
  let followed = false;
  native.followup = () => { followed = true; };
  assert.deepEqual(await deps.callbacks.run(new AbortController().signal, { Interrupted: () => true }, "stop"), { outcome: "interrupted", result: "" });
  assert.equal(followed, false);
  deps.callbacks.interrupt(null, { Native: {} });
  assert.deepEqual(ctx.calls.at(-1), ["cancel", { kind: "user" }, { keepInbox: true }]);
});

test("delivery appends while idle and waits for steer receipt while running", async () => {
  const { ctx, native, deps } = await openedLane();
  assert.deepEqual(await deps.callbacks.deliver(null, { body: "idle" }), { disposition: "injected" });
  assert.deepEqual(ctx.calls.find(([call]) => call === "append").slice(0, 2), ["append", "user/message"]);
  native.status = "running";
  native.steer = (message) => ctx.emit("session/event", native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } });
  assert.deepEqual(await deps.callbacks.deliver(null, { body: "active" }), { disposition: "injected" });
});

test("close cancels running work, idles, flushes, and closed exits", async () => {
  const { ctx, native, deps, runtime } = await openedLane();
  native.status = "running";
  await deps.callbacks.close();
  assert.deepEqual(ctx.calls.slice(-3), [["cancel", { kind: "disposed" }], ["idle", native.id], ["flush", native.id]]);
  deps.closeWorker();
  await runtime.workerExit;
  assert.deepEqual(ctx.exits, [0]);
});

test("peer mode tracks roots, re-hellos titles, and binds tools to the executing root", async () => {
  const ctx = new Context();
  const one = agent(ctx, "session-one");
  ctx.titles.set(one.session, { title: "Original" });
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_SOCKET: "/run/sessionbus.sock", SESSIONBUS_GROUPS: '["team"]' };
  const runtime = createRuntime(ctx, {}, deps);
  assert.equal(deps.peers.length, 0);
  ctx.ready();
  assert.equal(deps.peers.length, 1);
  assert.equal(ctx.tool.name, "sessionbus");
  assert.deepEqual(deps.peers[0].identity, { product: "dashi", session_id: one.id, name: "Original", groups: ["team"], info: { cwd: "/workspace", model: "provider/default" } });
  assert.deepEqual(await ctx.tool.execute({ action: "start", arguments: { session_id: "target", input: "go" } }, { agent: one }), { action: "start", request: { session_id: "target", input: "go" } });
  assert.deepEqual(await ctx.command.handler({ agent: one, rawInput: "ignored" }), { kind: "success", text: JSON.stringify({ action: "list", request: {} }) });
  ctx.emit("session/event", one.session, { type: "session/title", data: { title: "Renamed" } });
  await Promise.resolve();
  assert.deepEqual(deps.peers[0].rehelloed, { name: "Renamed", info: { cwd: "/workspace", model: "provider/default" } });
  ctx.emit("agent/disposed", { agent: one });
  assert.equal(deps.peers[0].stopped, true);
  const created = agent(ctx, "session-two");
  ctx.emit("agent/created", { agent: created });
  assert.equal(deps.peers.at(-1).identity.session_id, created.id);
  runtime.close();
});

test("peer title re-hellos are serialized and finish on the newest title", async () => {
  const ctx = new Context();
  const one = agent(ctx, "session-one");
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_SOCKET: "/run/sessionbus.sock" };
  const acknowledgements = [deferred(), deferred()];
  const titles = [];
  deps.connectPeer = (identity) => ({
    identity,
    caller: deps.workerCaller,
    shutdown() {},
    async rehello(next) { const position = titles.push(next.name) - 1; await acknowledgements[position].promise; this.identity = { ...this.identity, ...next }; },
  });
  const runtime = createRuntime(ctx, {}, deps);
  ctx.ready();
  ctx.emit("session/event", one.session, { type: "session/title", data: { title: "First" } });
  ctx.emit("session/event", one.session, { type: "session/title", data: { title: "Newest" } });
  await Promise.resolve();
  assert.deepEqual(titles, ["First"]);
  acknowledgements[1].resolve();
  acknowledgements[0].resolve();
  await runtime.peers.get(one).rehello;
  assert.deepEqual(titles, ["First", "Newest"]);
  assert.equal(runtime.peers.get(one).peer.identity.name, "Newest");
});

test("worker boot failure reports once and exits one before admission", async () => {
  const ctx = new Context();
  const { deps, runtime } = lane(ctx);
  deps.failWorker(new Error("bad\0boot\nline"));
  await runtime.workerExit;
  assert.deepEqual(deps.errors, ["sessionbus: bad boot line\n"]);
  assert.deepEqual(ctx.exits, [1]);
});
