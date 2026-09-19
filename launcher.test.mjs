import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-launcher-"));
  const dsh = path.join(root, "dsh");
  writeFileSync(dsh, `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));\nif (process.env.HOLD) setInterval(() => {}, 1000); else process.exit(Number(process.env.EXIT_CODE));\n`);
  chmodSync(dsh, 0o755);
  return { root, dsh, capture: path.join(root, "capture.json"), launcher: path.resolve("launcher.mjs") };
}

test("launcher selects only the lane profile and forwards argv and exit code", () => {
  for (const token of [undefined, "launch-token"]) {
    const { root, capture, launcher } = fixture();
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, CAPTURE: capture, EXIT_CODE: "23" };
    if (token === undefined) delete env.SESSIONBUS_LAUNCH_TOKEN; else env.SESSIONBUS_LAUNCH_TOKEN = token;
    const result = spawnSync(process.execPath, [launcher, "--flag", "value"], { env, encoding: "utf8" });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capture)), token === undefined ? ["--flag", "value"] : ["--profile", "sessionbus", "--flag", "value"]);
  }
});

test("launcher forwards termination and mirrors the child signal", async () => {
  const { root, capture, launcher } = fixture();
  const child = spawn(process.execPath, [launcher], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CAPTURE: capture, HOLD: "1" } });
  for (let attempts = 0; attempts < 100 && !existsSync(capture); attempts++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(capture), true);
  child.kill("SIGTERM");
  const result = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(result, { code: null, signal: "SIGTERM" });
});
