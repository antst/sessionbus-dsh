#!/usr/bin/env bash
set -euo pipefail

version=${1:?pass the DSH version}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/sessionbus-dsh-proof.XXXXXX")
server_pid=
dsh_pid=

stop_processes() {
  if [[ -n "$dsh_pid" ]]; then kill -TERM "$dsh_pid" 2>/dev/null || true; wait "$dsh_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then kill -TERM "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  dsh_pid=
  server_pid=
}
assert_permission_proof() {
  node --input-type=module - "$1" "$2" "${3:-}" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [capture, root, token] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(capture, "utf8"));
const input = "W087_INPUT_SENTINEL", deliveryInput = "W087_DELIVERY_SENTINEL";
assert.equal(state.hello, true);
assert.equal(state.listed, true);
if (Object.hasOwn(state, "ready")) assert.equal(state.ready, true);
if (token !== "") {
  assert.equal(state.helloParams.launch_token, token);
  assert.equal(Object.hasOwn(state.helloParams, "groups"), false);
  assert.deepEqual(state.open.request.params.groups, ["lane-primary", "lane-secondary"]);
  assert.equal(typeof state.open.response.result.session_id, "string");
  assert.equal(state.run.result.result, input);
  assert.deepEqual(state.deliveryReceipt, { disposition: "injected" });
  assert.equal(state.deliveryRun.result.result, deliveryInput);
}
const files = [];
const walk = directory => {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target); else if (/session(?:\.v\d+)?\.jsonl$/u.test(entry.name)) files.push(target);
  }
};
walk(root);
const events = files.flatMap(file => fs.readFileSync(file, "utf8").trim().split("\n").slice(1).map(line => JSON.parse(line)));
assert.equal(events.some(event => event.type === "user/message" && event.data?.content?.[0]?.type === "text" && event.data.content[0].text === input), true);
assert.equal(events.some(event => event.type === "assistant/message" && event.data?.message?.content?.some(part => part.type === "text" && part.text === input)), true);
assert.equal(events.some(event => event.type === "user/message" && event.data?.content?.[0]?.type === "text" && event.data.content[0].text === deliveryInput), true);
assert.equal(events.some(event => event.type === "assistant/message" && event.data?.message?.content?.some(part => part.type === "text" && part.text === deliveryInput)), true);
const sessionbusCall = events.find(event => event.type === "tool/call" && event.data?.name === "sessionbus");
assert.ok(sessionbusCall);
assert.equal(events.some(event => event.type === "tool/result" && event.data?.message?.source?.callId === sessionbusCall.data.callId), true);
assert.equal(events.some(event => event.type === "approval/asked" && event.data?.toolName === "sessionbus"), false);
const dummyCall = events.find(event => event.type === "tool/call" && event.data?.name === "w081_dummy");
assert.ok(dummyCall);
const dummyResult = events.find(event => event.type === "tool/result" && event.data?.message?.source?.callId === dummyCall.data.callId);
assert.equal(events.filter(event => event.type === "approval/asked" && event.data?.toolName === "w081_dummy").length, 1,
  `dummy approval mismatch: ${JSON.stringify(dummyResult)}`);
assert.equal(events.some(event => event.type === "turn/end" && event.data?.reason?.kind === "completed"), true);
NODE
}
cleanup() {
  stop_processes
  rm -rf -- "$work"
}
trap cleanup EXIT

