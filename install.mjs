#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const profilePatch = (product) => `- id: system-prompt
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
      config: { mode: lane, product: ${product} }
`;
const peerPatch = (product) => `- insert:
    - { id: sessionbus, name: '@sessionbus/dsh', config: { product: ${product} } }
`;
const noUploadsPatch = `- insert:
    - { id: file-uploads-none, name: '@antst/dsh-file-uploads-none' }
`;
const sessionbusID = /(?:^\s*-\s*|[{,]\s*)['"]?id['"]?\s*:\s*['"]?sessionbus['"]?(?=\s|[,}]|$)/mu;
const noUploadsID = /(?:^\s*-\s*|[{,]\s*)['"]?id['"]?\s*:\s*['"]?file-uploads-none['"]?(?=\s|[,}]|$)/mu;
const productPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const ownedIDs = [sessionbusID, noUploadsID];
function writeChanged(file, body) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== body) writeFileSync(file, body);
}

function convergePatch(file, id, patch) {
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (id.test(old)) return;
  const empty = /^(?:\s*#.*\n)*\s*\[\]\s*$/u.test(old);
  writeChanged(file, `${empty ? "" : old.trimEnd() + (old.trim() ? "\n\n" : "")}${patch}`);
}

function withProduct(body, product) {
  const lines = body.split("\n");
  const row = lines.findIndex((line) => sessionbusID.test(line));
  if (row < 0) return body;
  const value = /(['"]?product['"]?\s*:\s*)(?:'[^']*'|"[^"]*"|[^,\s}]+)/u;
  const column = lines[row].search(/['"]?id['"]?\s*:/u);
  const open = lines[row].lastIndexOf("{", column);
  if (open >= 0) {
    if (value.test(lines[row])) lines[row] = lines[row].replace(value, `$1${product}`);
    else if (/['"]?config['"]?\s*:\s*\{/u.test(lines[row])) lines[row] = lines[row].replace(/(['"]?config['"]?\s*:\s*\{\s*)/u, `$1product: ${product}, `);
    else {
      let depth = 0, close = -1;
      for (let index = open; index < lines[row].length; index++) {
        if (lines[row][index] === "{") depth++;
        if (lines[row][index] === "}" && --depth === 0) { close = index; break; }
      }
      lines[row] = `${lines[row].slice(0, close)}, config: { product: ${product} }${lines[row].slice(close)}`;
    }
    return lines.join("\n");
  }
  const indent = lines[row].match(/^\s*/u)[0].length;
  let end = row + 1;
  while (end < lines.length && !new RegExp(`^\\s{0,${indent}}-\\s+`, "u").test(lines[end])) end++;
  for (let index = row; index < end; index++) {
    if (value.test(lines[index])) { lines[index] = lines[index].replace(value, `$1${product}`); return lines.join("\n"); }
  }
  const config = lines.slice(row, end).findIndex((line) => /^\s*['"]?config['"]?\s*:/u.test(line));
  if (config >= 0) {
    const index = row + config;
    if (lines[index].includes("{")) lines[index] = lines[index].replace(/\{\s*/u, `{ product: ${product}, `);
    else lines.splice(index + 1, 0, `${lines[index].match(/^\s*/u)[0]}  product: ${product}`);
  } else {
    if (end === lines.length && lines.at(-1) === "") end--;
    lines.splice(end, 0, `${" ".repeat(indent + 2)}config: { product: ${product} }`);
  }
  return lines.join("\n");
}

function convergeSessionbus(file, product) {
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (sessionbusID.test(old)) return writeChanged(file, withProduct(old, product));
  convergePatch(file, sessionbusID, peerPatch(product));
}

function withoutOwnedRows(body) {
  const lines = body.split(/(?<=\n)/u);
  for (let row = lines.length - 1; row >= 0; row--) {
    const text = lines[row].replace(/\r?\n$/u, "");
    if (!ownedIDs.some((id) => id.test(text))) continue;
    const indent = text.match(/^\s*/u)[0].length;
    let end = row + 1;
    if (!text.includes("{")) {
      while (end < lines.length) {
        const next = lines[end].replace(/\r?\n$/u, "");
        const nextIndent = next.match(/^\s*/u)[0].length;
        if ((/^\s*-\s+/u.test(next) || /^\s*#/u.test(next)) && nextIndent <= indent) break;
        end++;
      }
    }
    lines.splice(row, end - row);
  }
  for (let row = lines.length - 1; row >= 0; row--) {
    const match = /^(\s*)-\s+insert:\s*(?:#.*)?(?:\r?\n)?$/u.exec(lines[row]);
    if (!match) continue;
    let child = row + 1;
    while (child < lines.length && /^\s*(?:#.*)?(?:\r?\n)?$/u.test(lines[child])) child++;
    if (child === lines.length || lines[child].match(/^\s*/u)[0].length <= match[1].length) {
      if (row > 0 && /^\s*(?:\r?\n)?$/u.test(lines[row - 1])) lines.splice(row - 1, 2);
      else lines.splice(row, 1);
    }
  }
  const result = lines.join("");
  return result.trim() ? result : "[]\n";
}

function validProfile(name) {
  return name && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".." && name !== "node_modules";
}

export function install(profileNames = [], options = {}) {
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const root = options.root || path.dirname(fileURLToPath(import.meta.url));
  const run = options.run || ((args) => spawnSync("dsh", args, { cwd: root, encoding: "utf8" }));
  const names = [...new Set(profileNames.length ? profileNames : ["sessionbus"])];
  const laneProduct = options.product ?? "sessionbus-dsh";
  if (options.product !== undefined && (typeof options.product !== "string" || !productPattern.test(options.product))) throw new Error(`invalid product ${JSON.stringify(options.product)}; expected ^[a-z0-9][a-z0-9-]{0,31}$`);
  if (names.includes("sessionbus") && !["sessionbus-dsh", "dashi"].includes(laneProduct)) throw new Error("the sessionbus profile product must be sessionbus-dsh or dashi");
  if (names.some((name) => name !== "sessionbus") && options.product === undefined) throw new Error("--product is required for peer profiles");
  for (const name of names) {
    if (!validProfile(name)) throw new Error(`invalid profile name ${JSON.stringify(name)}`);
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
      convergeSessionbus(patch, options.product);
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
    writeChanged(path.join(profile, "cordis.patch.yml"), profilePatch(laneProduct));
  }
}

export function remove(profileNames = [], options = {}) {
  if (profileNames.length === 0) throw new Error("--remove requires at least one profile");
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const run = options.run || ((args, cwd) => spawnSync("pnpm", args, { cwd, encoding: "utf8" }));
  for (const name of [...new Set(profileNames)]) {
    if (!validProfile(name)) throw new Error(`invalid profile name ${JSON.stringify(name)}`);
    const profile = path.join(home, "profiles", name);
    const result = run(["remove", "@sessionbus/dsh"], profile);
    if (result.status !== 0) throw new Error(String(result.stderr || result.error?.message || "pnpm remove failed").trim());
    const patch = path.join(profile, "cordis.patch.yml");
    if (existsSync(patch)) writeChanged(patch, withoutOwnedRows(readFileSync(patch, "utf8")));
  }
}
