#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
    - { id: file-uploads-none, name: '@antst/dsh-file-uploads-none' }
    - { id: session-controller, name: '@deepseek-ai/dsh-api-session-controller' }
    - id: sessionbus
      name: '@sessionbus/dsh'
      config: { mode: lane }
`;
const peerPatch = `- insert:
    - { id: sessionbus, name: '@sessionbus/dsh' }
`;
const noUploadsPatch = `- insert:
    - { id: file-uploads-none, name: '@antst/dsh-file-uploads-none' }
`;
const sessionbusID = /(?:^\s*-\s*|[{,]\s*)id\s*:\s*['"]?sessionbus['"]?(?=\s|[,}])/mu;
const noUploadsID = /(?:^\s*-\s*|[{,]\s*)id\s*:\s*['"]?file-uploads-none['"]?(?=\s|[,}])/mu;
function writeChanged(file, body) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== body) writeFileSync(file, body);
}

function convergePatch(file, id, patch) {
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (id.test(old)) return;
  const empty = /^(?:\s*#.*\n)*\s*\[\]\s*$/u.test(old);
  writeChanged(file, `${empty ? "" : old.trimEnd() + (old.trim() ? "\n\n" : "")}${patch}`);
}

export function install(profileNames = [], options = {}) {
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const root = options.root || path.dirname(fileURLToPath(import.meta.url));
  const run = options.run || ((args) => spawnSync("dsh", args, { cwd: root, encoding: "utf8" }));
  for (const name of new Set(profileNames.length ? profileNames : ["sessionbus"])) {
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name === "node_modules") throw new Error(`invalid profile name ${JSON.stringify(name)}`);
    const profile = path.join(home, "profiles", name);
    const manifestFile = path.join(profile, "package.json");
    let manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
    if (!manifest?.dependencies?.["@sessionbus/dsh"]) {
      const result = run(["plugin", "--profile", name, "add", "@sessionbus/dsh"]);
      if (result.status !== 0) throw new Error(String(result.stderr || "dsh plugin add failed").trim());
      manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    }
    if (name !== "sessionbus") {
      const patch = path.join(profile, "cordis.patch.yml");
      convergePatch(patch, sessionbusID, peerPatch);
      if (name !== "web") convergePatch(patch, noUploadsID, noUploadsPatch);
      continue;
    }
    manifest = {
      name: "dsh-profile-sessionbus",
      private: true,
      dependencies: { "@sessionbus/dsh": manifest.dependencies["@sessionbus/dsh"] },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "startup" } },
    };
    writeChanged(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    writeChanged(path.join(profile, "cordis.patch.yml"), profilePatch);
  }
}
