import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { install } from "./install.mjs";

test("installer creates only the lane profile and leaves the root patch untouched", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-package-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-home-"));
  let runs = 0;
  const run = (argumentsValue) => {
    runs++;
    assert.deepEqual(argumentsValue, ["plugin", "--profile", "sessionbus", "add", "@sessionbus/dsh"]);
    const profile = path.join(home, "profiles", "sessionbus");
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, "package.json"), JSON.stringify({ dependencies: { "@sessionbus/dsh": "0.0.0" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }));
    writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");
    return { status: 0 };
  };
  const rootPatch = "# product-owned peer configuration\n- insert:\n    - { id: product-peer, name: product-peer }\n";
  writeFileSync(path.join(home, "cordis.patch.yml"), rootPatch);
  const bundle = path.join(home, "profiles", "native-app", "node_modules", "native-bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(home, "profiles", "native-app", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["native-bundle"] } } }));
  writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
  writeFileSync(path.join(bundle, "cordis.patch.yml"), "- id: sessionbus\n  name: '@sessionbus/dsh'\n");
  install({ home, root, run });
  const first = {
    manifest: readFileSync(path.join(home, "profiles", "sessionbus", "package.json"), "utf8"),
    profile: readFileSync(path.join(home, "profiles", "sessionbus", "cordis.patch.yml"), "utf8"),
    peer: readFileSync(path.join(home, "cordis.patch.yml"), "utf8"),
  };
  install({ home, root, run });
  assert.equal(runs, 1);
  assert.deepEqual({
    manifest: readFileSync(path.join(home, "profiles", "sessionbus", "package.json"), "utf8"),
    profile: readFileSync(path.join(home, "profiles", "sessionbus", "cordis.patch.yml"), "utf8"),
    peer: readFileSync(path.join(home, "cordis.patch.yml"), "utf8"),
  }, first);
  assert.equal(first.peer, rootPatch);
  assert.equal(first.profile, `- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
- id: session-title-llm
  disabled: true
- id: permission
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      workspace-write-noninteractive: { sandbox: workspace-write, approval: never }
      danger-full-access: { sandbox: danger-full-access, approval: never }

- insert:
    - { id: workspace, name: '@deepseek-ai/dsh-workspace' }
    - { id: session-controller, name: '@deepseek-ai/dsh-api-session-controller' }
    - id: sessionbus
      name: '@sessionbus/dsh'
      config: { mode: lane }
`);
  assert.deepEqual(JSON.parse(first.manifest), {
    name: "dsh-profile-sessionbus",
    private: true,
    dependencies: { "@sessionbus/dsh": "0.0.0" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "startup" } },
  });
});

test("installer adds one root peer row for a plain DSH host", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-plain-home-"));
  const profile = path.join(home, "profiles", "sessionbus");
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, "package.json"), JSON.stringify({ dependencies: { "@sessionbus/dsh": "0.1.0-pre.1" } }));
  writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");
  install({ home, root: path.resolve("."), run: () => assert.fail("dependency already installed") });
  const first = readFileSync(path.join(home, "cordis.patch.yml"), "utf8");
  assert.equal((first.match(/id: sessionbus/gu) || []).length, 1);
  install({ home, root: path.resolve("."), run: () => assert.fail("dependency already installed") });
  assert.equal(readFileSync(path.join(home, "cordis.patch.yml"), "utf8"), first);
});

test("installer removes its obsolete root row when a product bundle provides the peer", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-converge-home-"));
  const lane = path.join(home, "profiles", "sessionbus");
  mkdirSync(lane, { recursive: true });
  writeFileSync(path.join(lane, "package.json"), JSON.stringify({ dependencies: { "@sessionbus/dsh": "0.1.0-pre.1" } }));
  writeFileSync(path.join(lane, "cordis.patch.yml"), "[]\n");
  const bundle = path.join(home, "profiles", "product", "node_modules", "product-bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(home, "profiles", "product", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["product-bundle"] } } }));
  writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
  writeFileSync(path.join(bundle, "cordis.patch.yml"), "- insert:\n    - { id: sessionbus, name: '@sessionbus/dsh' }\n");
  const rootPatch = path.join(home, "cordis.patch.yml");
  writeFileSync(rootPatch, "- insert:\n    - { id: sessionbus, name: '@sessionbus/dsh' }\n");
  install({ home, root: path.resolve("."), run: () => assert.fail("dependency already installed") });
  assert.equal(existsSync(rootPatch), false);
});

test("installed bin symlink runs the installer", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-bin-home-"));
  const bin = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-bin-"));
  const profile = path.join(home, "profiles", "sessionbus");
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, "package.json"), JSON.stringify({ dependencies: { "@sessionbus/dsh": "0.1.0-pre.1" } }));
  writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");
  writeFileSync(path.join(home, "cordis.patch.yml"), "[]\n");
  const command = path.join(bin, "sessionbus-dsh-install");
  symlinkSync(path.resolve("bin.mjs"), command);
  const result = spawnSync(command, [], { encoding: "utf8", env: { ...process.env, DSH_HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), /mode: lane/u);
  assert.match(readFileSync(path.join(home, "cordis.patch.yml"), "utf8"), /id: sessionbus/u);
});
