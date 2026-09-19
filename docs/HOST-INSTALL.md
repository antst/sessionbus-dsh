# Installing a DSH lane host

This runbook installs a DSH lane host, with `umka-dev1` as the worked
example. Run it as the ordinary `pdev` user on `umka-dev1`, never with
`sudo`. The target set is DSH `0.1.5-rc.2`, dashi `0.1.0-alpha.19`, and
`@sessionbus/dsh` `0.1.0-pre.2`. Do not continue past a failed assertion.
None of the commands below prints `SESSIONBUS_LAUNCH_TOKEN`,
`SESSIONBUS_GROUPS`, the local key, or the federation secret.

Dashi `0.1.0-alpha.19` is the release in progress; alpha.18 lacks the `sessionbus` profile row and the launcher token path.
The other pinned packages below are published. Run these exact probes
immediately before starting:

```sh
npm view @antst/dashi-launcher@0.1.0-alpha.19 version && npm view @antst/dashi-app@0.1.0-alpha.19 version && npm view @antst/dsh-file-uploads-none@0.1.0-alpha.18 version
npm view @sessionbus/dsh@0.1.0-pre.2 version && npm view @sessionbus/kit@0.1.0-pre.3 version
```

Expected output, in order:

```text
0.1.0-alpha.19
0.1.0-alpha.19
0.1.0-alpha.18
0.1.0-pre.2
0.1.0-pre.3
```

An `E404` means stop; it is not permission to substitute a preview URL or a
different version.

## 1. Preflight inventory

Use one shell for the whole procedure so the paths and rollback record remain
authoritative:

```sh
set -eu
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
printf 'pnpm='; pnpm --version
printf 'resolved dsh='; command -v dsh
printf 'resolved dashi='; command -v dashi || true
printf 'resolved sessionbus-dsh='; command -v sessionbus-dsh || true
printf '%s\n' 'all dsh commands:'
type -a dsh || true
printf 'global root='; pnpm root -g
printf '%s\n' 'global direct packages:'
pnpm list --global --depth 0 @deepseek-ai/dsh @antst/dashi-launcher @sessionbus/dsh || true
printf '%s\n' 'home direct packages:'
pnpm --dir "$HOME" list --depth 0 @deepseek-ai/dsh @antst/dashi-launcher @sessionbus/dsh || true
printf '%s\n' 'profiles:'
find "$DSH_HOME/profiles" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | LC_ALL=C sort || true
for profile_dir in "$DSH_HOME"/profiles/*; do
  [ -d "$profile_dir" ] || continue
  printf '\nprofile %s direct packages:\n' "${profile_dir##*/}"
  pnpm --dir "$profile_dir" list --depth 0 @deepseek-ai/dsh @antst/dashi-app @sessionbus/dsh || true
done
```

Expected output:

- `pnpm=` is followed by the installed pnpm version; record it in the run
  report.
- `resolved dsh=` is one executable, while `type -a dsh` exposes every PATH
  copy. The global and home lists establish whether the active copy is global
  or home-level.
- `profiles:` prints every existing profile exactly once. Record the list even
  when it is empty. Each following profile block prints only its direct DSH,
  dashi-app, or sessionbus package rows; an empty block is valid.
- No command above prints an environment value.

Resolve the install project that owns the active command. The expected
`umka-dev1` layout is home-level, so this assertion deliberately stops on a
global or profile-local copy and also stops when any second install location
exists, even when that copy does not currently win PATH:

```sh
DSH_BIN=$(command -v dsh)
mapfile -t DSH_INSTALL_LOCATIONS < <({
  if [ -f "$HOME/node_modules/@deepseek-ai/dsh/package.json" ]; then
    printf '%s\n' "$HOME"
  fi
  global_modules=$(pnpm root -g)
  if [ -f "$global_modules/@deepseek-ai/dsh/package.json" ]; then
    dirname "$global_modules"
  fi
  for profile_dir in "$DSH_HOME"/profiles/*; do
    if [ -f "$profile_dir/node_modules/@deepseek-ai/dsh/package.json" ]; then
      printf '%s\n' "$profile_dir"
    fi
  done
} | LC_ALL=C sort -u)
printf '%s\n' 'DSH install locations:' "${DSH_INSTALL_LOCATIONS[@]}"
test "${#DSH_INSTALL_LOCATIONS[@]}" -eq 1
test "${DSH_INSTALL_LOCATIONS[0]}" = "$HOME"
test -x "$HOME/node_modules/.bin/dsh"
test "$(readlink -f "$DSH_BIN")" = "$(readlink -f "$HOME/node_modules/.bin/dsh")"
DSH_INSTALL_DIR=$HOME
printf '%s\n' 'DSH_INSTALL_DIR selected'
```

