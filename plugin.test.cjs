"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { connectPeer, serveWorker } = require("@sessionbus/kit");
const { ACTIONS, activate, apply, createRuntime, settings, terminal } = require("./plugin.cjs");
const packageVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Context {
  constructor() {
    this.fiber = { uid: 1 };
    this.listeners = new Map();
    this.globalListeners = new WeakSet();
    this.roots = [];
    this.exits = [];
    this.calls = [];
    this.registeredTools = new Map();
    this.titles = new Map();
    this.agents = { roots: () => [...this.roots], get: (id) => this.roots.find((agent) => agent.session?.id === id) };
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
    this.tools = { register: (tool) => {
      if (this.registeredTools.has(tool.name)) throw new Error("duplicate tool");
      this.registeredTools.set(tool.name, tool);
      if (tool.name === "sessionbus") this.tool = tool;
      return () => { this.registeredTools.delete(tool.name); if (this.tool === tool) this.tool = undefined; };
    } };
    this.commands = { register: (command) => { if (this.command) throw new Error("duplicate command"); this.command = command; return () => { if (this.command === command) this.command = undefined; }; } };
    this.byID = new Map();
  }
  get(name) { return name === "launchEnvironment" ? this.launchEnvironment : undefined; }
  on(name, call, options = {}) {
    const list = this.listeners.get(name) || [];
    if (options.prepend) list.unshift(call); else list.push(call);
    if (options.global) this.globalListeners.add(call);
    this.listeners.set(name, list);
    return () => this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== call));
  }
  emit(name, ...values) { for (const call of this.listeners.get(name) || []) call(...values); }
  emitGlobal(name, ...values) { for (const call of this.listeners.get(name) || []) if (this.globalListeners.has(call)) call(...values); }
  effect(call) { this.dispose = call(); }
}