tarball_name=$(npm pack --pack-destination "$work" --ignore-scripts --json --prefix "$root" | node -e 'let body=""; process.stdin.on("data", chunk => body += chunk).on("end", () => process.stdout.write(JSON.parse(body)[0].filename))')
tarball="$work/$tarball_name"
home="$work/home"
mkdir -p "$home"
printf '%s\n' '{"private":true}' > "$home/package.json"
published=$(npm view "@deepseek-ai/dsh@$version" "time[$version]" --json | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8"))')
release_cutoff=$(node -e 'console.log(new Date(Date.parse(process.argv[1]) + 3600000).toISOString())' "$published")
npm install --prefix "$home" --save-exact --before "$release_cutoff" \
  "@deepseek-ai/dsh@$version" \
  "@deepseek-ai/cordis@4.0.2" \
  "@deepseek-ai/cordis-plugin-loader@1.0.3"
npm install --prefix "$home" --save-exact "@antst/dashi-launcher@0.1.0-alpha.20"
dsh="$home/node_modules/.bin/dsh"

for profile in sessionbus web dashi; do
  DSH_HOME="$home" "$dsh" plugin --profile "$profile" add "$tarball"
done
DSH_HOME="$home" "$home/profiles/sessionbus/node_modules/.bin/sessionbus-dsh-install"
DSH_HOME="$home" "$home/profiles/web/node_modules/.bin/sessionbus-dsh-install" --product dsh web
printf '%s\n' '- insert:' \
  "    - { id: workspace, name: '@deepseek-ai/dsh-workspace' }" \
  "    - { id: session-controller, name: '@deepseek-ai/dsh-api-session-controller' }" \
  "    - { id: sessionbus, name: '@sessionbus/dsh' }" > "$home/profiles/dashi/cordis.patch.yml"
DSH_HOME="$home" "$home/profiles/dashi/node_modules/.bin/sessionbus-dsh-install" --product dashi dashi
for profile in sessionbus web dashi; do
  if [[ "$version" = 0.1.6-alpha.1 ]]; then
  cat > "$home/profiles/$profile/.pnpmfile.cjs" <<EOF
const DSH_VERSION = '$version'
const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
module.exports = { hooks: { readPackage(pkg) {
  for (const field of fields) for (const name of Object.keys(pkg[field] ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) pkg[field][name] = DSH_VERSION
  }
  return pkg
} } }
EOF
  fi
  pnpm --dir "$home/profiles/$profile" add --save-exact "@deepseek-ai/dsh-llm-replay@$version" "$root/.github/fixtures/ask-all-plugin"
done

node --input-type=module - "$home" "$version" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const [home, version] = process.argv.slice(2);
const require = createRequire(`${home}/package.json`);
const readPatch = (profile) => fs.readFileSync(`${home}/profiles/${profile}/cordis.patch.yml`, "utf8");
const lane = readPatch("sessionbus");
const web = readPatch("web");
const dashi = readPatch("dashi");
assert.match(lane, /mode: lane/u);
assert.match(lane, /product: sessionbus-dsh/u);
assert.match(lane, /dsh-file-uploads-none/u);
assert.match(web, /id: sessionbus/u);
assert.match(web, /product: dsh/u);
assert.doesNotMatch(web, /file-uploads-none/u);
assert.equal((dashi.match(/id: sessionbus/gu) || []).length, 1);
assert.match(dashi, /product: dashi/u);
assert.match(dashi, /dsh-file-uploads-none/u);
assert.equal(fs.existsSync(`${home}/cordis.patch.yml`), false);
for (const [name, wanted] of [["@deepseek-ai/dsh", version], ["@deepseek-ai/cordis", "4.0.2"], ["@deepseek-ai/cordis-plugin-loader", "1.0.3"], ["@antst/dashi-launcher", "0.1.0-alpha.20"]]) {
  assert.equal(require(`${name}/package.json`).version, wanted);
}
const plugin = require(`${home}/profiles/sessionbus/node_modules/@sessionbus/dsh/package.json`).version;
console.log(JSON.stringify({ version, plugin, profiles: "PASS", packedInstall: "PASS" }));
NODE

fixture="$root/.github/fixtures/sessionbus-tool-call.jsonl"
proof_patch="$root/.github/fixtures/sessionbus-tool-call.patch.yml"

socket="$work/lane.sock"
capture="$work/lane-proof.json"
token="w075-fake-$version"
echo "DSH $version sessionbus lane permission proof"
node "$root/.github/scripts/fake-permission-sessionbus.mjs" "$socket" "$capture" sessionbus-dsh worker &
server_pid=$!
for _ in $(seq 1 50); do [[ -S "$socket" ]] && break; sleep 0.1; done
PATH="$home/node_modules/.bin:$PATH" DSH_HOME="$home" DSH_SNAPSHOT_FILE="$fixture" DSH_W081_SESSION_ROOT="$work/lane-sessions" SESSIONBUS_SOCKET="$socket" SESSIONBUS_LAUNCH_TOKEN="$token" SESSIONBUS_GROUPS='not-json' "$home/profiles/sessionbus/node_modules/.bin/sessionbus-dsh" --patch "$proof_patch" >"$work/lane.stdout" 2>"$work/lane.stderr" &
dsh_pid=$!
for _ in $(seq 1 300); do [[ -s "$capture" ]] && grep -q '"ready":true' "$capture" && break; kill -0 "$dsh_pid" 2>/dev/null || break; sleep 0.1; done
if [[ ! -s "$capture" ]] || ! grep -q '"ready":true' "$capture"; then cat "$capture" "$work/lane.stdout" "$work/lane.stderr" >&2 2>/dev/null || true; exit 1; fi
assert_permission_proof "$capture" "$work/lane-sessions" "$token"
stop_processes

DSH_HOME="$home" "$home/profiles/sessionbus/node_modules/.bin/sessionbus-dsh-install" --product dashi
grep -q 'config: { mode: lane, product: dashi }' "$home/profiles/sessionbus/cordis.patch.yml"
socket="$work/dashi-lane.sock"
capture="$work/dashi-lane-proof.json"
token="w084-dashi-lane-$version"
echo "DSH $version dashi launcher lane permission proof"
node "$root/.github/scripts/fake-permission-sessionbus.mjs" "$socket" "$capture" dashi worker &
server_pid=$!
for _ in $(seq 1 50); do [[ -S "$socket" ]] && break; sleep 0.1; done
PATH="$home/node_modules/.bin:$PATH" DSH_HOME="$home" DSH_SNAPSHOT_FILE="$fixture" DSH_W081_SESSION_ROOT="$work/dashi-lane-sessions" SESSIONBUS_SOCKET="$socket" SESSIONBUS_LAUNCH_TOKEN="$token" SESSIONBUS_GROUPS='not-json' "$home/node_modules/.bin/dashi" --patch "$proof_patch" >"$work/dashi-lane.stdout" 2>"$work/dashi-lane.stderr" &
dsh_pid=$!
for _ in $(seq 1 300); do [[ -s "$capture" ]] && grep -q '"ready":true' "$capture" && break; kill -0 "$dsh_pid" 2>/dev/null || break; sleep 0.1; done
if [[ ! -s "$capture" ]] || ! grep -q '"ready":true' "$capture"; then cat "$capture" "$work/dashi-lane.stdout" "$work/dashi-lane.stderr" >&2 2>/dev/null || true; exit 1; fi
assert_permission_proof "$capture" "$work/dashi-lane-sessions" "$token"
stop_processes

socket="$work/dashi.sock"
capture="$work/dashi-proof.json"
token="w077-dashi-$version"
echo "DSH $version dashi row permission proof"
node "$root/.github/scripts/fake-permission-sessionbus.mjs" "$socket" "$capture" dashi worker &
server_pid=$!
for _ in $(seq 1 50); do [[ -S "$socket" ]] && break; sleep 0.1; done
DSH_HOME="$home" DSH_SNAPSHOT_FILE="$fixture" DSH_W081_SESSION_ROOT="$work/dashi-sessions" SESSIONBUS_SOCKET="$socket" SESSIONBUS_LAUNCH_TOKEN="$token" "$dsh" --profile dashi --patch "$proof_patch" >"$work/dashi.stdout" 2>"$work/dashi.stderr" &
dsh_pid=$!
for _ in $(seq 1 300); do [[ -s "$capture" ]] && grep -q '"ready":true' "$capture" && break; kill -0 "$dsh_pid" 2>/dev/null || break; sleep 0.1; done
if [[ ! -s "$capture" ]] || ! grep -q '"ready":true' "$capture"; then cat "$capture" "$work/dashi.stdout" "$work/dashi.stderr" >&2 2>/dev/null || true; exit 1; fi
assert_permission_proof "$capture" "$work/dashi-sessions" "$token"
stop_processes

port=$(node -e 'const net=require("node:net"),server=net.createServer(); server.listen(0,"127.0.0.1",()=>{process.stdout.write(String(server.address().port)); server.close()})')
socket="$work/peer.sock"
capture="$work/web-proof.json"
echo "DSH $version web peer permission proof"
node "$root/.github/scripts/fake-permission-sessionbus.mjs" "$socket" "$capture" dsh peer &
server_pid=$!
for _ in $(seq 1 50); do [[ -S "$socket" ]] && break; sleep 0.1; done
DSH_HOME="$home" DSH_SNAPSHOT_FILE="$fixture" DSH_W081_SESSION_ROOT="$work/web-sessions" SESSIONBUS_SOCKET="$socket" "$dsh" --profile web --patch "$proof_patch" --no-open --host 127.0.0.1 --port "$port" >"$work/web.stdout" 2>"$work/web.stderr" &
dsh_pid=$!
ready=false
for _ in $(seq 1 200); do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then ready=true; break; fi
  kill -0 "$dsh_pid" 2>/dev/null || break
  sleep 0.1
done
if [[ "$ready" != true ]]; then cat "$work/web.stdout" "$work/web.stderr" >&2; exit 1; fi
for _ in $(seq 1 50); do grep -q 'dsh web: http://' "$work/web.stdout" && break; sleep 0.1; done
launch_url=$(grep -Eo 'http://[^[:space:]]+' "$work/web.stdout" | tail -1)
node --input-type=module - "$launch_url" <<'NODE'
import assert from "node:assert/strict";
import crypto from "node:crypto";

const launch = process.argv[2];
const login = await fetch(launch, { redirect: "manual" });
assert.equal(login.status, 303);
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
assert.ok(cookie);
const origin = new URL(launch).origin;
const rpc = async (method, args) => {
  const response = await fetch(`${origin}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload: { args } }),
  });
  const body = await response.json();
  if (!body.result?.ok) throw new Error(`${method}: ${JSON.stringify(body)}`);
  return body.result.value;
};
const created = await rpc("session/create", { request: {} });
await rpc("session/selectModel", { request: { sessionId: created.sessionId, provider: "deepseek-official", model: "deepseek-v4-flash" } });
await rpc("session/prompt", { request: { requestId: crypto.randomUUID(), sessionId: created.sessionId, mode: "queue", content: [{ type: "text", text: "W087_INPUT_SENTINEL" }] } });
await rpc("session/prompt", { request: { requestId: crypto.randomUUID(), sessionId: created.sessionId, mode: "queue", content: [{ type: "text", text: "W087_DELIVERY_SENTINEL" }] } });
NODE
for _ in $(seq 1 300); do [[ -s "$capture" ]] && grep -q '"listed":true' "$capture" && [[ $(grep -Rh '"type":"turn/end"' "$work/web-sessions" 2>/dev/null | wc -l) -ge 2 ]] && break; kill -0 "$dsh_pid" 2>/dev/null || break; sleep 0.1; done
assert_permission_proof "$capture" "$work/web-sessions"
stop_processes

for profile in sessionbus web dashi; do
  DSH_HOME="$home" "$home/profiles/$profile/node_modules/.bin/sessionbus-dsh-install" --remove "$profile"
done
node --input-type=module - "$home" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";

const home = process.argv[2];
for (const profile of ["sessionbus", "web", "dashi"]) {
  const manifest = JSON.parse(fs.readFileSync(`${home}/profiles/${profile}/package.json`, "utf8"));
  const patch = fs.readFileSync(`${home}/profiles/${profile}/cordis.patch.yml`, "utf8");
  assert.equal(manifest.dependencies?.["@sessionbus/dsh"], undefined);
  assert.doesNotMatch(patch, /id:\s*sessionbus|id:\s*file-uploads-none/u);
}
NODE
echo "DSH $version sessionbus-dsh and dashi launcher lanes, dashi and web peers without approval; packed install and uninstall: PASS"
