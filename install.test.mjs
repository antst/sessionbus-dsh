import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { install, remove } from "./install.mjs";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

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
  install(["sessionbus"], { home, root, run, product: "sessionbus-dsh" });
  const first = {
    manifest: readFileSync(path.join(home, "profiles", "sessionbus", "package.json"), "utf8"),
    profile: readFileSync(path.join(home, "profiles", "sessionbus", "cordis.patch.yml"), "utf8"),
    peer: readFileSync(path.join(home, "cordis.patch.yml"), "utf8"),
  };
  install([], { home, root, run });
  assert.equal(runs, 1);
  assert.deepEqual({
    manifest: readFileSync(path.join(home, "profiles", "sessionbus", "package.json"), "utf8"),
    profile: readFileSync(path.join(home, "profiles", "sessionbus", "cordis.patch.yml"), "utf8"),
    peer: readFileSync(path.join(home, "cordis.patch.yml"), "utf8"),
  }, first);
  install(["sessionbus"], { home, root, run, product: "dashi" });
  const repaired = readFileSync(path.join(home, "profiles", "sessionbus", "cordis.patch.yml"), "utf8");
  assert.equal(repaired, first.profile.replace("product: sessionbus-dsh", "product: dashi"));
  install(["sessionbus"], { home, root, run, product: "dashi" });
  assert.equal(readFileSync(path.join(home, "profiles", "sessionbus", "cordis.patch.yml"), "utf8"), repaired);
  assert.equal(runs, 1);
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
    - { id: file-uploads-none, name: '@antst/dsh-file-uploads-none' }
    - { id: session-controller, name: '@deepseek-ai/dsh-api-session-controller' }
    - id: sessionbus
      name: '@sessionbus/dsh'
      config: { mode: lane, product: sessionbus-dsh }