Expected output:

```text
DSH install locations:
/home/pdev
DSH_INSTALL_DIR selected
```

If either `test` fails, stop and report the inventory. Do not translate the
commands below into `pnpm --global`; first identify the one project that owns
the active binary.

Record exact rollback facts and make recoverable copies before changing
anything:

```sh
ROLLBACK_ROOT="$HOME/.local/state/umka-dev1-dsh-upgrade/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROLLBACK_ROOT"
chmod 700 "$ROLLBACK_ROOT"
cp "$DSH_INSTALL_DIR/package.json" "$ROLLBACK_ROOT/host-package.json"
cp "$DSH_INSTALL_DIR/pnpm-lock.yaml" "$ROLLBACK_ROOT/host-pnpm-lock.yaml"
for profile_name in dashi sessionbus; do
  if [ -d "$DSH_HOME/profiles/$profile_name" ]; then
    mv "$DSH_HOME/profiles/$profile_name" "$ROLLBACK_ROOT/$profile_name"
  fi
done
node --input-type=module - "$DSH_INSTALL_DIR" <<'NODE' >"$ROLLBACK_ROOT/versions.env"
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
const version = name => {
  const file = join(root, 'node_modules', ...name.split('/'), 'package.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : ''
}
for (const [key, name] of [
  ['PREVIOUS_DSH_VERSION', '@deepseek-ai/dsh'],
  ['PREVIOUS_DASHI_LAUNCHER_VERSION', '@antst/dashi-launcher'],
  ['PREVIOUS_SESSIONBUS_DSH_VERSION', '@sessionbus/dsh'],
]) console.log(`${key}=${JSON.stringify(version(name))}`)
NODE
printf '%s\n' 'ROLLBACK_ROOT created'
```

Expected output is `ROLLBACK_ROOT created` after one new private rollback directory is
created. The old `dashi` and
`sessionbus` profiles, when present, now live there; nothing has been deleted.
`versions.env` contains package versions only, never credentials.

## 2. Upgrade the host DSH graph in place

```sh
cd "$DSH_INSTALL_DIR"
pnpm add --save-exact @deepseek-ai/dsh@0.1.5-rc.2
./node_modules/.bin/dsh --version
```

Expected final line:

```text
0.1.5-rc.2
```

Define one checker for the host and rebuilt profile lock graphs:

```sh
check_dsh_graph() {
node --input-type=module - "$1" "$2" <<'NODE'
import { readFileSync } from 'node:fs'
const [lockPath, expectedCountText] = process.argv.slice(2)
const lockfile = readFileSync(lockPath, 'utf8')
const packageSection = lockfile.split('\nsnapshots:\n', 1)[0] ?? ''
const records = [...packageSection.matchAll(/^  '?(@deepseek-ai\/dsh[^@']*)@([^':]+)'?:$/gm)]
const versions = [...new Set(records.map(([, , version]) => version))].sort()
console.log(`DSH packages: ${records.length}`)
console.log(`DSH versions: ${versions.join(', ')}`)
if (records.length === 0 || versions.length !== 1 || versions[0] !== '0.1.5-rc.2') process.exit(1)
if (expectedCountText !== '-' && records.length !== Number(expectedCountText)) process.exit(1)
NODE
}
check_dsh_graph "$DSH_INSTALL_DIR/pnpm-lock.yaml" -
```

Expected host output is a nonzero, inventory-dependent package count and one
version; the clean host graph measured 231 packages, but the assertion does not
mistake that host count for the rebuilt dashi profile count:

