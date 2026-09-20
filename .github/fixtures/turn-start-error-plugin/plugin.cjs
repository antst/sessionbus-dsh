"use strict";

module.exports = {
  name: "w086-turn-start-error",
  apply(ctx) {
    ctx.on("agent/pre-step", () => { throw new Error("W-086 turn-start fixture failure"); });
  },
};