`);
  assert.deepEqual(JSON.parse(first.manifest), {
    name: "dsh-profile-sessionbus",
    private: true,
    dependencies: { "@sessionbus/dsh": "0.0.0" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "startup" } },
  });
});

test("installer adds one profile-local peer row to each named profile", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-peer-home-"));
  for (const name of ["web", "custom"]) {
    const profile = path.join(home, "profiles", name);
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, "package.json"), JSON.stringify({ dependencies: { "@sessionbus/dsh": packageVersion } }));
    writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");
  }
  install(["web", "custom"], { home, root: path.resolve("."), product: "dsh", run: () => assert.fail("dependency already installed") });
  for (const name of ["web", "custom"]) assert.match(readFileSync(path.join(home, "profiles", name, "cordis.patch.yml"), "utf8"), /id: sessionbus/u);
  for (const name of ["web", "custom"]) assert.match(readFileSync(path.join(home, "profiles", name, "cordis.patch.yml"), "utf8"), /product: dsh/u);
  assert.doesNotMatch(readFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "utf8"), /file-uploads-none/u);
  assert.match(readFileSync(path.join(home, "profiles", "custom", "cordis.patch.yml"), "utf8"), /file-uploads-none/u);
  assert.equal(existsSync(path.join(home, "cordis.patch.yml")), false);
});

test("installer preserves existing rows with quoted keys", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-native-home-"));
  const dashi = path.join(home, "profiles", "dashi");
  mkdirSync(dashi, { recursive: true });
  writeFileSync(path.join(dashi, "package.json"), JSON.stringify({ dependencies: { "@sessionbus/dsh": packageVersion } }));
  const patch = "- insert:\n    - { \"id\": \"sessionbus\", name: '@sessionbus/dsh', config: { groups: [native] } }\n    - { \"id\": \"file-uploads-none\", name: '@antst/dsh-file-uploads-none' }\n";
  writeFileSync(path.join(dashi, "cordis.patch.yml"), patch);
  install(["dashi"], { home, root: path.resolve("."), product: "dashi", run: () => assert.fail("dependency already installed") });
  const installed = readFileSync(path.join(dashi, "cordis.patch.yml"), "utf8");
  assert.equal((installed.match(/"id": "sessionbus"/gu) || []).length, 1);
  assert.match(installed, /groups: \[native\]/u);
  assert.match(installed, /product: dashi/u);
  assert.equal((installed.match(/file-uploads-none/gu) || []).length, 2);
  install(["dashi"], { home, root: path.resolve("."), product: "dashi", run: () => assert.fail("dependency already installed") });
  assert.equal(readFileSync(path.join(dashi, "cordis.patch.yml"), "utf8"), installed);
});

test("installer repairs a block row without changing neighboring text", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-repair-home-"));
  const web = path.join(home, "profiles", "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "package.json"), JSON.stringify({ dependencies: { "@sessionbus/dsh": packageVersion } }));
  writeFileSync(path.join(web, "cordis.patch.yml"), "# keep\n- insert:\n    - id: sessionbus\n      name: '@sessionbus/dsh'\n- id: neighboring-row\n  disabled: true\n");
  install(["web"], { home, product: "dsh", run: () => assert.fail("dependency already installed") });
  assert.equal(readFileSync(path.join(web, "cordis.patch.yml"), "utf8"), "# keep\n- insert:\n    - id: sessionbus\n      name: '@sessionbus/dsh'\n      config: { product: dsh }\n- id: neighboring-row\n  disabled: true\n");
});

test("installer requires and validates a stable peer product", () => {
  assert.throws(() => install(["web"], { home: "/unused" }), /--product is required/u);
  assert.throws(() => install(["sessionbus"], { home: "/unused", product: "dsh" }), /must be sessionbus-dsh or dashi/u);
  for (const product of ["Dashi", "bad_name", "x".repeat(33)]) {
    assert.throws(() => install(["web"], { home: "/unused", product }), /\^\[a-z0-9\]/u);
  }
});

test("removal never loads the plugin and preserves every other row", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-remove-home-"));
  const profile = path.join(home, "profiles", "broken");
  const original = "# keep\n- insert:\n    - { id: keeper, name: keeper }\n";
  install(["broken"], { home, product: "dsh", run: () => {
    mkdirSync(path.join(profile, "node_modules", "@sessionbus", "dsh"), { recursive: true });
    writeFileSync(path.join(profile, "package.json"), JSON.stringify({ private: true, dependencies: { "@sessionbus/dsh": packageVersion } }));
    writeFileSync(path.join(profile, "cordis.patch.yml"), original);
    writeFileSync(path.join(profile, "node_modules", "@sessionbus", "dsh", "package.json"), JSON.stringify({ name: "@sessionbus/dsh", version: packageVersion }));
    writeFileSync(path.join(profile, "node_modules", "@sessionbus", "dsh", "plugin.cjs"), "throw new Error('unloadable')\n");
    return { status: 0 };
  } });
  const broken = spawnSync(process.execPath, [path.join(profile, "node_modules", "@sessionbus", "dsh", "plugin.cjs")], { encoding: "utf8" });
  assert.notEqual(broken.status, 0);
  remove(["broken"], { home });
  assert.equal(readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), original);
  assert.equal(JSON.parse(readFileSync(path.join(profile, "package.json"), "utf8")).dependencies?.["@sessionbus/dsh"], undefined);
  assert.equal(existsSync(path.join(profile, "node_modules", "@sessionbus", "dsh")), false);
});

test("removal ignores product and deletes owned block and flow rows", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-remove-rows-"));
  const calls = [];
  for (const [name, sessionbus] of [["old", "    - { id: sessionbus, name: '@sessionbus/dsh' }\n"], ["new", "    - id: sessionbus\n      name: '@sessionbus/dsh'\n      config: { product: dsh }\n"]]) {
    const profile = path.join(home, "profiles", name);
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, "cordis.patch.yml"), `- insert:\n    - { id: keeper, name: keeper }\n${sessionbus}    - { id: file-uploads-none, name: '@antst/dsh-file-uploads-none' }\n`);
  }
  remove(["old", "new"], { home, run: (args, cwd) => { calls.push([args, cwd]); return { status: 0 }; } });
  for (const name of ["old", "new"]) assert.equal(readFileSync(path.join(home, "profiles", name, "cordis.patch.yml"), "utf8"), "- insert:\n    - { id: keeper, name: keeper }\n");
  assert.deepEqual(calls, ["old", "new"].map(name => [["remove", "@sessionbus/dsh"], path.join(home, "profiles", name)]));
  assert.throws(() => remove([], { home }), /requires at least one profile/u);
});

test("installed bin symlink runs the installer", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-bin-home-"));
  const bin = mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-bin-"));
  const profile = path.join(home, "profiles", "sessionbus");
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, "package.json"), JSON.stringify({ dependencies: { "@sessionbus/dsh": packageVersion } }));
  writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");
  writeFileSync(path.join(home, "cordis.patch.yml"), "[]\n");
  const command = path.join(bin, "sessionbus-dsh-install");
  symlinkSync(path.resolve("bin.mjs"), command);
  const result = spawnSync(command, [], { encoding: "utf8", env: { ...process.env, DSH_HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), /mode: lane/u);
  assert.match(readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), /file-uploads-none/u);
  assert.equal(readFileSync(path.join(home, "cordis.patch.yml"), "utf8"), "[]\n");
  for (const [args, message] of [
    [["web"], /required for peer profiles/u],
    [["--product"], /requires a value/u],
    [["--remove"], /requires at least one profile/u],
  ]) {
    const failed = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, DSH_HOME: home } });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, message);
  }
  const removed = spawnSync(command, ["--remove", "sessionbus"], { encoding: "utf8", env: { ...process.env, DSH_HOME: home } });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(profile, "package.json"), "utf8")).dependencies?.["@sessionbus/dsh"], undefined);
  assert.doesNotMatch(readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), /sessionbus|file-uploads-none/u);
});