```text
DSH packages: <nonzero host count; 231 in the clean measured graph>
DSH versions: 0.1.5-rc.2
```

If old DSH peer-only resolutions remain, repair only the DSH family through a
temporary pnpm read-package hook. Never delete `node_modules`, never delete the
whole lockfile, and never run a broad `pnpm dedupe` in this shared project:

```sh
cd "$DSH_INSTALL_DIR"
test ! -e .pnpmfile.cjs
cat >.pnpmfile.cjs <<'HOOK'
const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
module.exports = { hooks: { readPackage(pkg) {
  for (const field of fields) for (const name of Object.keys(pkg[field] ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      pkg[field][name] = '0.1.5-rc.2'
    }
  }
  return pkg
} } }
HOOK
pnpm install --lockfile-only --fix-lockfile
rm .pnpmfile.cjs
pnpm install --frozen-lockfile
```

Expected output is a successful lock-only resolution followed by a successful
frozen install. Re-run `check_dsh_graph "$DSH_INSTALL_DIR/pnpm-lock.yaml" -`;
its only accepted result is a nonzero host count at one `0.1.5-rc.2` version.
If `.pnpmfile.cjs` already exists or the
checker still fails, stop with the rollback copy intact.

## 3. Install dashi alpha.19 and rebuild its profile

The old profile was moved, not erased, during preflight.

```sh
cd "$DSH_INSTALL_DIR"
pnpm add --save-exact @antst/dashi-launcher@0.1.0-alpha.19
dsh plugin --profile dashi install
dsh plugin --profile dashi add @antst/dashi-app@0.1.0-alpha.19
hash -r
test -x "$DSH_INSTALL_DIR/node_modules/.bin/dashi"
pnpm --dir "$DSH_HOME/profiles/dashi" list --depth 0
check_dsh_graph "$DSH_HOME/profiles/dashi/pnpm-lock.yaml" 11
```

Expected output: the host add reports launcher `0.1.0-alpha.19`; the fresh
profile install/add exits 0; and `pnpm list --depth 0` shows the real direct
profile surface (transitive dashi, file-uploads-none, and roller are not
misreported as direct dependencies):

```text
Legend: production dependency, optional only, dev only

dsh-profile-dashi /home/pdev/.dsh/profiles/dashi (PRIVATE)
│
│   dependencies:
└── @antst/dashi-app@0.1.0-alpha.19

1 package
DSH packages: 11
DSH versions: 0.1.5-rc.2
```

The 11-package profile count was measured after the shipped-profile rebuild,
before adding any test-only replay provider. It is separate from the host graph.

## 4. Install sessionbus-dsh at the host and in both profiles

Install the package next to the active `dsh` so the daemon can resolve the
package-owned launcher:

```sh
cd "$DSH_INSTALL_DIR"
pnpm add --save-exact @sessionbus/dsh@0.1.0-pre.2
hash -r
test -x "$DSH_INSTALL_DIR/node_modules/.bin/sessionbus-dsh"
test "$(dirname "$(command -v sessionbus-dsh)")" = "$(dirname "$(command -v dsh)")"
printf 'shared bin directory=%s\n' "$(dirname "$(command -v dsh)")"
```

Expected output:

```text
shared bin directory=/home/pdev/node_modules/.bin
```

Build the base-only lane profile and augment the dashi peer profile. The lane
profile owns product `sessionbus-dsh`; the peer profile owns product `dashi`.

```sh
dsh plugin --profile sessionbus add @sessionbus/dsh@0.1.0-pre.2
dsh plugin --profile sessionbus exec sessionbus-dsh-install
dsh plugin --profile dashi add @sessionbus/dsh@0.1.0-pre.2
dsh plugin --profile dashi exec sessionbus-dsh-install --product dashi dashi
pnpm --dir "$DSH_HOME/profiles/sessionbus" list --depth 0 @sessionbus/dsh
pnpm --dir "$DSH_HOME/profiles/dashi" list --depth 0 @sessionbus/dsh
grep -F 'config: { mode: lane, product: sessionbus-dsh }' "$DSH_HOME/profiles/sessionbus/cordis.patch.yml"
grep -F 'config: { product: dashi }' "$DSH_HOME/profiles/dashi/cordis.patch.yml"
```