test("short print lifecycle disposes before imports without plugin output", async () => {
  const ctx = new Context();
  const llm = deferred(), tools = deferred(), output = [];
  apply(ctx, { product: "dashi" }, {
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

test("a row without product fails once with the installer fix", () => {
  const ctx = new Context();
  const output = [];
  apply(ctx, {}, { stderr: (line) => output.push(line) });
  assert.deepEqual(output, ["sessionbus: product is required; re-run sessionbus-dsh-install --product <name> <profile>\n"]);
  assert.deepEqual(ctx.exits, [1]);
  assert.equal(ctx.tool, undefined);
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
        rehello: async (signal, name, info) => {
          assert.equal(signal, undefined);
          peer.rehelloed = { name, info };
          peer.identity = { ...peer.identity, info };
          if (name === undefined) delete peer.identity.name; else peer.identity.name = name;
        },
        replace: async (next) => { peer.replaced = next; peer.identity = next; },
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
  const runtime = createRuntime(ctx, { product: "sessionbus-dsh", ...config }, deps);
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
  assert.deepEqual(settings(ctx, { product: "dashi", groups: ["config"], socket: "/config.sock", local_key: "config-key" }), {
    mode: "peer", product: "dashi", groups: ["config"], socket: "/config.sock", localKey: "config-key",
  });
  assert.deepEqual(settings(ctx, { product: "dsh" }), { mode: "peer", product: "dsh", groups: ["env"], socket: "/env.sock", localKey: "env-key" });
  assert.throws(() => settings(ctx, { product: "dashi", mode: "lane" }), /conflicts/);
  assert.throws(() => settings(new Context(), { product: "dashi", groups: ["same", "same"] }, {}), /groups/);
  assert.equal(settings(new Context(), { product: "dashi" }, { SESSIONBUS_SOCKET: "relative.sock" }).socket, path.resolve("relative.sock"));
  assert.equal(settings(new Context(), { product: "dashi" }, { SESSIONBUS_SOCKET: "/absolute.sock" }).socket, "/absolute.sock");
  assert.equal(settings(new Context(), { product: "dashi" }, { XDG_RUNTIME_DIR: "/run/user/123" }).socket, "/run/user/123/sessionbus/presence.sock");
  assert.equal(settings(new Context(), { product: "dashi" }, {}).socket, `/tmp/sessionbus-${process.getuid()}/presence.sock`);
  assert.throws(() => settings(new Context()), /re-run sessionbus-dsh-install --product/u);
  assert.throws(() => settings(new Context(), { product: "Bad_Product" }), /\^\[a-z0-9\]/u);
  const laneContext = new Context();
  laneContext.launchEnvironment = { get: (key) => new Map([
    ["SESSIONBUS_LAUNCH_TOKEN", { value: "token" }],
    ["SESSIONBUS_GROUPS", { value: "not-json" }],
  ]).get(key) };
  assert.deepEqual(settings(laneContext, { product: "sessionbus-dsh" }).groups, []);
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
  const activating = activate(ctx, { product: "sessionbus-dsh" }, deps);
  assert.equal(process.env.SESSIONBUS_LAUNCH_TOKEN, undefined);
  const runtime = await activating;
  assert.equal(Object.hasOwn(runtime.settings, "token"), false);
  ctx.ready();
  delete deps.workerEnvironment.SESSIONBUS_LAUNCH_TOKEN;
  deps.callbacks.hello();
  assert.equal(launch.get("SESSIONBUS_LAUNCH_TOKEN").value, "snapshot-secret");
  assert.equal(JSON.stringify(runtime).includes("snapshot-secret"), false);
});

test("lane hello omits groups and session.open carrying daemon groups succeeds", async () => {
  const ctx = new Context();
  const native = agent(ctx);
  const { deps } = lane(ctx);
  assert.deepEqual(deps.callbacks.hello(), {
    product: "sessionbus-dsh", version: packageVersion, supported_open_fields: ["cwd", "permission_mode", "model", "reasoning_effort"], extra_arguments: [],
  });
  const result = await deps.callbacks.open(null, {
    name: "parent/worker@host", groups: ["lane-primary", "lane-secondary"], open: { cwd: "/other", permission_mode: "never", model: "vendor/model/name", reasoning_effort: "high" },
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

test("peer SESSIONBUS_GROUPS is a configuration proof against a fake daemon", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-groups-"));
  const socket = path.join(directory, "bus.sock");
  let resolveHello, rejectHello;
  const hello = new Promise((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
  const hellos = [];
  const server = net.createServer((stream) => {
    let buffer = "";
    stream.on("error", () => {});
    stream.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        try {
          assert.equal(frame.method, "session.hello");
          assert.deepEqual(frame.params.groups, ["alpha", "beta"]);
          hellos.push(frame.params);
          stream.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })}\n`);
          if (hellos.length === 2) resolveHello();
        } catch (error) { rejectHello(error); }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  const ctx = new Context();
  const root = agent(ctx, "session-peer-groups");
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_SOCKET: socket, SESSIONBUS_GROUPS: '["alpha","beta"]' };
  deps.connectPeer = connectPeer;
  const runtime = createRuntime(ctx, { product: "dsh" }, deps);
  try {
    ctx.ready();
    const peer = runtime.peers.get(root).peer;
    await peer.ready;
    assert.deepEqual(peer.identity.groups, ["alpha", "beta"]);
    ctx.emit("session/event", root.session, { type: "session/title", data: { title: "Renamed" } });
    await runtime.peers.get(root).rehello;
    assert.deepEqual(deps.errors, []);
    await hello;
    assert.deepEqual(hellos, [
      { protocol: 1, product: "dsh", session_id: root.id, groups: ["alpha", "beta"], info: { cwd: "/workspace", model: "provider/default" } },
      { protocol: 1, product: "dsh", session_id: root.id, name: "Renamed", groups: ["alpha", "beta"], info: { cwd: "/workspace", model: "provider/default" } },
    ]);
  } finally {
    runtime.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a rejected peer hello is reported and a later title republishes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-rejected-"));
  const socket = path.join(directory, "bus.sock");
  let attempts = 0;
  const server = net.createServer((stream) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      attempts++;
      const response = attempts === 1
        ? { jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "invalid_hello" } }
        : { jsonrpc: "2.0", id: frame.id, result: {} };
      stream.write(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  const ctx = new Context();
  agent(ctx, "session-rejected");
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_SOCKET: socket };
  deps.connectPeer = connectPeer;
  const runtime = createRuntime(ctx, { product: "dsh" }, deps);
  try {
    ctx.ready();
    const rejected = runtime.peers.values().next().value.peer;
    await rejected.closed;
    await Promise.resolve();
    assert.deepEqual(deps.errors, ["sessionbus: invalid_hello\n"]);
    const root = ctx.roots[0];
    ctx.emitGlobal("session/event", root.session, { type: "session/title", data: { title: "Now publish" } });
    const admitted = runtime.peers.get(root).peer;
    assert.notEqual(admitted, rejected);
    await admitted.ready;
    assert.equal(attempts, 2);
    assert.deepEqual(deps.errors, ["sessionbus: invalid_hello\n"]);
  } finally {
    runtime.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("peer identity and socket connection failures are visible", async () => {
  const malformed = new Context();
  const badRoot = agent(malformed, "session-incomplete");
  badRoot.session.header.cwd = "";
  const badDeps = dependencies(malformed);
  badDeps.ambient = { SESSIONBUS_SOCKET: "/run/sessionbus.sock" };
  const malformedRuntime = createRuntime(malformed, { product: "dsh" }, badDeps);
  malformed.ready();
  assert.deepEqual(badDeps.errors, ["sessionbus: DSH root identity is incomplete\n"]);
  malformedRuntime.close();

  const ctx = new Context();
  agent(ctx, "session-connect");
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_SOCKET: path.join(os.tmpdir(), `missing-sessionbus-${process.pid}`, "presence.sock") };
  let failed, stream;
  deps.connectPeer = (_identity, _deliver, _environment, options) => {
    stream = options.connect(deps.ambient.SESSIONBUS_SOCKET);
    failed = new Promise((resolve) => stream.once("error", resolve));
    return { caller: deps.workerCaller, closed: new Promise(() => {}), error: null, shutdown: () => stream.destroy() };
  };
  const runtime = createRuntime(ctx, { product: "dsh" }, deps);
  ctx.ready();
  await failed;
  assert.equal(deps.errors.length, 1);
  assert.match(deps.errors[0], /^sessionbus: connect ENOENT /u);
  runtime.close();
});

test("kit preserves spawn policy.trace through peer and lane callers", { timeout: 10000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-trace-"));
  const socket = path.join(directory, "bus.sock");
  const result = {
    session_id: "spawned-session",
    policy: { persistent: false, auto_close_ms: 60000, idle_message: "stage", notify: false, trace: "content" },
  };
  const hellos = [], spawns = [], streams = new Set(), laneOpened = deferred();
  const server = net.createServer((stream) => {
    streams.add(stream);
    stream.on("close", () => streams.delete(stream));
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame.method === "session.hello") {
          hellos.push(frame.params);
          stream.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })}\n`);
          if (frame.params.launch_token) stream.write(`${JSON.stringify({ jsonrpc: "2.0", id: 100, method: "session.open", params: { name: "trace-worker@fake", groups: [], open: {} } })}\n`);
        } else if (frame.id === 100 && frame.result?.session_id) {
          laneOpened.resolve(frame.result);
        } else if (frame.method === "lane.spawn") {
          spawns.push(frame.params);
          stream.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  const runtimes = [];
  try {
    for (const mode of ["peer", "lane"]) {
      const ctx = new Context();
      const native = agent(ctx);
      const deps = dependencies(ctx);
      deps.ambient = { SESSIONBUS_SOCKET: socket, ...(mode === "lane" ? { SESSIONBUS_LAUNCH_TOKEN: "trace-token" } : {}) };
      if (mode === "peer") deps.connectPeer = connectPeer; else deps.serveWorker = serveWorker;
      const runtime = createRuntime(ctx, { product: mode === "peer" ? "dashi" : "sessionbus-dsh" }, deps);
      runtimes.push(runtime);
      ctx.ready();
      if (mode === "peer") await runtime.peers.get(native).peer.ready; else await laneOpened.promise;
      assert.deepEqual(await ctx.tool.execute({ action: "spawn", arguments: { product: "dashi", name: "trace-child", open: {} } }, { agent: native }), result);
      runtime.close();
      if (mode === "lane") await runtime.workerExit;
    }
    assert.deepEqual(hellos.map((hello) => Object.hasOwn(hello, "launch_token")), [false, true]);
    assert.deepEqual(spawns, Array(2).fill({ product: "dashi", name: "trace-child", open: {} }));
  } finally {
    for (const runtime of runtimes) runtime.close();
    for (const stream of streams) stream.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("resume keeps exact identity and uses the current model for effort", async () => {
  const ctx = new Context();
  const native = agent(ctx, "session-resume");
  const { deps } = lane(ctx);
  assert.deepEqual(await deps.callbacks.open(null, { name: "resumed@host", groups: [], resume_session_id: native.id, open: { reasoning_effort: "low" } }), { session_id: native.id });
  assert.equal(ctx.calls.some(([call]) => call === "create"), false);
  assert.deepEqual(ctx.calls.find(([call]) => call === "model")[1], { sessionId: native.id, provider: "provider", model: "default", reasoningEffort: "low" });
});

test("resume relays writer-held as a plain open failure", async () => {
  const ctx = new Context();
  const failure = Object.assign(new Error("session is held by another writer"), { code: "session/writer-held" });
  ctx.sessionController.resolveAgent = async () => ({ error: failure });
  const { deps } = lane(ctx);
  await assert.rejects(deps.callbacks.open(null, { name: "held@host", groups: [], resume_session_id: "held", open: {} }), (error) => error === failure);
});

test("run correlates receipt, turn, output, and terminal", async () => {
  const { ctx, native, deps } = await openedLane();
  let followed;
  native.followup = (message) => {
    followed = message;
    ctx.emit("session/event", native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } });
    ctx.emit("session/event", native.session, { type: "turn/start", data: { turn: 4 } });
    ctx.emit("session/event", native.session, { type: "user/message", data: message });
    ctx.emit("session/event", native.session, { type: "assistant/message", data: { turn: 4, message: { content: [{ type: "text", text: "one" }, { type: "text", text: " two" }] } } });
    ctx.emit("session/event", native.session, { type: "turn/end", data: { turn: 4, reason: { kind: "completed" } } });
  };
  const token = { Native: null, Interrupted: () => false };
  assert.deepEqual(await deps.callbacks.run(new AbortController().signal, token, { text: "hello" }), { outcome: "completed", native_stop_reason: "completed", result: "one two" });
  assert.deepEqual(followed.content, [{ type: "text", text: "hello" }]);
  assert.equal(token.Native, null);
  assert.deepEqual(ctx.calls.at(-1), ["idle", native.id]);
});

test("delivery-backed run seed emits its body as one plain text part", async () => {
  const { ctx, native, deps } = await openedLane();
  let followed, reported;
  native.followup = (message) => {
    followed = message;
    ctx.emit("session/event", native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } });
    ctx.emit("session/event", native.session, { type: "turn/start", data: { turn: 5 } });
    ctx.emit("session/event", native.session, { type: "user/message", data: message });
    ctx.emit("session/event", native.session, { type: "turn/end", data: { turn: 5, reason: { kind: "completed" } } });
  };
  const token = { Native: null, Interrupted: () => false, ReportDelivery: async (value) => { reported = value; } };
  await deps.callbacks.run(new AbortController().signal, token, { delivery: { message_id: "message-1", from: { session_id: "source", product: "dsh", groups: [] }, body: "delivered" } });
  assert.deepEqual(followed.content, [{ type: "text", text: "delivered" }]);
  assert.deepEqual(reported, { disposition: "injected" });
});

test("unexpected run seed fails before creating native work", async () => {
  const { native, deps } = await openedLane();
  let followed = false;
  native.followup = () => { followed = true; };
  await assert.rejects(deps.callbacks.run(new AbortController().signal, { Native: null, Interrupted: () => false }, {}), /unexpected run input seed shape/u);
  assert.equal(followed, false);
});

test("pre-commit turn error returns the durable DSH failure", async () => {
  const { ctx, native, deps } = await openedLane();
  native.followup = (message) => {
    ctx.emit("session/event", native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } });
    ctx.emit("session/event", native.session, { type: "turn/start", data: { turn: 5 } });
    ctx.emit("session/event", native.session, { type: "turn/end", data: { turn: 5, reason: { kind: "error", error: { code: "UNKNOWN", message: "turn-start fixture failed" } } } });
  };
  assert.deepEqual(await deps.callbacks.run(new AbortController().signal, { Native: null, Interrupted: () => false }, { text: "never committed" }), {
    outcome: "failed", native_stop_reason: "error", result: "UNKNOWN: turn-start fixture failed",
  });
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
  const running = deps.callbacks.run(new AbortController().signal, { Native: null, Interrupted: () => false }, { text: "misordered" });
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
  const first = deps.callbacks.run(new AbortController().signal, firstToken, { text: "first" });
  deps.callbacks.interrupt(null, firstToken);
  idles[0].resolve();
  assert.deepEqual(await first, { outcome: "interrupted", native_stop_reason: "aborted:user", result: "" });

  const second = deps.callbacks.run(new AbortController().signal, { Native: null, Interrupted: () => false }, { text: "second" });
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
  await assert.rejects(deps.callbacks.run(cancel.signal, { Native: null, Interrupted: () => false }, { text: "run" }), /already cancelled/);
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
  await assert.rejects(deps.callbacks.run(runCancel, { Native: null, Interrupted: () => false }, { text: "run" }), /followup failed/);
  native.status = "running";
  const deliverCancel = tracked();
  native.steer = () => { throw new Error("steer failed"); };
  await assert.rejects(deps.callbacks.deliver(deliverCancel, { body: "deliver" }), /steer failed/);
  native.followup = () => {};
  const cancelled = new AbortController();
  const running = deps.callbacks.run(cancelled.signal, { Native: null, Interrupted: () => false }, { text: "cancelled" });
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
  assert.deepEqual(await deps.callbacks.run(new AbortController().signal, { Interrupted: () => true }, { text: "stop" }), { outcome: "interrupted", result: "" });
  assert.equal(followed, false);
  deps.callbacks.interrupt(null, { Native: {} });
  assert.deepEqual(ctx.calls.at(-1), ["cancel", { kind: "user" }, { keepInbox: true }]);
});

test("delivery appends while idle and waits for steer receipt while running", async () => {
  const { ctx, native, deps } = await openedLane();
  assert.deepEqual(await deps.callbacks.deliver(null, { body: "idle" }), { disposition: "injected" });
  const appended = ctx.calls.find(([call]) => call === "append");
  assert.deepEqual(appended.slice(0, 2), ["append", "user/message"]);
  assert.deepEqual(appended[2].content, [{ type: "text", text: "idle" }]);
  native.status = "running";
  let steered;
  native.steer = (message) => { steered = message; ctx.emit("session/event", native.session, { type: "agent/inbox/spliced", data: { inserted: [message] } }); };
  assert.deepEqual(await deps.callbacks.deliver(null, { body: "active" }), { disposition: "injected" });
  assert.deepEqual(steered.content, [{ type: "text", text: "active" }]);
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
  const runtime = createRuntime(ctx, { product: "dashi" }, deps);
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
  ctx.emit("session/event", one.session, { type: "session/title", data: { title: "" } });
  await runtime.peers.get(one).rehello;
  assert.deepEqual(deps.peers[0].rehelloed, { name: undefined, info: { cwd: "/workspace", model: "provider/default" } });
  assert.equal(Object.hasOwn(deps.peers[0].identity, "name"), false);
  ctx.emit("agent/disposed", { agent: one });
  assert.equal(deps.peers[0].stopped, true);
  const created = agent(ctx, "session-two");
  ctx.emit("agent/created", { agent: created });
  assert.equal(deps.peers.at(-1).identity.session_id, created.id);
  runtime.close();
});

test("web session creation publishes its root through the global lifecycle", async () => {
  const ctx = new Context();
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_SOCKET: "/run/sessionbus.sock", SESSIONBUS_GROUPS: '["web-proof"]' };
  const runtime = createRuntime(ctx, { product: "dsh" }, deps);
  ctx.ready();
  const created = agent(ctx, "session-web");
  ctx.emitGlobal("agent/created", { agent: created });
  assert.deepEqual(deps.peers.map(({ identity }) => identity), [{
    product: "dsh", session_id: "session-web", groups: ["web-proof"],
    info: { cwd: "/workspace", model: "provider/default" },
  }]);
  ctx.emitGlobal("session/event", created.session, { type: "session/title", data: { title: "Web title" } });
  await runtime.peers.get(created).rehello;
  assert.equal(deps.peers[0].identity.name, "Web title");
  ctx.emitGlobal("agent/disposed", { agent: created });
  assert.equal(deps.peers[0].stopped, true);
  runtime.close();
});

test("opt-in trace reports readiness, global lifecycle, and present gates", () => {
  const ctx = new Context();
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_DSH_TRACE: "1", SESSIONBUS_SOCKET: "/run/sessionbus.sock" };
  const runtime = createRuntime(ctx, { product: "dsh" }, deps);
  ctx.ready();
  const child = agent(ctx, "session-child");
  ctx.roots.pop();
  ctx.emitGlobal("agent/created", { agent: child });
  const root = agent(ctx, "session-root");
  ctx.emitGlobal("agent/created", { agent: root });
  ctx.emitGlobal("agent/created", { agent: root });
  ctx.emitGlobal("agent/disposed", { agent: root });
  runtime.close();
  assert.deepEqual(deps.errors, [
    "sessionbus trace: mode=peer ready=false socket=/run/sessionbus.sock\n",
    "sessionbus trace: mode=peer ready=true\n",
    "sessionbus trace: agent/created id=session-child scope=global\n",
    "sessionbus trace: present id=session-child root=false reason=not-root\n",
    "sessionbus trace: agent/created id=session-root scope=global\n",
    "sessionbus trace: present id=session-root root=true reason=publish\n",
    "sessionbus trace: agent/created id=session-root scope=global\n",
    "sessionbus trace: present id=session-root root=true reason=published\n",
    "sessionbus trace: agent/disposed id=session-root scope=global\n",
    "sessionbus trace: mode=peer ready=false reason=close\n",
  ]);
});

test("peer waits for a native session id and replaces it atomically when it changes", async () => {
  const ctx = new Context();
  const one = agent(ctx, "session-one");
  const session = one.session;
  one.session = undefined;
  const deps = dependencies(ctx);
  deps.ambient = { SESSIONBUS_SOCKET: "/run/sessionbus.sock", SESSIONBUS_GROUPS: '["team"]' };
  const runtime = createRuntime(ctx, { product: "dashi" }, deps);
  ctx.ready();
  assert.equal(deps.peers.length, 0);
  assert.deepEqual(deps.errors, []);
  one.session = session;
  ctx.emit("agent/created", { agent: one });
  assert.equal(deps.peers.length, 1);
  one.session.id = "session-authoritative";
  ctx.emit("session/event", one.session, { type: "session/title", data: { title: "Bound" } });
  await runtime.peers.get(one).rehello;
  assert.deepEqual(deps.peers[0].replaced, {
    product: "dashi", session_id: "session-authoritative", name: "Bound", groups: ["team"], info: { cwd: "/workspace", model: "provider/default" },
  });
  runtime.close();
});

test("disable then enable leaves one connection and one registration", () => {
  const ctx = new Context();
  agent(ctx, "session-one");
  const first = dependencies(ctx);
  createRuntime(ctx, { product: "dashi" }, first);
  ctx.ready();
  assert.equal(first.peers.length, 1);
  ctx.dispose();
  assert.equal(first.peers[0].stopped, true);
  assert.equal(ctx.tool, undefined);
  assert.equal(ctx.command, undefined);

  const second = dependencies(ctx);
  const runtime = createRuntime(ctx, { product: "dashi" }, second);
  ctx.ready();
  ctx.emit("agent/created", { agent: ctx.roots[0] });
  assert.equal(second.peers.length, 1);
  assert.notEqual(second.peers[0], first.peers[0]);
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
    async rehello(signal, name, info) {
      assert.equal(signal, undefined);
      const position = titles.push(name) - 1;
      await acknowledgements[position].promise;
      this.identity = { ...this.identity, name, info };
    },
  });
  const runtime = createRuntime(ctx, { product: "dashi" }, deps);
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

test("native tool arguments expose the exact closed MCP union", () => {
  const ctx = new Context();
  createRuntime(ctx, { product: "dashi" }, dependencies(ctx));
  assert.deepEqual(ACTIONS, ["list", "send", "spawn", "describe", "trace", "run", "start", "wait", "status", "interrupt", "close", "forget", "ack"]);
  assert.match(ctx.tool.description, /trace mode off, events or content/u);
  assert.deepEqual(ctx.tool.parameters, {
    action: { type: "string", enum: ACTIONS, required: true },
    arguments: {
      type: "object", additionalProperties: false,
      description: "Use only the fields listed for the selected action in the tool description. send has no summary field; put the complete content in message.",
      properties: {
        session_id: { type: "string" }, host: { type: "string" }, message: { type: "string" },
        target: { type: "string" }, group: { type: "string" }, product: { type: "string" },
        name: { type: "string" }, resume_session_id: { type: "string" }, notify_target: { type: "string" },
        input: { type: "string" }, run_id: { type: "string" },
        targets: { type: "array", items: { type: "string" } },
        extra_groups: { type: "array", items: { type: "string" } },
        persistent: { type: "boolean" }, notify: { type: "boolean" }, forget: { type: "boolean" },
        auto_close_ms: { type: "integer" }, timeout_ms: { type: "integer" },
        idle_message: { type: "string", enum: ["stage", "run"] },
        trace: { type: "string", enum: ["off", "events", "content"] },
        mode: { type: "string", enum: ["off", "events", "content"] },
        open: {
          type: "object", additionalProperties: false,
          properties: {
            cwd: { type: "string" }, permission_mode: { type: "string" }, model: { type: "string" },
            reasoning_effort: { type: "string" }, arguments: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  });
  ctx.dispose();
});

test("native permission hook overrides a later ask-all policy only for sessionbus", async () => {
  const ctx = new Context();
  createRuntime(ctx, { product: "dashi" }, dependencies(ctx));
  const removeDummy = ctx.tools.register({ name: "w081_dummy" });
  const removeAsk = ctx.on("tools/pre-execute", async () => ({ kind: "ask", reason: "test ask-all" }));
  const handlers = ctx.listeners.get("tools/pre-execute");
  const decide = (execution, index = 0) => handlers[index](execution,
    () => index + 1 < handlers.length ? decide(execution, index + 1) : Promise.resolve({ kind: "allow" }));
  assert.deepEqual(await decide({ name: "sessionbus" }), { kind: "allow" });
  assert.deepEqual(await decide({ name: "w081_dummy" }), { kind: "ask", reason: "test ask-all" });
  assert.equal(ctx.registeredTools.get("w081_dummy").name, "w081_dummy");
  removeAsk();
  removeDummy();
  ctx.dispose();
  assert.deepEqual(ctx.listeners.get("tools/pre-execute"), []);
});

test("an unavailable native permission hook fails before tool registration", () => {
  const ctx = new Context();
  const on = ctx.on.bind(ctx);
  ctx.on = (event, ...args) => {
    if (event === "tools/pre-execute") throw new Error("hook unavailable");
    return on(event, ...args);
  };
  assert.throws(() => createRuntime(ctx, { product: "dashi" }, dependencies(ctx)),
    /cannot grant sessionbus tool permission: hook unavailable/u);
  assert.equal(ctx.tool, undefined);
});

for (const mode of ["peer", "lane"]) {
  test(`native tool accepts known arguments and rejects unknown keys before ${mode} action`, async () => {
    const { ctx, native, deps, runtime } = mode === "lane" ? await openedLane() : (() => {
      const ctx = new Context();
      const native = agent(ctx);
      const deps = dependencies(ctx);
      const runtime = createRuntime(ctx, { product: "dashi" }, deps);
      ctx.ready();
      return { ctx, native, deps, runtime };
    })();
    const forwarded = [];
    const client = mode === "lane" ? deps.workerCaller : deps.peers[0].caller;
    client.action = (action, args) => { forwarded.push({ action, args }); return "accepted"; };
    const requests = [
      ["list", {}], ["list", { session_id: "self" }], ["list", { host: "host" }],
      ["send", { target: "recipient", message: "Complete message" }],
      ["send", { targets: ["one", "two"], message: "Complete message" }],
      ["send", { group: "team", host: "host", message: "Complete message" }],
      ["spawn", { product: "dashi", name: "worker", extra_groups: ["team"], persistent: true, notify: false, notify_target: "owner", auto_close_ms: 0, idle_message: "stage", trace: "events", open: { cwd: "/workspace", permission_mode: "ask", model: "model", reasoning_effort: "high", arguments: ["--flag"] } }],
      ["spawn", { resume_session_id: "previous", idle_message: "run", trace: "off" }],
      ["trace", { session_id: "worker", mode: "content" }],
      ["run", { session_id: "worker", input: "go" }],
      ["wait", { session_id: "worker", run_id: "run", timeout_ms: 0 }],
      ["close", { session_id: "worker", forget: true }],
    ];
    for (const [action, args] of requests) {
      assert.equal(await ctx.tool.execute({ action, arguments: args }, { agent: native }), "accepted");
      assert.deepEqual(forwarded.at(-1), { action, args });
      assert.equal(forwarded.at(-1).args, args);
    }
    assert.equal(new Set(requests.flatMap(([, args]) => Object.keys(args))).size, 22);
    for (const [args, message] of [
      [{ target: "recipient", message: "Complete message", summary: "extra" }, /arguments\.summary is not supported/],
      [{ unexpected: true }, /arguments\.unexpected is not supported/],
      [{ open: { cwd: "/workspace", summary: "extra" } }, /arguments\.open\.summary is not supported/],
      [{ open: [] }, /arguments\.open must be an object/],
      [[], /arguments must be an object/],
    ]) {
      assert.throws(() => ctx.tool.execute({ action: "send", arguments: args }, { agent: native }), message);
      assert.equal(forwarded.length, requests.length);
    }
    runtime.close();
  });
}

test("worker boot failure reports once and exits one before admission", async () => {
  const ctx = new Context();
  const { deps, runtime } = lane(ctx);
  deps.failWorker(new Error("bad\0boot\nline"));
  await runtime.workerExit;
  assert.deepEqual(deps.errors, ["sessionbus: bad boot line\n"]);
  assert.deepEqual(ctx.exits, [1]);
});
