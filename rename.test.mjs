import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const roots = [".github", ".gitignore", "docs", "README.md", "install.mjs", "install.test.mjs", "package.json", "package.test.cjs", "plugin.cjs", "plugin.test.cjs"];
const evidence = `/home/antst/${"agent" + "bus"}-evidence/`;
const former = new RegExp(["agent" + "bus", "agent" + "_sessions", "agent" + "-sessions"].join("|"), "iu");

async function files(entry) {
  const value = await readdir(entry, { withFileTypes: true }).catch(() => []);
  if (value.length === 0) return [entry];
  return (await Promise.all(value.map((item) => files(path.join(entry, item.name))))).flat();
}

function sourcePath(value) {
  const colon = value.indexOf(":");
  if (colon < 7 || colon > 40 || !/^[0-9a-f]+$/u.test(value.slice(0, colon))) return false;
  let file = value.slice(colon + 1);
  const line = file.lastIndexOf(":");
  if (line >= 0 && /^\d+(?:-\d+)?$/u.test(file.slice(line + 1))) file = file.slice(0, line);
  const segments = file.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== ".." && /^[A-Za-z0-9_.-]+$/u.test(segment)) && (file.includes("/") || file.includes("."));
}

function hasFormerReference(body) {
  return body.split("\n").some((line) => {
    const pieces = line.replaceAll(evidence, "").split("`");
    for (let index = 1; index < pieces.length; index += 2) if (sourcePath(pieces[index])) pieces[index] = "";
    return former.test(pieces.join(""));
  });
}

test("published files contain only sessionbus names", async () => {
  const checked = (await Promise.all(roots.map(files))).flat();
  const stale = [];
  for (const file of checked) {
    if (former.test(file) || hasFormerReference(await readFile(file, "utf8"))) stale.push(file);
  }
  assert.deepEqual(stale, []);
});

test("former-name exceptions require exact historical paths", () => {
  assert.equal(hasFormerReference("plain " + "agent" + "bus"), true);
  assert.equal(hasFormerReference("`ff81565:cmd/" + "agent" + "-sessions/main.go:12`"), false);
  assert.equal(hasFormerReference("`ff81565:" + "agent" + "-sessions prose`"), true);
  assert.equal(hasFormerReference("`ff81565:docs/" + "agent" + "-sessions.md\u00a0prose`"), true);
  assert.equal(hasFormerReference("`ff81565:docs/../" + "agent" + "-sessions.md`"), true);
  assert.equal(hasFormerReference("`/home/antst/" + "agent" + "bus-evidence/run/frame.json`"), false);
});