Expected output: both installers exit 0 and both final lists contain exactly
`@sessionbus/dsh 0.1.0-pre.2`. The sessionbus profile manifest has only that
direct plugin dependency and the `dsh-base` bundle; its patch contains
`config: { mode: lane, product: sessionbus-dsh }`. The dashi patch contains
`config: { product: dashi }`. The two `grep` commands print those exact rows.
Neither patch contains a group list: peer groups come only from
`SESSIONBUS_GROUPS`, and lane membership comes from the daemon.

Advertise the new product without displaying or rewriting any other service
environment value:

```sh
SESSIONBUS_SERVICE_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/sessionbus/service.env"
cp "$SESSIONBUS_SERVICE_ENV" "$ROLLBACK_ROOT/sessionbus-service.env"
node --input-type=module - "$SESSIONBUS_SERVICE_ENV" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const file = process.argv[2]
const source = readFileSync(file, 'utf8')
const pattern = /^SESSIONBUS_PRODUCTS=([^\r\n]*)$/m
const match = pattern.exec(source)
if (!match) throw new Error('SESSIONBUS_PRODUCTS is missing')
const products = match[1].split(',').map(value => value.trim()).filter(Boolean)
if (!products.includes('sessionbus-dsh')) products.push('sessionbus-dsh')
writeFileSync(file, source.replace(pattern, `SESSIONBUS_PRODUCTS=${products.join(',')}`))
NODE
systemctl --user restart sessionbus.service
systemctl --user is-active sessionbus.service
sessionbus roster --local --json | node --input-type=module -e '
  let body = ""; for await (const chunk of process.stdin) body += chunk
  const products = JSON.parse(body).local.products
  console.log(`sessionbus-dsh advertised: ${products.includes("sessionbus-dsh")}`)
  if (!products.includes("sessionbus-dsh")) process.exit(1)
'
```

Expected output ends with:

```text
active
sessionbus-dsh advertised: true
```

## 5. Verification on the real daemon

### Lane: package-owned launcher selects `dsh --profile sessionbus`

From the existing `dev1@pdev` Sessionbus peer, make these exact native tool
calls. Generated IDs replace the capitalized result tokens only after each
successful call:

```json
{"action":"describe","arguments":{"product":"sessionbus-dsh","host":"umka-dev1"}}
{"action":"spawn","arguments":{"product":"sessionbus-dsh","host":"umka-dev1","name":"umka-dev1-lane-check","open":{"cwd":"/home/pdev"},"extra_groups":["peer-dev"],"persistent":false,"auto_close_ms":0,"idle_message":"stage"}}
{"action":"run","arguments":{"session_id":"RETURNED_SESSION_ID","input":"Reply with exactly: lane hello"}}
{"action":"ack","arguments":{"session_id":"RETURNED_SESSION_ID","run_id":"RETURNED_RUN_ID"}}
{"action":"close","arguments":{"session_id":"RETURNED_SESSION_ID"}}
```

Expected results:

- `describe` succeeds and lists the DSH open fields.
- `spawn` returns a new session ID whose host suffix is `@umka-dev1`.
- `run` returns `state: done` and a result containing exactly `lane hello`.
  While that lane is open, `sessionbus roster --all --json` identifies it as a
  `sessionbus-dsh` lane; the package-owned bin has selected
  `dsh --profile sessionbus` without the daemon naming a DSH profile.
- `ack` succeeds only after the done result was read; `close` then succeeds.

### Peer: groups come only from `SESSIONBUS_GROUPS`

In a second terminal on `umka-dev1`, start the installed dashi peer. The fixed
test group is non-secret and no token is set:

```sh
env -u SESSIONBUS_LAUNCH_TOKEN SESSIONBUS_GROUPS='["peer-dev"]' dsh --profile dashi
```

Expected terminal result: dashi opens normally, the sessionbus plugin reports
no configuration error, and the resulting peer advertises product `dashi` and
group `peer-dev`. No profile row supplies that group.

From `dev1@pdev`, call:

