"use strict";

module.exports = {
  name: "w081-ask-all",
  inject: ["tools"],
  apply(ctx) {
    ctx.tools.register({
      name: "w081_dummy",
      description: "W-081 approval negative control.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: async () => ({ ok: true }),
    });
    ctx.on("tools/pre-execute", async () => ({ kind: "ask", reason: "W-081 ask-all negative control" }), { global: true });
    ctx.on("approval/request", async () => "allowed-once", { global: true, prepend: true });
  },
};
