"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("package metadata stays rooted in the standalone repository", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/antst/sessionbus-dsh.git",
  });
  assert.deepEqual(manifest.files, ["README.md", "plugin.cjs", "bin.mjs", "install.mjs"]);
  assert.equal(manifest.dependencies["@sessionbus/kit"], "0.1.0-pre.2");
});

test("the extracted package imports and its real bin performs installation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sessionbus-dsh-pack-"));
  const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: __dirname, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const filename = JSON.parse(packed.stdout)[0].filename;
  const extracted = spawnSync("tar", ["-xzf", path.join(directory, filename), "-C", directory], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  const consumer = path.join(directory, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true}\n');
  const installed = spawnSync("npm", ["install", "--omit=peer", "--ignore-scripts", path.join(directory, filename)], { cwd: consumer, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  const packageRoot = path.join(consumer, "node_modules", "@sessionbus", "dsh");
  const imported = spawnSync(process.execPath, ["-e", "require('./plugin.cjs')"], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  const sideEffectHome = path.join(directory, "import-home");
  const importedInstaller = spawnSync(process.execPath, ["-e", "import('./install.mjs')"], { cwd: packageRoot, encoding: "utf8", env: { ...process.env, DSH_HOME: sideEffectHome } });
  assert.equal(importedInstaller.status, 0, importedInstaller.stderr);
  assert.equal(fs.existsSync(sideEffectHome), false);

  const home = path.join(directory, "dsh-home");
  const profile = path.join(home, "profiles", "sessionbus");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "package.json"), '{"dependencies":{"@sessionbus/dsh":"0.1.0-pre.1"}}\n');
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");
  const rootPatch = "# product-owned peer configuration\n[]\n";
  fs.writeFileSync(path.join(home, "cordis.patch.yml"), rootPatch);
  const bundle = path.join(home, "profiles", "native-app", "node_modules", "native-bundle");
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "native-app", "package.json"), '{"dsh":{"profile":{"bundles":["native-bundle"]}}}\n');
  fs.writeFileSync(path.join(bundle, "package.json"), '{"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}\n');
  fs.writeFileSync(path.join(bundle, "cordis.patch.yml"), "- id: sessionbus\n  name: '@sessionbus/dsh'\n");
  const command = path.join(consumer, "node_modules", ".bin", "sessionbus-dsh-install");
  const invoked = spawnSync(command, [], { encoding: "utf8", env: { ...process.env, DSH_HOME: home } });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.match(fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), /mode: lane/u);
  assert.equal(fs.readFileSync(path.join(home, "cordis.patch.yml"), "utf8"), rootPatch);

  const directHome = path.join(directory, "direct-home");
  const directProfile = path.join(directHome, "profiles", "sessionbus");
  fs.mkdirSync(directProfile, { recursive: true });
  fs.writeFileSync(path.join(directProfile, "package.json"), '{"dependencies":{"@sessionbus/dsh":"0.1.0-pre.1"}}\n');
  fs.writeFileSync(path.join(directProfile, "cordis.patch.yml"), "[]\n");
  const direct = spawnSync(process.execPath, [path.join(packageRoot, "bin.mjs")], { encoding: "utf8", env: { ...process.env, DSH_HOME: directHome } });
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(fs.readFileSync(path.join(directHome, "cordis.patch.yml"), "utf8"), /id: sessionbus/u);

  const failed = spawnSync(command, [], { encoding: "utf8", env: { ...process.env, DSH_HOME: path.join(directory, "failed-home"), PATH: path.dirname(process.execPath) } });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /dsh plugin add failed/u);
});
