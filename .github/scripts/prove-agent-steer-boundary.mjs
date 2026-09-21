import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

const chunks = (text) => [
  { type: "block-start", index: 0, blockType: "text" },
  { type: "text-delta", index: 0, text },
  { type: "block-end", index: 0, block: { type: "text", text } },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
  { type: "finish", reason: { kind: "stop" } },
];
class FakeAdapter extends LlmAdapter {
  count = 0;
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  async * stream() { yield* chunks(`answer-${++this.count}`); }
}
const message = (text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });

async function run(hop) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(["w100"], new FakeAdapter());
  const agent = await ctx.agentLoop.create(SessionId(`w100-${hop ? "hop" : "strand"}`), { provider: "w100", model: "fake" });
  let queued = false;
  ctx.on("session/event", (session, event) => {
    if (session !== agent.session || event.type !== "turn/end" || queued) return;
    queued = true;
    const steer = () => agent.steer(message("boundary delivery"));
    if (hop) setImmediate(steer); else queueMicrotask(steer);
  });
  agent.followup(message("first turn"));
  await agent.whenIdle();
  if (hop) {
    await new Promise(setImmediate);
    await agent.whenIdle();
  }
  const events = agent.session.snapshotEvents();
  const result = {
    status: agent.status,
    pending: agent.inbox.nextStep.map((entry) => entry.content[0]?.text),
    turns: events.filter((event) => event.type === "turn/start").length,
    answers: events.filter((event) => event.type === "assistant/message").length,
  };
  await ctx.fiber.dispose();
  return result;
}

assert.deepEqual(await run(false), { status: "idle", pending: ["boundary delivery"], turns: 1, answers: 1 });
assert.deepEqual(await run(true), { status: "idle", pending: [], turns: 2, answers: 2 });
console.log("real Agent steer boundary without hop: stranded; with one hop: consumed: PASS");
