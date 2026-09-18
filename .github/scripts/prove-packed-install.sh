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
cleanup() {
  stop_processes
  rm -rf -- "$work"
}
trap cleanup EXIT

tarball_name=$(npm pack --pack-destination "$work" --ignore-scripts --json --prefix "$root" | node -e 'let body=""; process.stdin.on("data", chunk => body += chunk).on("end", () => process.stdout.write(JSON.parse(body)[0].filename))')
tarball="$work/$tarball_name"
home="$work/home"
mkdir -p "$home"
npm install --prefix "$home" --save-exact \
  "@deepseek-ai/dsh@$version" \
  "@deepseek-ai/cordis@4.0.2" \
  "@deepseek-ai/cordis-plugin-loader@1.0.3"
dsh="$home/node_modules/.bin/dsh"

for profile in sessionbus web dashi; do
  DSH_HOME="$home" "$dsh" plugin --profile "$profile" add "$tarball"
done
DSH_HOME="$home" "$home/profiles/sessionbus/node_modules/.bin/sessionbus-dsh-install"
DSH_HOME="$home" "$home/profiles/web/node_modules/.bin/sessionbus-dsh-install" web
printf '%s\n' '[{"insert":[{"id":"sessionbus","name":"@sessionbus/dsh"}]}]' > "$home/profiles/dashi/cordis.patch.yml"
DSH_HOME="$home" "$home/profiles/dashi/node_modules/.bin/sessionbus-dsh-install" dashi

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
assert.match(lane, /dsh-file-uploads-none/u);
assert.match(web, /id: sessionbus/u);
assert.doesNotMatch(web, /file-uploads-none/u);
assert.equal((dashi.match(/id: sessionbus/gu) || []).length, 1);
assert.match(dashi, /dsh-file-uploads-none/u);
assert.equal(fs.existsSync(`${home}/cordis.patch.yml`), false);
for (const [name, wanted] of [["@deepseek-ai/dsh", version], ["@deepseek-ai/cordis", "4.0.2"], ["@deepseek-ai/cordis-plugin-loader", "1.0.3"]]) {
  assert.equal(require(`${name}/package.json`).version, wanted);
}
const plugin = require(`${home}/profiles/sessionbus/node_modules/@sessionbus/dsh/package.json`).version;
console.log(JSON.stringify({ version, plugin, profiles: "PASS", packedInstall: "PASS" }));
NODE

socket="$work/lane.sock"
capture="$work/lane-hello.json"
token="w075-fake-$version"
node "$root/.github/scripts/fake-sessionbus.mjs" "$socket" "$capture" &
server_pid=$!
for _ in $(seq 1 50); do [[ -S "$socket" ]] && break; sleep 0.1; done
DSH_HOME="$home" SESSIONBUS_SOCKET="$socket" SESSIONBUS_LAUNCH_TOKEN="$token" "$dsh" --profile sessionbus >"$work/lane.stdout" 2>"$work/lane.stderr" &
dsh_pid=$!
for _ in $(seq 1 200); do [[ -s "$capture" ]] && break; kill -0 "$dsh_pid" 2>/dev/null || break; sleep 0.1; done
if [[ ! -s "$capture" ]]; then cat "$work/lane.stderr" >&2; exit 1; fi
node --input-type=module - "$capture" "$token" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";

const [capture, token] = process.argv.slice(2);
const frame = JSON.parse(fs.readFileSync(capture, "utf8"));
assert.equal(frame.method, "session.hello");
assert.equal(frame.params.launch_token, token);
assert.equal(frame.params.product, "dashi");
NODE
stop_processes

port=$(node -e 'const net=require("node:net"),server=net.createServer(); server.listen(0,"127.0.0.1",()=>{process.stdout.write(String(server.address().port)); server.close()})')
DSH_HOME="$home" SESSIONBUS_SOCKET="$work/peer.sock" "$dsh" --profile web --no-open --host 127.0.0.1 --port "$port" >"$work/web.stdout" 2>"$work/web.stderr" &
dsh_pid=$!
ready=false
for _ in $(seq 1 200); do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then ready=true; break; fi
  kill -0 "$dsh_pid" 2>/dev/null || break
  sleep 0.1
done
if [[ "$ready" != true ]]; then cat "$work/web.stdout" "$work/web.stderr" >&2; exit 1; fi
echo "DSH $version lane hello, web boot, dashi coexistence, and packed install: PASS"
