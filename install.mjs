#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const profilePatch = `- id: system-prompt
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
`;
const peerPatch = `- insert:
    - { id: sessionbus, name: '@sessionbus/dsh' }
`;
const sessionbusID = /(?:^\s*-\s*|[{,]\s*)id\s*:\s*['"]?sessionbus['"]?(?=\s|[,}])/mu;
function writeChanged(file, body) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== body) writeFileSync(file, body);
}

function mergedProfilesHaveSessionbus(home) {
  const profiles = path.join(home, "profiles");
  if (!existsSync(profiles)) return false;
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "sessionbus") continue;
    const profile = path.join(profiles, entry.name);
    const manifestFile = path.join(profile, "package.json");
    if (!existsSync(manifestFile)) continue;
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const patches = [path.join(profile, "cordis.patch.yml")];
    for (const bundle of manifest.dsh?.profile?.bundles || []) {
      const packageRoot = path.join(profile, "node_modules", ...bundle.split("/"));
      const bundleManifestFile = path.join(packageRoot, "package.json");
      if (!existsSync(bundleManifestFile)) continue;
      const bundleManifest = JSON.parse(readFileSync(bundleManifestFile, "utf8"));
      const patch = bundleManifest.dsh?.bundle?.patch;
      if (typeof patch === "string") patches.push(path.resolve(packageRoot, patch));
    }
    if (patches.some((file) => existsSync(file) && sessionbusID.test(readFileSync(file, "utf8")))) return true;
  }
  return false;
}

function convergePeerPatch(file, providedByProduct) {
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (providedByProduct) {
    const body = old === peerPatch ? "" : old.replace(`\n${peerPatch}`, "\n");
    if (body === "") {
      if (existsSync(file)) rmSync(file);
    } else {
      writeChanged(file, body);
    }
    return;
  }
  if (sessionbusID.test(old)) return;
  const empty = /^(?:\s*#.*\n)*\s*\[\]\s*$/u.test(old);
  writeChanged(file, `${empty ? "" : old.trimEnd() + (old.trim() ? "\n\n" : "")}${peerPatch}`);
}

export function install(options = {}) {
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const root = options.root || path.dirname(fileURLToPath(import.meta.url));
  const profile = path.join(home, "profiles", "sessionbus");
  const manifestFile = path.join(profile, "package.json");
  const run = options.run || ((args) => spawnSync("dsh", args, { cwd: root, encoding: "utf8" }));
  const productProvidesPeer = mergedProfilesHaveSessionbus(home);
  let manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
  if (!manifest?.dependencies?.["@sessionbus/dsh"]) {
    const result = run(["plugin", "--profile", "sessionbus", "add", "@sessionbus/dsh"]);
    if (result.status !== 0) throw new Error(String(result.stderr || "dsh plugin add failed").trim());
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  }
  manifest = {
    name: "dsh-profile-sessionbus",
    private: true,
    dependencies: { "@sessionbus/dsh": manifest.dependencies["@sessionbus/dsh"] },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "startup" } },
  };
  writeChanged(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  writeChanged(path.join(profile, "cordis.patch.yml"), profilePatch);
  convergePeerPatch(path.join(home, "cordis.patch.yml"), productProvidesPeer);
}
