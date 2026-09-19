#!/usr/bin/env bash
set -euo pipefail

version=0.1.2-rc.1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/sessionbus-dsh-floor.XXXXXX")
trap 'rm -rf -- "$work"' EXIT

tarball_name=$(npm pack --pack-destination "$work" --ignore-scripts --json --prefix "$root" | node -e 'let body=""; process.stdin.on("data", chunk => body += chunk).on("end", () => process.stdout.write(JSON.parse(body)[0].filename))')
profile="$work/home/profiles/peer-floor"
mkdir -p "$profile"
printf '%s\n' '{"name":"dsh-profile-peer-floor","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"],"patchReload":"startup"}}}' > "$profile/package.json"
mapfile -t peers < <(node - "$root/package.json" "$version" <<'NODE'
const [manifestFile, version] = process.argv.slice(2)
const peers = JSON.parse(require('node:fs').readFileSync(manifestFile)).peerDependencies
for (const name of Object.keys(peers)) {
  if (name.startsWith('@deepseek-ai/dsh-')) console.log(`${name}@${version}`)
}
NODE
)
PNPM_CONFIG_BLOCK_EXOTIC_SUBDEPS=false pnpm --dir "$profile" add --save-exact --ignore-scripts "$work/$tarball_name" \
  @deepseek-ai/cordis@4.0.2 @deepseek-ai/cordis-plugin-loader@1.0.3 \
  "${peers[@]}" > "$work/install.log" 2>&1
PNPM_CONFIG_BLOCK_EXOTIC_SUBDEPS=false pnpm --dir "$profile" peers check --json > "$work/peers.json" 2>&1 || true
cat "$work/install.log"
cat "$work/peers.json"
node - "$root/package.json" "$profile/package.json" "$work/install.log" "$work/peers.json" "$version" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const [sourceFile, installedFile, logFile, peersFile, version] = process.argv.slice(2)
const source = JSON.parse(fs.readFileSync(sourceFile))
const installed = JSON.parse(fs.readFileSync(installedFile))
const log = fs.readFileSync(logFile, 'utf8')
let bad
try { bad = JSON.parse(fs.readFileSync(peersFile, 'utf8'))['.'].bad } catch {}
assert.ok(installed.dependencies['@sessionbus/dsh'])
for (const [name, range] of Object.entries(source.peerDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) {
    assert.ok(bad?.[name]?.some(peer => peer.wantedRange === range && peer.foundVersion === version) || log.includes(`unmet peer ${name}@${range}: found ${version}`))
  }
}
NODE
DSH_HOME="$work/home" "$profile/node_modules/.bin/sessionbus-dsh-install" --product dsh peer-floor
DSH_HOME="$work/home" "$profile/node_modules/.bin/sessionbus-dsh-install" --remove peer-floor
node - "$profile" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const profile = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(`${profile}/package.json`))
const patch = fs.readFileSync(`${profile}/cordis.patch.yml`, 'utf8')
assert.equal(manifest.dependencies?.['@sessionbus/dsh'], undefined)
assert.doesNotMatch(patch, /id:\s*sessionbus|id:\s*file-uploads-none/u)
NODE
echo "DSH $version install completed with every below-floor peer warning, then uninstalled: PASS"