```json
{"action":"list","arguments":{}}
{"action":"send","arguments":{"target":"RETURNED_DASHI_SESSION_ID","message":"Reply through sessionbus with exactly: peer hello"}}
```

Expected results: `list` discovers the new `dashi` peer with `peer-dev` among
its groups; `send` returns a successful delivery receipt; and `dev1@pdev`
receives `peer hello` from that authenticated dashi session on the real bus.
Exit the dashi peer normally after the reply.

Finally verify the launcher without starting an interactive session:

```sh
HELP_FILE=$(mktemp)
dashi --help >"$HELP_FILE"
HELP_STATUS=$?
sed -n '1p' "$HELP_FILE"
printf 'dashi help exit=%s\n' "$HELP_STATUS"
rm "$HELP_FILE"
```

Expected output:

```text
dashi 0.1.0-alpha.19 on DSH 0.1.5-rc.2
dashi help exit=0
```

## 6. Rollback

Use the rollback directory printed in preflight and source only its generated
version file:

```sh
test -n "${ROLLBACK_ROOT:-}"
. "$ROLLBACK_ROOT/versions.env"
```

Remove sessionbus from the profiles without requiring either profile to boot,
then remove the host-level package:

```sh
if [ -x "$DSH_HOME/profiles/dashi/node_modules/.bin/sessionbus-dsh-install" ]; then
  pnpm --dir "$DSH_HOME/profiles/dashi" exec sessionbus-dsh-install --remove dashi
fi
if [ -x "$DSH_HOME/profiles/sessionbus/node_modules/.bin/sessionbus-dsh-install" ]; then
  pnpm --dir "$DSH_HOME/profiles/sessionbus" exec sessionbus-dsh-install --remove sessionbus
fi
cd "$DSH_INSTALL_DIR"
pnpm remove @sessionbus/dsh
```

Expected output: each present profile reports removal of `@sessionbus/dsh` and
its managed rows; the host remove exits 0. Absence is explicitly skipped.

Restore the daemon advertisement exactly from its pre-change copy and restart:

```sh
cp "$ROLLBACK_ROOT/sessionbus-service.env" "$SESSIONBUS_SERVICE_ENV"
systemctl --user restart sessionbus.service
systemctl --user is-active sessionbus.service
```

Expected final line: `active`. The command does not print the service file.

Restore the prior exact host versions recorded before the upgrade:

```sh
cd "$DSH_INSTALL_DIR"
test -n "$PREVIOUS_DSH_VERSION"
pnpm add --save-exact "@deepseek-ai/dsh@$PREVIOUS_DSH_VERSION"
if [ -n "$PREVIOUS_DASHI_LAUNCHER_VERSION" ]; then
  pnpm add --save-exact "@antst/dashi-launcher@$PREVIOUS_DASHI_LAUNCHER_VERSION"
else
  pnpm remove @antst/dashi-launcher
fi
if [ -n "$PREVIOUS_SESSIONBUS_DSH_VERSION" ]; then
  pnpm add --save-exact "@sessionbus/dsh@$PREVIOUS_SESSIONBUS_DSH_VERSION"
fi
```

Expected output: pnpm installs the exact versions captured in `versions.env`;
there are no unversioned adds and `node_modules` is never deleted.

Restore the two profile directories by moving the failed/new copies aside and
moving the preflight copies back:

```sh
ROLLBACK_FAILED="$ROLLBACK_ROOT/failed-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROLLBACK_FAILED"
for profile_name in dashi sessionbus; do
  if [ -d "$DSH_HOME/profiles/$profile_name" ]; then
    mv "$DSH_HOME/profiles/$profile_name" "$ROLLBACK_FAILED/$profile_name"
  fi
  if [ -d "$ROLLBACK_ROOT/$profile_name" ]; then
    mv "$ROLLBACK_ROOT/$profile_name" "$DSH_HOME/profiles/$profile_name"
  fi
done
```

Expected output: none. Previously existing profiles are restored byte-for-byte;
the new profiles remain recoverable under `failed-*`. Finish by repeating the
preflight inventory and `dsh --version`; they must match the recorded preflight.

