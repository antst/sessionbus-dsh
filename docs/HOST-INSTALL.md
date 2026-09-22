# Installing a DSH lane host

This runbook installs a DSH lane host, with `umka-dev1` as the worked
example. Run it as the ordinary account returned by `id -un`, never with
`sudo`, and refer to its home as `$HOME` in commands. On `umka-dev1` that
account is `antst` and its home is `/home/antst`; earlier references to `pdev`
were wrong. The target set is DSH `0.1.5-rc.2`, `@antst/dashi-launcher`
`0.1.2`, `@antst/dashi-app` `0.1.2`, `@sessionbus/dsh`
`0.1.0-pre.14`, `@sessionbus/kit` `0.5.7`, and the Sessionbus daemon
`v0.5.7` at revision `53c5f80e281f39e54bcee1fbe8a253da86ad1c08`.
Earlier Sessionbus-dsh prereleases are superseded; pre.3 and pre.5 were never
published. Do not continue past a failed assertion.

This runbook is the real-daemon acceptance procedure for DSH `0.1.5-rc.2`.
The equivalent acceptance on `0.1.6-alpha.2` is still outstanding.

None of the commands below prints `SESSIONBUS_LAUNCH_TOKEN`,
`SESSIONBUS_GROUPS`, the local key, or the federation secret. The only
environment assignments intentionally displayed are the daemon's filtered
`PATH=` and `SESSIONBUS_PRODUCTS=` lines.

### Release history, not install targets

Dashi alpha.18 lacked the `sessionbus` profile row and launcher token path.
Alpha.19 was partially published, alpha.20 carried empty application
tarballs, and alpha.21 repaired the release pipeline. Dashi 0.1.0 was the
first stable cut. They are historical releases, not install targets for this
runbook.

Run these exact probes immediately before starting:

```sh
npm view @antst/dashi@0.1.2 version && npm view @antst/dashi-app@0.1.2 version
npm view @antst/dashi-launcher@0.1.2 version && npm view @antst/dsh-file-uploads-none@0.1.2 version
npm view @sessionbus/dsh@0.1.0-pre.14 version && npm view @sessionbus/kit@0.5.7 version
```

Expected output, in order:

```text
0.1.2
0.1.2
0.1.2
0.1.2
0.1.0-pre.14
0.5.7
```

An `E404` means stop; it is not permission to substitute a preview URL or a
different version. A freshly published version can resolve before all four
dashi tarballs propagate. HEAD every tarball until each returns HTTP 200
before the first profile add:

```sh
for package in \
  @antst/dashi@0.1.2 \
  @antst/dashi-app@0.1.2 \
  @antst/dashi-launcher@0.1.2 \
  @antst/dsh-file-uploads-none@0.1.2; do
  tarball=$(npm view "$package" dist.tarball)
  ready=
  for attempt in $(seq 1 60); do
    status=$(curl --head --location --silent --show-error --output /dev/null --write-out '%{http_code}' "$tarball" || true)
    if [ "$status" = 200 ]; then ready=1; break; fi
    sleep 5
  done
  test "$ready" = 1
  printf '%s tarball HTTP 200\n' "$package"
done
```

Expected output is four `tarball HTTP 200` lines. Any other final status stops
the run before package metadata or the physical graph can be changed.

## 1. Preflight inventory

Use one shell for the whole procedure so the paths and rollback record remain
authoritative. The PATH export is local to this task shell; do not edit a shell
startup file. Every direct DSH or dashi invocation below still uses its
absolute, derived path. The PATH export is also required because the installer
and the `sessionbus-dsh` launcher resolve their child `dsh` by name.

```sh
set -eu
HOST_USER=$(id -un)
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HOST_BIN_DIR="$HOME/node_modules/.bin"
LOGIN_DSH=$(command -v dsh || true)
printf 'host user=%s\nhost home=%s\n' "$HOST_USER" "$HOME"
printf 'login-path dsh=%s\n' "${LOGIN_DSH:-<not found>}"
export PATH="$HOST_BIN_DIR:$PATH"
DSH_BIN="$HOST_BIN_DIR/dsh"
DASHI_BIN="$HOST_BIN_DIR/dashi"
test -x "$DSH_BIN"
printf 'pnpm='; pnpm --version
printf 'node='; node --version
printf 'npm='; npm --version
printf 'explicit dsh=%s\n' "$DSH_BIN"
```

Expected output on `umka-dev1` includes:

```text
host user=antst
host home=/home/antst
login-path dsh=/home/antst/node_modules/.bin/dsh
pnpm=10.28.1
node=v25.3.0
npm=11.6.2
explicit dsh=/home/antst/node_modules/.bin/dsh
```

The `login-path dsh` line is observational for the already-prepared task
shell; the install-location assertions below, not that line, establish the one
authoritative DSH install.

Inventory the one host install and every profile before changing them:

```sh
printf '%s\n' 'home direct packages:'
pnpm --dir "$HOME" list --depth 0 @deepseek-ai/dsh @antst/dashi-launcher @sessionbus/dsh || true
printf '%s\n' 'profiles:'
find "$DSH_HOME/profiles" -mindepth 1 -maxdepth 1 -type d ! -name node_modules -printf '%f\n' 2>/dev/null | LC_ALL=C sort || true
for profile_dir in "$DSH_HOME"/profiles/*; do
  [ -d "$profile_dir" ] || continue
  [ "${profile_dir##*/}" = node_modules ] && continue
  printf '\nprofile %s direct packages:\n' "${profile_dir##*/}"
  pnpm --dir "$profile_dir" list --depth 0 @deepseek-ai/dsh @antst/dashi-app @sessionbus/dsh || true
done
"$DSH_BIN" --version
```

Expected `umka-dev1` facts are one home-level DSH `0.1.2-rc.1`, no
host-level dashi launcher or `@sessionbus/dsh`, and the six profiles `acp`,
agent&#45;sessions, `as-native-probe`, `dashi`, `headless`, and `sessionbus`.
The command's final line is `0.1.2-rc.1`.

The existing dashi profile is at alpha.17 and the existing sessionbus lane
profile is at pre.1. They are upgraded in place; they are not deleted or
recreated. The `web` profile used later is intentionally absent.

Resolve the install project without relying on the login PATH. This assertion
stops on a global or profile-local DSH copy and also stops when a second install
location exists:

```sh
mapfile -t DSH_INSTALL_LOCATIONS < <({
  if [ -f "$HOME/node_modules/@deepseek-ai/dsh/package.json" ]; then
    printf '%s\n' "$HOME"
  fi
  global_modules=$(pnpm root -g)
  if [ -f "$global_modules/@deepseek-ai/dsh/package.json" ]; then
    dirname "$global_modules"
  fi
  for profile_dir in "$DSH_HOME"/profiles/*; do
    [ "${profile_dir##*/}" = node_modules ] && continue
    if [ -f "$profile_dir/node_modules/@deepseek-ai/dsh/package.json" ]; then
      printf '%s\n' "$profile_dir"
    fi
  done
} | LC_ALL=C sort -u)
printf '%s\n' 'DSH install locations:' "${DSH_INSTALL_LOCATIONS[@]}"
test "${#DSH_INSTALL_LOCATIONS[@]}" -eq 1
test "${DSH_INSTALL_LOCATIONS[0]}" = "$HOME"
test "$(readlink -f "$DSH_BIN")" = "$(readlink -f "$HOME/node_modules/.bin/dsh")"
DSH_INSTALL_DIR=$HOME
test -d "$DSH_HOME/profiles/dashi"
test -d "$DSH_HOME/profiles/sessionbus"
test ! -e "$DSH_HOME/profiles/web"
printf '%s\n' 'DSH_INSTALL_DIR selected'
```

Expected output:

```text
DSH install locations:
/home/antst
DSH_INSTALL_DIR selected
```

If an assertion fails, stop and report the inventory. Do not translate the
commands below into `pnpm --global`.

Inventory the running daemon without restarting it. The lane proof uses the
inventory-confirmed `$HOME/e2e-work`, not the user service process's cwd (which
may be `/`). Read effective PATH only from the running process, and redact the
unit's possible PATH authorities rather than printing their contents:

```sh
SESSIONBUS_UNIT=sessionbus.service
SESSIONBUS_PID=$(systemctl --user show "$SESSIONBUS_UNIT" -p MainPID --value)
test "$SESSIONBUS_PID" -gt 0
LANE_CWD="$HOME/e2e-work"
test -d "$LANE_CWD"
SERVICE_PATH_LINE=$(tr '\0' '\n' < "/proc/$SESSIONBUS_PID/environ" | grep '^PATH=')
test "$(printf '%s\n' "$SERVICE_PATH_LINE" | wc -l)" -eq 1
SERVICE_PATH=${SERVICE_PATH_LINE#PATH=}
SERVICE_UNIT_PATH=$(systemctl --user show "$SESSIONBUS_UNIT" -p FragmentPath --value)
SESSIONBUS_SERVICE_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/sessionbus/service.env"
SERVICE_DROPIN="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sessionbus.service.d/override.conf"
printf 'lane cwd=%s\n%s\nunit=%s\n' "$LANE_CWD" "$SERVICE_PATH_LINE" "$SERVICE_UNIT_PATH"
PATH="$SERVICE_PATH" command -v sessionbus
SESSIONBUS_DAEMON_VERSION=$(PATH="$SERVICE_PATH" sessionbus --version)
printf 'daemon version=%s\n' "$SESSIONBUS_DAEMON_VERSION"
test "$SESSIONBUS_DAEMON_VERSION" = 'sessionbus v0.5.7 (53c5f80e281f39e54bcee1fbe8a253da86ad1c08)'
if PATH="$SERVICE_PATH" command -v sessionbus-dsh dsh >/dev/null 2>&1; then
  printf '%s\n' 'service PATH already resolves sessionbus-dsh and dsh'
else
  printf '%s\n' 'service PATH does not resolve sessionbus-dsh and dsh'
fi
systemctl --user cat "$SESSIONBUS_UNIT" | grep -E '^[[:space:]]*(EnvironmentFile|Environment)=' | sed -E 's/^([[:space:]]*(EnvironmentFile|Environment))=.*/\1=<redacted>/'
grep '^SESSIONBUS_PRODUCTS=' "$SESSIONBUS_SERVICE_ENV"
systemctl --user is-active "$SESSIONBUS_UNIT"
```

Expected `umka-dev1` output identifies `/home/antst/.config/systemd/user/sessionbus.service`,
no drop-ins, the effective PATH below, only `sessionbus` resolving under it,
one products assignment containing `dashi` but not `sessionbus-dsh`, and an
active service:

```text
lane cwd=/home/antst/e2e-work
PATH=/home/antst/.local/bin:/usr/local/bin:/usr/bin:/bin
/home/antst/.local/bin/sessionbus
daemon version=sessionbus v0.5.7 (53c5f80e281f39e54bcee1fbe8a253da86ad1c08)
service PATH does not resolve sessionbus-dsh and dsh
Environment=<redacted>
EnvironmentFile=<redacted>
SESSIONBUS_PRODUCTS=<existing value containing dashi>
active
```

On this host the unit's `Environment=` owns PATH and its
`EnvironmentFile=-/home/antst/.config/sessionbus/service.env` does not set
PATH. On another host, stop here if an EnvironmentFile sets PATH: edit that
file's PATH assignment instead, because it can override a drop-in. The
umka-dev1 branch below adds a drop-in because its EnvironmentFile does not set
PATH.

Record exact rollback facts and make recoverable copies before the first
mutation. The service environment copy is private, and the existing dashi and
sessionbus profile manifests, lockfiles, and patch files are all preserved:

```sh
ROLLBACK_ROOT="$HOME/.local/state/umka-dev1-dsh-upgrade/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROLLBACK_ROOT/host" "$ROLLBACK_ROOT/profiles/dashi" "$ROLLBACK_ROOT/profiles/sessionbus" "$ROLLBACK_ROOT/service"
chmod 700 "$ROLLBACK_ROOT"
cp --preserve=mode "$DSH_INSTALL_DIR/package.json" "$ROLLBACK_ROOT/host/package.json"
cp --preserve=mode "$DSH_INSTALL_DIR/pnpm-lock.yaml" "$ROLLBACK_ROOT/host/pnpm-lock.yaml"
for profile_name in dashi sessionbus; do
  for file in package.json pnpm-lock.yaml cordis.patch.yml; do
    if [ -f "$DSH_HOME/profiles/$profile_name/$file" ]; then
      cp --preserve=mode "$DSH_HOME/profiles/$profile_name/$file" "$ROLLBACK_ROOT/profiles/$profile_name/$file"
    fi
  done
done
cp --preserve=mode "$SESSIONBUS_SERVICE_ENV" "$ROLLBACK_ROOT/service/service.env"
chmod 600 "$ROLLBACK_ROOT/service/service.env"
stat -c '%a' "$SESSIONBUS_SERVICE_ENV" >"$ROLLBACK_ROOT/service/service-env-mode"
stat -c '%u:%g' "$SESSIONBUS_SERVICE_ENV" >"$ROLLBACK_ROOT/service/service-env-owner"
cp --preserve=mode "$SERVICE_UNIT_PATH" "$ROLLBACK_ROOT/service/sessionbus.service"
if [ -f "$SERVICE_DROPIN" ]; then
  cp --preserve=mode "$SERVICE_DROPIN" "$ROLLBACK_ROOT/service/override.conf"
  : >"$ROLLBACK_ROOT/service/dropin-existed"
fi
printf '%s\n' "$SERVICE_PATH" >"$ROLLBACK_ROOT/service/effective-path"
node --input-type=module - "$DSH_INSTALL_DIR" "$DSH_HOME" <<'NODE' >"$ROLLBACK_ROOT/versions.env"
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const [root, home] = process.argv.slice(2)
const version = (base, name) => {
  const file = join(base, 'node_modules', ...name.split('/'), 'package.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : ''
}
for (const [key, value] of [
  ['PREVIOUS_DSH_VERSION', version(root, '@deepseek-ai/dsh')],
  ['PREVIOUS_DASHI_LAUNCHER_VERSION', version(root, '@antst/dashi-launcher')],
  ['PREVIOUS_HOST_SESSIONBUS_DSH_VERSION', version(root, '@sessionbus/dsh')],
  ['PREVIOUS_DASHI_APP_VERSION', version(join(home, 'profiles/dashi'), '@antst/dashi-app')],
  ['PREVIOUS_DASHI_SESSIONBUS_DSH_VERSION', version(join(home, 'profiles/dashi'), '@sessionbus/dsh')],
  ['PREVIOUS_LANE_SESSIONBUS_DSH_VERSION', version(join(home, 'profiles/sessionbus'), '@sessionbus/dsh')],
]) console.log(`${key}=${JSON.stringify(value)}`)
NODE
printf '%s\n' 'ROLLBACK_ROOT created'
```

Expected output is `ROLLBACK_ROOT created`. The directory contains only
package metadata, lock graphs, profile patches, the filtered PATH value, the
unit, and the private service-environment backup. No credential is printed.

## 2. Upgrade the host DSH graph in place

Upgrade the existing home project and verify the explicit binary:

```sh
cd "$DSH_INSTALL_DIR"
pnpm add --save-exact @deepseek-ai/dsh@0.1.5-rc.2
"$DSH_BIN" --version
```

Expected final line:

```text
0.1.5-rc.2
```

Define one bounded repair for the host and every profile graph. It inspects the
lock records, promotes every stale DSH peer provider to an exact direct
dependency in one command, installs that frozen graph, launches the real DSH
once to heal its shared module fallback, and checks the authoritative paths.
A profile graph with no DSH records is coherent. It never deletes
`node_modules`, edits or deletes a lockfile, prunes a fallback extra, or runs a
broad dedupe. The embedded closure checker reads only `HOME` and `DSH_HOME`
from the environment and prints only inventory/result lines:

```sh
cat >"$ROLLBACK_ROOT/check-profile-closure.mjs" <<'NODE'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const profile = process.argv[2]
if (profile === undefined) throw new Error('usage: check-profile-closure.mjs PROFILE [INSTALL_DIR]')
const home = process.env.HOME
if (home === undefined) throw new Error('HOME is required')
const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
const installDir = process.argv[3] ?? home
const installAnchor = realpathSync(join(installDir, 'node_modules/@deepseek-ai/dsh/package.json'))
const modulesDir = join(dshHome, 'profiles/node_modules')

function manifest(anchor) {
  return JSON.parse(readFileSync(anchor, 'utf8'))
}

function packageDirFromAnchor(anchor, name) {
  for (const searchPath of createRequire(anchor).resolve.paths(name) ?? []) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
}

const root = manifest(installAnchor)
const expected = new Map([[root.name, dirname(installAnchor)]])
const queue = [{ anchor: installAnchor, manifest: root }]
for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
  const names = [
    ...Object.keys(next.manifest.dependencies ?? {}),
    ...Object.keys(next.manifest.peerDependencies ?? {}),
  ]
  for (const name of names) {
    if (expected.has(name)) continue
    const dir = packageDirFromAnchor(next.anchor, name)
    if (dir === undefined) continue
    expected.set(name, dir)
    const anchor = join(dir, 'package.json')
    queue.push({ anchor, manifest: manifest(anchor) })
  }
}

function installedNames(dir) {
  const names = []
  for (const entry of readdirSync(dir).filter(name => !name.startsWith('.'))) {
    if (!entry.startsWith('@')) names.push(entry)
    else for (const child of readdirSync(join(dir, entry))) names.push(`${entry}/${child}`)
  }
  return names.sort()
}

const missing = []
const wrong = []
for (const [name, target] of expected) {
  const link = join(modulesDir, name)
  if (!existsSync(link)) {
    missing.push(name)
    continue
  }
  const stat = lstatSync(link)
  const actualTarget = stat.isSymbolicLink() ? readlinkSync(link) : '(not a symlink)'
  const expectedVersion = manifest(join(target, 'package.json')).version
  let actualVersion = '(unreadable)'
  try { actualVersion = manifest(join(link, 'package.json')).version }
  catch {}
  if (!stat.isSymbolicLink() || actualTarget !== target || actualVersion !== expectedVersion) {
    wrong.push(`${name}: expected ${target} (${expectedVersion}); actual ${actualTarget} (${actualVersion})`)
  }
}

const extras = []
for (const name of installedNames(modulesDir)) {
  if (expected.has(name)) continue
  const path = join(modulesDir, name)
  let target = '(not a symlink)'
  let version = '(unreadable)'
  try { if (lstatSync(path).isSymbolicLink()) target = readlinkSync(path) } catch {}
  try { version = manifest(join(path, 'package.json')).version } catch {}
  extras.push(`${name}: ${target} (${version})`)
}

console.log(`profile=${profile}`)
console.log(`install_anchor=${installAnchor}`)
console.log(`expected=${expected.size}`)
console.log(`current=${expected.size - missing.length - wrong.length}`)
console.log(`missing=${missing.length}`)
for (const line of missing) console.log(`missing_entry=${line}`)
console.log(`wrong=${wrong.length}`)
for (const line of wrong) console.log(`wrong_entry=${line}`)
console.log(`extras=${extras.length}`)
for (const line of extras) console.log(`extra_entry=${line}`)
process.exitCode = missing.length === 0 && wrong.length === 0 ? 0 : 1
NODE

check_dsh_graph() {
  graph_root=$1
  target_version=$2
  physical_mode=${3:-optional}
  profile=${4:-headless}
  node --input-type=module - "$graph_root" "$target_version" "$physical_mode" <<'NODE'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
const [root, target, physicalMode] = process.argv.slice(2)
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').split('\nsnapshots:\n', 1)[0] ?? ''
const records = [...lock.matchAll(/^  '?(@deepseek-ai\/dsh[^@']*)@([^':]+)'?:$/gm)].map(([, name, version]) => ({ name, version }))
const counts = new Map()
for (const { version } of records) counts.set(version, (counts.get(version) ?? 0) + 1)
console.log(`DSH packages: ${records.length}`)
console.log(`DSH versions: ${[...counts.keys()].sort().join(', ')}`)
for (const [version, count] of [...counts].sort()) console.log(`DSH ${version}: ${count}`)
const stale = records.filter(record => record.version !== target)
if (stale.length) {
  for (const value of [...new Set(stale.map(record => `${record.name}@${record.version}`))].sort()) console.error(value)
  process.exitCode = 1
}

const scope = join(root, 'node_modules/@deepseek-ai')
const physical = []
if (existsSync(scope)) for (const entry of readdirSync(scope).sort()) {
  if (entry !== 'dsh' && !entry.startsWith('dsh-')) continue
  const path = join(scope, entry)
  try {
    const version = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version
    const targetPath = realpathSync.native(path)
    physical.push({ name: `@deepseek-ai/${entry}`, version, targetPath })
    console.log(`DSH physical @deepseek-ai/${entry}@${version} -> ${targetPath}`)
  } catch (error) {
    console.error(`DSH physical @deepseek-ai/${entry}: ${error.message}`)
    if (physicalMode !== 'report') process.exitCode = 1
  }
}
const physicalVersions = [...new Set(physical.map(record => record.version))].sort()
const physicalCounts = new Map()
for (const { version } of physical) physicalCounts.set(version, (physicalCounts.get(version) ?? 0) + 1)
console.log(`DSH physical projection: ${physicalMode === 'report' ? 'REPORTED' : 'ASSERTED'}`)
console.log(`DSH physical packages: ${physical.length}`)
console.log(`DSH physical versions: ${physicalVersions.join(', ')}`)
for (const [version, count] of [...physicalCounts].sort()) console.log(`DSH physical ${version}: ${count}`)
if (physicalMode === 'required' && physical.length === 0) {
  console.error(`DSH physical projection is empty: ${root}`)
  process.exitCode = 1
}
if (physicalMode !== 'report' && physical.some(record => record.version !== target)) {
  console.error(`DSH physical projection is not uniformly ${target}: ${root}`)
  process.exitCode = 1
}
NODE
  node "$ROLLBACK_ROOT/check-profile-closure.mjs" "$profile" "$DSH_INSTALL_DIR"
  printf 'DSH graph coherent: %s\n' "$graph_root"
}

repair_dsh_graph() {
  graph_root=$1
  target_version=$2
  physical_mode=${3:-optional}
  profile=${4:-headless}
  stale_file=$(mktemp)
  if node --input-type=module - "$graph_root/pnpm-lock.yaml" "$target_version" "$stale_file" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const [file, target, staleFile] = process.argv.slice(2)
const packages = readFileSync(file, 'utf8').split('\nsnapshots:\n', 1)[0] ?? ''
const records = [...packages.matchAll(/^  '?(@deepseek-ai\/dsh[^@']*)@([^':]+)'?:$/gm)].map(([, name, version]) => ({ name, version }))
const stale = [...new Set(records.filter(record => record.version !== target).map(record => record.name))].sort()
writeFileSync(staleFile, stale.length ? `${stale.join('\n')}\n` : '')
NODE
  then
    :
  else
    repair_status=$?
    rm -f "$stale_file"
    return "$repair_status"
  fi
  mapfile -t stale_packages <"$stale_file"
  rm "$stale_file"
  if [ "${#stale_packages[@]}" -gt 0 ]; then
    pins=()
    for package in "${stale_packages[@]}"; do pins+=("$package@$target_version"); done
    pnpm --dir "$graph_root" add --save-exact "${pins[@]}"
    pnpm --dir "$graph_root" install --frozen-lockfile
  fi
  if [ "$physical_mode" = report ]; then
    node --input-type=module - "$DSH_BIN" "$target_version" <<'NODE'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const [bin, target] = process.argv.slice(2)
const binDir = dirname(realpathSync.native(bin))
const anchor = createRequire(join(binDir, 'dsh-anchor.cjs')).resolve('@deepseek-ai/dsh/package.json')
const version = JSON.parse(readFileSync(anchor, 'utf8')).version
console.log(`DSH executing install anchor: ${anchor}`)
console.log(`DSH executing version: ${version}`)
if (version !== target) process.exitCode = 1
NODE
  fi
  "$DSH_BIN" --profile headless --help >/dev/null
  printf '%s\n' 'headless fallback heal exit=0'
  check_dsh_graph "$graph_root" "$target_version" "$physical_mode" "$profile"
}

profile_lock_has_package() {
  lock_file=$1
  package_id=$2
  node --input-type=module - "$lock_file" "$package_id" <<'NODE'
import { readFileSync } from 'node:fs'
const [file, packageId] = process.argv.slice(2)
const packages = readFileSync(file, 'utf8').split('\nsnapshots:\n', 1)[0] ?? ''
const escaped = packageId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
if (!new RegExp(`^  '?${escaped}'?:$`, 'mu').test(packages)) process.exit(1)
NODE
}

read_nested_package_identity() {
  node --input-type=module - "$1" <<'NODE'
import { readFileSync } from 'node:fs'
const file = process.argv[2]
const parts = file.split('/node_modules/').at(-1).split('/')
const isPackageRoot = parts.length === 2 || (parts.length === 3 && parts[0].startsWith('@'))
if (!isPackageRoot || parts.at(-1) !== 'package.json') process.exit(0)
const { name, version } = JSON.parse(readFileSync(file, 'utf8'))
if (typeof name === 'string' && typeof version === 'string') process.stdout.write(`${name}@${version}`)
NODE
}

remove_untracked_nested_packages() {
  profile_root=$1
  lock_file="$profile_root/pnpm-lock.yaml"
  removed=0
  while IFS= read -r -d '' package_json; do
    package_dir=${package_json%/package.json}
    case "$package_json" in
      "$profile_root"/node_modules/*/node_modules/*/package.json) ;;
      *) printf 'nested package escaped profile: %s\n' "$package_json" >&2; exit 1 ;;
    esac
    package_id=$(read_nested_package_identity "$package_json")
    test -n "$package_id" || continue
    if profile_lock_has_package "$lock_file" "$package_id"; then continue; fi

    # Guard 1: the physical package identity has not changed since discovery.
    test ! -L "$package_dir"
    test "$package_id" = "$(read_nested_package_identity "$package_json")"
    # Guard 2: the exact package record is still absent from the frozen lock.
    if profile_lock_has_package "$lock_file" "$package_id"; then
      printf 'nested package became lock-tracked: %s\n' "$package_id" >&2
      exit 1
    fi
    printf 'removing untracked nested package: %s (%s)\n' "$package_dir" "$package_id"
    rm -r -- "$package_dir"
    removed=$((removed + 1))
  done < <(find "$profile_root/node_modules" -mindepth 3 -path '*/node_modules/*/node_modules/*' -name package.json -print0)

  install_output=$(pnpm --dir "$profile_root" install --frozen-lockfile 2>&1)
  printf '%s\n' "$install_output"
  printf '%s\n' "$install_output" | grep -Fqx 'Lockfile is up to date, resolution step is skipped'
  printf '%s\n' "$install_output" | grep -Fqx 'Already up to date'
  printf 'untracked nested packages removed: %s\n' "$removed"
}
repair_dsh_graph "$DSH_INSTALL_DIR" 0.1.5-rc.2 report headless
if ! sed '/^snapshots:/,$d' "$DSH_INSTALL_DIR/pnpm-lock.yaml" | grep -Eq "^  '?@deepseek-ai/dsh[^@']*@"; then
  printf '%s\n' 'host DSH graph has no package records' >&2
  exit 1
fi
printf '%s\n' 'host DSH graph nonzero'
```

The stopped umka host first reports `233` records: `25` at `0.1.2-rc.1` and
`208` at `0.1.5-rc.2`. After the one exact-pin command and frozen install, the
expected final output is:

```text
DSH executing install anchor: <package directory resolved beside the real dsh bin>/package.json
DSH executing version: 0.1.5-rc.2
headless fallback heal exit=0
DSH packages: 231
DSH versions: 0.1.5-rc.2
DSH 0.1.5-rc.2: 231
DSH physical @deepseek-ai/dsh@<reported version> -> <resolved package directory>
<one physical line per top-level DSH package>
DSH physical projection: REPORTED
DSH physical packages: <inventory count>
DSH physical versions: <one or more reported versions>
DSH physical <version>: <count>
profile=headless
expected=<closure count>
current=<same closure count>
missing=0
wrong=0
extras=<inventory count>
extra_entry=<name>: <link target> (<version>)
DSH graph coherent: /home/antst
host DSH graph nonzero
```

pnpm 10.28.1 retains already auto-installed peer providers in the lock even
when their published ranges reject those versions; scoped updates, dedupe, and
lock pruning do not repair that in-place state. The exact pins are permanent
manifest dependencies, equivalent to dashi's catalog owning one DSH version.
Every later host or profile package add calls the same function. For the host,
the mandatory assertions are a lock uniform at the target, the executing
install anchor at the target, a successful headless boot, and an exact shared
fallback closure. Any leftover lock version, wrong executing anchor, failed
boot, or wrong or broken expected fallback link is listed and stops the run
with the rollback copy intact. Profile checks additionally require their
nonempty physical projections to be uniform; the dashi profile must have a
nonempty projection. Unexpected fallback extras are listed but never deleted.

DSH computes the expected fallback as a first-resolution-wins breadth-first
walk over dependencies and peers from the executing `dsh` package
(`packages/boot/app-boot/src/profile.ts:469-504`). The CLI's `INSTALL_ANCHOR`
is that executing package (`apps/cli/src/profile-boot.ts:78,187-191,226-243`),
not the top-level `~/node_modules` projection. Every profile launch checks the
shared fallback; wrong and broken expected links are replaced
(`profile.ts:201-239,507-528,552-577`). That is why each repair performs one
real `dsh --profile headless --help` launch and checks the fallback afterwards.

On a hoisted install, pnpm can leave old unpacked packages in the top-level
projection even after the lock is uniform. That projection is a reported
inventory, not a host assertion: DSH does not resolve through those old copies
after the shared fallback heals (D-043), though they remain a hazard for other
code anchored at the host project. Optional cleanup must first be validated
against an isolated copy of that exact layout before applying the proven pnpm
10.28.1 reconciliation:

```sh
npx -y pnpm@10.28.1 --dir "$DSH_INSTALL_DIR" install --frozen-lockfile --force
repair_dsh_graph "$DSH_INSTALL_DIR" 0.1.5-rc.2 report headless
```

Expected output from the isolated hoisted reproduction was a transition from
`214` rc.1 physical DSH packages to `231` rc.2 packages, an unchanged lockfile
hash, and byte-identical unrelated package manifests. If this optional cleanup
is chosen, the second command should report one physical version; the blocking
checks remain the target lock and executing anchor, successful boot, exact
healed fallback, and `DSH graph coherent: /home/antst`.

Every profile exact-pin install below also scans nested `node_modules` package
manifests against that profile's lock. A lock-tracked package is left alone; an
untracked directory is removed only after its name/version is re-read unchanged
and the exact record is re-confirmed absent from the lock. The following frozen
install must print both `Lockfile is up to date, resolution step is skipped` and
`Already up to date`. This explicit cleanup is necessary because pnpm 10.28.1
`prune` and `install --frozen-lockfile --force` both left such directories in
place on a hoisted profile during the measured in-place-upgrade reproduction.

## 3. Upgrade dashi to 0.1.2 in place

Upgrade the host launcher, then immediately re-check the host graph because a
host-level `pnpm add` may re-resolve peers:

```sh
cd "$DSH_INSTALL_DIR"
pnpm add --save-exact @antst/dashi-launcher@0.1.2
test -x "$DASHI_BIN"
repair_dsh_graph "$DSH_INSTALL_DIR" 0.1.5-rc.2 report headless
```

Expected output reports launcher `0.1.2`, then a nonzero host DSH
count at the single version `0.1.5-rc.2`.

Upgrade the existing dashi profile rather than replacing it, and re-check that
profile immediately after the add. If the add fails after touching the
physical tree, the failure branch restores the manifest and lock byte-for-byte,
permits the first frozen install to relink disturbed packages, requires the
second frozen install to be a full no-op, and proves the physical graph equals
the pre-step state. It then stops; do not retry until all four tarball HEAD
checks pass.

```sh
if ! "$DSH_BIN" plugin --profile dashi add @antst/dashi-app@0.1.2; then
  printf '%s\n' 'dashi profile add failed; restoring the pre-step graph' >&2
  cp --preserve=mode "$ROLLBACK_ROOT/profiles/dashi/package.json" "$DSH_HOME/profiles/dashi/package.json"
  cp --preserve=mode "$ROLLBACK_ROOT/profiles/dashi/pnpm-lock.yaml" "$DSH_HOME/profiles/dashi/pnpm-lock.yaml"
  cmp -s "$ROLLBACK_ROOT/profiles/dashi/package.json" "$DSH_HOME/profiles/dashi/package.json"
  cmp -s "$ROLLBACK_ROOT/profiles/dashi/pnpm-lock.yaml" "$DSH_HOME/profiles/dashi/pnpm-lock.yaml"

  first_install=$(pnpm --dir "$DSH_HOME/profiles/dashi" install --frozen-lockfile 2>&1)
  printf '%s\n' "$first_install"
  printf '%s\n' "$first_install" | grep -Fqx 'Lockfile is up to date, resolution step is skipped'

  second_install=$(pnpm --dir "$DSH_HOME/profiles/dashi" install --frozen-lockfile 2>&1)
  printf '%s\n' "$second_install"
  printf '%s\n' "$second_install" | grep -Fqx 'Lockfile is up to date, resolution step is skipped'
  printf '%s\n' "$second_install" | grep -Fqx 'Already up to date'

  remove_untracked_nested_packages "$DSH_HOME/profiles/dashi"
  . "$ROLLBACK_ROOT/versions.env"
  test "$(node -p 'require(process.argv[1]).version' "$DSH_HOME/profiles/dashi/node_modules/@antst/dashi-app/package.json")" = "$PREVIOUS_DASHI_APP_VERSION"
  test "$(node -p 'require(process.argv[1]).version' "$DSH_HOME/profiles/dashi/node_modules/@sessionbus/dsh/package.json")" = "$PREVIOUS_DASHI_SESSIONBUS_DSH_VERSION"
  check_dsh_graph "$DSH_HOME/profiles/dashi" 0.1.5-rc.2 required dashi
  printf '%s\n' 'pre-step dashi profile graph restored; stop before retry' >&2
  exit 1
fi
remove_untracked_nested_packages "$DSH_HOME/profiles/dashi"
repair_dsh_graph "$DSH_HOME/profiles/dashi" 0.1.5-rc.2 required dashi
if ! sed '/^snapshots:/,$d' "$DSH_HOME/profiles/dashi/pnpm-lock.yaml" | grep -Eq "^  '?@deepseek-ai/dsh[^@']*@"; then
  printf '%s\n' 'dashi profile DSH graph has no package records' >&2
  exit 1
fi
printf '%s\n' 'dashi profile DSH graph nonzero'
pnpm --dir "$DSH_HOME/profiles/dashi" list --depth 0 @antst/dashi-app @sessionbus/dsh
test "$(node -p 'require(process.argv[1]).version' "$DSH_HOME/profiles/dashi/node_modules/@sessionbus/kit/package.json")" = 0.5.7
```

Expected output contains `dashi profile DSH graph nonzero`,
`@antst/dashi-app 0.1.2`, and a DSH package count at the single version
`0.1.5-rc.2`. The count `11` was observed in a clean rebuilt profile, but it is
inventory only and is never an acceptance criterion. The pre-existing
`@sessionbus/dsh` row remains at its old version until the next section.

## 4. Upgrade sessionbus-dsh and its profiles

Install the package in the host project. This supplies the command for the
daemon's service PATH; the task shell PATH already lets the package-owned
launcher and installer find their child `dsh`:

```sh
cd "$DSH_INSTALL_DIR"
pnpm add --save-exact @sessionbus/dsh@0.1.0-pre.14
test -x "$HOST_BIN_DIR/sessionbus-dsh"
repair_dsh_graph "$DSH_INSTALL_DIR" 0.1.5-rc.2 report headless
test "$(node -p 'require(process.argv[1]).version' "$DSH_INSTALL_DIR/node_modules/@sessionbus/kit/package.json")" = 0.5.7
```

Expected output reports `@sessionbus/dsh 0.1.0-pre.14` and a nonzero host DSH
count at the single version `0.1.5-rc.2`.

Upgrade the installed sessionbus profile in place. Re-running the installer
repairs its old row by adding the required stable product `sessionbus-dsh`. The
sessionbus profile add
prints `declares no dsh.bundle — installed as a plain dependency`; this is
expected because that lane profile consumes the host DSH graph. Section 5 adds
the selected model provider's packages to this lane profile and the plain web
profile before either one runs a model turn.
Starting with `@sessionbus/dsh@0.1.0-pre.8`, re-running the installer merges its
dependency, row, and base-bundle entry into the existing profile manifest; it
does not remove provider packages, other bundles, or other manifest fields.

`@antst/dashi-app@0.1.2` and later already ship the `sessionbus` row
and their exact `@sessionbus/dsh` dependency. Do not run the installer against
the dashi profile: the dashi product runs the plugin version that dashi-app
pins, until dashi-app publishes a newer pin.

```sh
"$DSH_BIN" plugin --profile sessionbus add @sessionbus/dsh@0.1.0-pre.14
repair_dsh_graph "$DSH_HOME/profiles/sessionbus" 0.1.5-rc.2 optional sessionbus
"$DSH_BIN" plugin --profile sessionbus exec sessionbus-dsh-install
remove_untracked_nested_packages "$DSH_HOME/profiles/sessionbus"
pnpm --dir "$DSH_HOME/profiles/sessionbus" list --depth 0 @sessionbus/dsh
pnpm --dir "$DSH_HOME/profiles/dashi" list --depth 0 @sessionbus/dsh
test "$(node -p 'require(process.argv[1]).version' "$DSH_HOME/profiles/sessionbus/node_modules/@sessionbus/kit/package.json")" = 0.5.7
grep -F 'config: { mode: lane, product: sessionbus-dsh }' "$DSH_HOME/profiles/sessionbus/cordis.patch.yml"
grep -F 'config: { product: dashi }' "$DSH_HOME/profiles/dashi/node_modules/@antst/dashi-app/cordis.patch.yml"
```

Expected output contains `@sessionbus/dsh 0.1.0-pre.14` for the sessionbus
profile and the exact version pinned by dashi-app for the dashi profile, no DSH
version other than rc.2 in the lane graph (which may have zero DSH records),
and these exact rows:

```text
config: { mode: lane, product: sessionbus-dsh }
config: { product: dashi }
```

Create a plain, non-dashi web profile solely for the peer-mode acceptance
check. It has no configured groups; the environment supplies its one test
group. Re-check its graph immediately after the package add:

```sh
test ! -e "$DSH_HOME/profiles/web"
"$DSH_BIN" --profile web --dump-default-config >"$ROLLBACK_ROOT/web-default-config.yml"
"$DSH_BIN" plugin --profile web add @sessionbus/dsh@0.1.0-pre.14
repair_dsh_graph "$DSH_HOME/profiles/web" 0.1.5-rc.2 optional web
"$DSH_BIN" plugin --profile web exec sessionbus-dsh-install --product dsh web
remove_untracked_nested_packages "$DSH_HOME/profiles/web"
test "$(node -p 'require(process.argv[1]).version' "$DSH_HOME/profiles/web/node_modules/@sessionbus/kit/package.json")" = 0.5.7
grep -F 'config: { product: dsh }' "$DSH_HOME/profiles/web/cordis.patch.yml"
if grep -Eq '(^|[[:space:]{,])groups:' "$DSH_HOME/profiles/web/cordis.patch.yml"; then
  printf '%s\n' 'unexpected configured groups in web profile' >&2
  exit 1
fi
printf '%s\n' 'web profile has no configured groups'
```

Expected output contains no DSH version other than rc.2 (zero DSH records is
valid), the exact peer row below, and the no-groups confirmation:

```text
config: { product: dsh }
web profile has no configured groups
```

### Give the daemon its product command and advertisement

On the measured umka-dev1 layout, the service's current PATH lacks
`$HOME/node_modules/.bin`, its EnvironmentFile does not set PATH, and no
drop-in exists. Add that directory ahead of the existing effective PATH with
a direct controlled write of the already-backed-up owned drop-in. Separately,
inspect the single products assignment's quoting and append `sessionbus-dsh`
inside that assignment only. The script preserves every other byte and the
existing file inode, owner, and mode. It rejects multiple lines, mismatched
quotes, or product text outside the allowed identifier grammar.

```sh
grep '^SESSIONBUS_PRODUCTS=' "$SESSIONBUS_SERVICE_ENV"
case ":$SERVICE_PATH:" in
  *":$HOST_BIN_DIR:"*) printf '%s\n' 'service PATH already contains host bin' ;;
  *)
    mkdir -p "$(dirname "$SERVICE_DROPIN")"
    cat >"$SERVICE_DROPIN" <<EOF
[Service]
Environment="PATH=$HOST_BIN_DIR:$SERVICE_PATH"
EOF
    chmod 0644 "$SERVICE_DROPIN"
    ;;
esac
node --input-type=module - "$SESSIONBUS_SERVICE_ENV" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const file = process.argv[2]
const source = readFileSync(file, 'utf8')
const matches = [...source.matchAll(/^SESSIONBUS_PRODUCTS=([^\r\n]*)(\r?)$/gm)]
if (matches.length !== 1) throw new Error(`expected one SESSIONBUS_PRODUCTS assignment, found ${matches.length}`)
const match = matches[0]
const raw = match[1]
let quote = ''
let body = raw
if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
  quote = raw[0]
  body = raw.slice(1, -1)
} else if (raw.includes('"') || raw.includes("'")) {
  throw new Error('SESSIONBUS_PRODUCTS has unsupported quoting')
}
const products = body.split(',').map(value => value.trim()).filter(Boolean)
if (products.some(value => !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(value))) throw new Error('SESSIONBUS_PRODUCTS contains an invalid product')
if (!products.includes('sessionbus-dsh')) products.push('sessionbus-dsh')
const next = `SESSIONBUS_PRODUCTS=${quote}${products.join(',')}${quote}${match[2]}`
writeFileSync(file, source.slice(0, match.index) + next + source.slice(match.index + match[0].length))
NODE
test "$(stat -c '%a' "$SESSIONBUS_SERVICE_ENV")" = "$(cat "$ROLLBACK_ROOT/service/service-env-mode")"
test "$(stat -c '%u:%g' "$SESSIONBUS_SERVICE_ENV")" = "$(cat "$ROLLBACK_ROOT/service/service-env-owner")"
grep '^SESSIONBUS_PRODUCTS=' "$SESSIONBUS_SERVICE_ENV"
systemctl --user daemon-reload
systemctl --user restart "$SESSIONBUS_UNIT"
systemctl --user is-active "$SESSIONBUS_UNIT"
SESSIONBUS_PID=$(systemctl --user show "$SESSIONBUS_UNIT" -p MainPID --value)
test "$SESSIONBUS_PID" -gt 0
SERVICE_PATH_LINE=$(tr '\0' '\n' < "/proc/$SESSIONBUS_PID/environ" | grep '^PATH=')
SERVICE_PATH=${SERVICE_PATH_LINE#PATH=}
printf '%s\n' "$SERVICE_PATH_LINE"
PATH="$SERVICE_PATH" command -v sessionbus-dsh dsh
PATH="$SERVICE_PATH" sessionbus --version
sessionbus roster --local --json | node --input-type=module -e '
  let body = ""; for await (const chunk of process.stdin) body += chunk
  const products = JSON.parse(body).local.products
  console.log(`sessionbus-dsh advertised: ${products.includes("sessionbus-dsh")}`)
  if (!products.includes("sessionbus-dsh")) process.exit(1)
'
```

Expected output shows the original products line, then the same quoting with
`,sessionbus-dsh` added once; only one service restart occurs. The final lines
are:

```text
active
PATH=/home/antst/node_modules/.bin:/home/antst/.local/bin:/usr/local/bin:/usr/bin:/bin
/home/antst/node_modules/.bin/sessionbus-dsh
/home/antst/node_modules/.bin/dsh
sessionbus v0.5.7 (53c5f80e281f39e54bcee1fbe8a253da86ad1c08)
sessionbus-dsh advertised: true
```

Do not edit a shell rc file. The task-shell export is temporary; the systemd
drop-in is the persistent authority used by daemon-launched products.

### Variant: dashi as the only registered product

This subsection is an alternative, not a step in the live `umka-dev1`
two-product procedure above. Choose the two-product form when the daemon needs
the package-owned `sessionbus-dsh` lane command independently of dashi. Choose
this variant on a dashi host when peers and lanes should share the one registered
product `dashi`.

Use the same profile package add, but replace the lane installer's default call
with this explicit product and verify the repaired row:

```sh
"$DSH_BIN" plugin --profile sessionbus exec sessionbus-dsh-install --product dashi
grep -F 'config: { mode: lane, product: dashi }' "$DSH_HOME/profiles/sessionbus/cordis.patch.yml"
```

Expected output includes:

```text
config: { mode: lane, product: dashi }
```

When `dashi` is already in `SESSIONBUS_PRODUCTS`, no product addition is
needed; do not append `sessionbus-dsh`. The daemon maps `dashi` to the installed
`dashi` bin. Apply the same service PATH drop-in used above, because the daemon
must resolve both that launcher and the child `dsh` that it starts. After the
single restart, verify both commands under the effective service PATH:

```sh
PATH="$SERVICE_PATH" command -v dashi dsh
```

Expected output on `umka-dev1` is:

```text
/home/antst/node_modules/.bin/dashi
/home/antst/node_modules/.bin/dsh
```

For the lane acceptance below, use product `dashi` in both `describe` and
`spawn`; all run, terminal-record, acknowledgment, forget, and process-cleanup
steps stay unchanged.

## 5. Match the selected provider in model-running profiles

Both the `sessionbus` lane and the plain `web` peer run model turns under the
host's global default selection. The settings-file provider defaults to
`$DSH_HOME/settings.yaml` (`packages/settings/settings-file/src/index.ts:50-57`),
and the selection is stored at `agent-default-model.provider`
(`packages/core/agent-default-model/src/index.ts:20-37,76-78`). Read and print
that provider name only; do not print the rest of the settings document:

```sh
MODEL_PROVIDER=$(node --input-type=module - "$DSH_HOME/settings.yaml" "$DSH_INSTALL_DIR/node_modules/@deepseek-ai/dsh/package.json" <<'NODE'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
const [settingsFile, anchor] = process.argv.slice(2)
const require = createRequire(realpathSync.native(anchor))
const { parse } = require('yaml')
const provider = parse(readFileSync(settingsFile, 'utf8'))?.['agent-default-model']?.provider
if (typeof provider !== 'string' || provider.length === 0) throw new Error('settings agent-default-model.provider is missing')
process.stdout.write(provider)
NODE
)
printf 'selected provider=%s\n' "$MODEL_PROVIDER"
```

Expected output is one non-secret line such as `selected provider=openai-codex`.

The rc.2 base bundle registers `@deepseek-ai/dsh-llm-deepseek` as row
`llm-deepseek` (`packages/bundle/base/cordis.patch.yml:482-487`); that plugin
owns provider `deepseek-official`
(`packages/llm/llm-deepseek/src/index.ts:84-90`). When the selected provider is
anything else, both model-running profiles need the same provider plugin
packages and exact versions already carried by dashi. Inventory dashi's direct
packages first:

```sh
pnpm --dir "$DSH_HOME/profiles/dashi" list --depth 0
```

Expected output contains `@antst/dashi-app 0.1.2` and the selected
provider's direct plugin packages with their exact installed versions.

The umka worked example selects `deepseek-official`, so it adds no provider
package to either profile:

```sh
PROVIDER_PACKAGE_SPECS=()
```

Expected output: none.

As a separate example, the dsh host selects `openai-codex`. Its complete exact
package set is one package:

```sh
PROVIDER_PACKAGE_SPECS=(dsh-codex@0.3.0)
```

Expected output: none.

Provider plugins must be releases built for the host's DSH version; check their
`peerDependencies` floor before installation. rc.2 requires `modelErrors` in a
resolved provider profile (`packages/llm/llm-pi-ai/src/config.ts:185-217`) and
reads it at request preparation (`adapter.ts:253-260`); the rc.1-era
`dsh-codex@0.2.6` omitted that field (`src/adapter.ts:423-439`), so it boots but
fails its first turn with a `TypeError`.

`dsh-codex@0.3.0` is the smallest release that supplies `modelErrors` and
declares the rc.2 floor for its DSH host API peers (`package.json:71-96`). Its
DSH bundle declaration points at
`cordis.patch.yml` (`package.json:48-51`), whose lines 13-20 insert
`llm-openai-codex` and `openai-codex-tui`. The built apply registers
`OPENAI_CODEX_PROVIDER` with the LLM service (`lib/src-*.js`, the
`ctx.llm.registerAdapter` call). Its exact `dsh-session-format-catalog`
dependency needs no plugin row, and `dsh-plugin-subscriptions` is not required.

For `deepseek-official`, leave that array empty because the base bundle already
owns the adapter. Otherwise add every exact spec to both profiles and repair
each graph immediately afterwards:

```sh
if [ "$MODEL_PROVIDER" != deepseek-official ]; then
  test "${#PROVIDER_PACKAGE_SPECS[@]}" -gt 0
  for profile_name in sessionbus web; do
    for package_spec in "${PROVIDER_PACKAGE_SPECS[@]}"; do
      "$DSH_BIN" plugin --profile "$profile_name" add "$package_spec"
    done
    remove_untracked_nested_packages "$DSH_HOME/profiles/$profile_name"
    repair_dsh_graph "$DSH_HOME/profiles/$profile_name" 0.1.5-rc.2 optional "$profile_name"
  done
fi
```

Expected output lists each exact provider package in both profiles, then shows
each lock and physical graph coherent at rc.2 and the shared fallback exact.

When `MODEL_PROVIDER=deepseek-official`, a daemon-launched lane must be able to
resolve `DEEPSEEK_API_KEY`. The rc.2 credentials-local precedence is inherited
process environment, `$DSH_HOME/.credentials.yaml`, invocation-cwd `.env`, then
`$DSH_HOME/.env`
(`packages/credentials/credentials-local/src/index.ts:1-17`). Check only for
presence, in that order, against the daemon environment and the lane cwd; never
print a value or a credential file:

```sh
if [ "$MODEL_PROVIDER" = deepseek-official ]; then
  CREDENTIAL_SOURCE=
  if tr '\0' '\n' < "/proc/$SESSIONBUS_PID/environ" | grep -q '^DEEPSEEK_API_KEY=.'; then
    CREDENTIAL_SOURCE='daemon environment'
  elif [ -f "$DSH_HOME/.credentials.yaml" ] && node --input-type=module - "$DSH_HOME/.credentials.yaml" "$DSH_INSTALL_DIR/node_modules/@deepseek-ai/dsh/package.json" <<'NODE'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
const [file, anchor] = process.argv.slice(2)
const require = createRequire(realpathSync.native(anchor))
const { parse } = require('yaml')
const value = parse(readFileSync(file, 'utf8'))?.refs?.DEEPSEEK_API_KEY
process.exit(typeof value === 'string' && value.length > 0 ? 0 : 1)
NODE
  then
    CREDENTIAL_SOURCE='$DSH_HOME/.credentials.yaml'
  elif [ -f "$LANE_CWD/.env" ] && grep -q '^DEEPSEEK_API_KEY=.' "$LANE_CWD/.env"; then
    CREDENTIAL_SOURCE='lane cwd .env'
  elif [ -f "$DSH_HOME/.env" ] && grep -q '^DEEPSEEK_API_KEY=.' "$DSH_HOME/.env"; then
    CREDENTIAL_SOURCE='$DSH_HOME/.env'
  fi
  test -n "$CREDENTIAL_SOURCE"
  printf 'deepseek credential present via %s\n' "$CREDENTIAL_SOURCE"
fi
```

Expected output for `deepseek-official` names exactly one source without its
value. For another provider, this block produces no output.

rc.2 has no CLI provider-list command, but its LLM service exposes
`listProviders()` (`packages/llm/llm/src/index.ts:464-470`). Write this bounded
probe into the rollback directory. It reads only `HOME` and `DSH_HOME` from the
environment, suppresses DSH boot output, makes no provider request, and prints
only its one result line:

```sh
cat >"$ROLLBACK_ROOT/check-profile-provider.mjs" <<'NODE'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profile = process.argv[2]
if (profile === undefined) throw new Error('usage: check-profile-provider.mjs PROFILE [INSTALL_DIR] [PROVIDER] [CWD]')
const home = process.env.HOME
if (home === undefined) throw new Error('HOME is required')
const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
const installDir = process.argv[3] ?? home
const dshManifest = realpathSync(join(installDir, 'node_modules/@deepseek-ai/dsh/package.json'))
const anchoredRequire = createRequire(dshManifest)
const { parse } = anchoredRequire('yaml')
const selectedProvider = parse(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))?.['agent-default-model']?.provider
const provider = process.argv[4] ?? selectedProvider
if (typeof provider !== 'string' || provider.length === 0) throw new Error('settings agent-default-model.provider is missing')
const cwd = process.argv[5] ?? process.cwd()

const dshLib = join(dirname(dshManifest), 'lib')
const bootFile = readdirSync(dshLib).find(name => {
  if (!name.startsWith('profile-boot-') || !name.endsWith('.js')) return false
  return readFileSync(join(dshLib, name), 'utf8').includes('export { runProfile };')
})
if (bootFile === undefined) throw new Error('rc.2 profile-boot entry not found')
const appBootEntry = anchoredRequire.resolve('@deepseek-ai/dsh-app-boot')
const [{ runProfile }, { loadLayeredEnv }] = await Promise.all([
  import(pathToFileURL(join(dshLib, bootFile)).href),
  import(pathToFileURL(appBootEntry).href),
])

const patchDir = mkdtempSync(join(dshHome, '.provider-check-'))
const patchFile = join(patchDir, 'disable-sessionbus.yml')
writeFileSync(patchFile, '- id: sessionbus\n  disabled: true\n')
const stdoutWrite = process.stdout.write
const stderrWrite = process.stderr.write
process.stdout.write = () => true
process.stderr.write = () => true
let shutdown
let providers
try {
  const boot = await runProfile({
    environment: loadLayeredEnv('dsh', cwd),
    profile,
    patchFiles: [patchFile],
    args: ['--no-open', '--port', '0'],
  })
  shutdown = boot.shutdown
  providers = boot.ctx.llm.listProviders().map(value => value.id).sort()
} finally {
  try {
    if (shutdown !== undefined) await shutdown.shutdown(0)
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
    rmSync(patchDir, { recursive: true, force: true })
  }
}
if (!providers?.includes(provider)) throw new Error(`${provider} is not registered in profile ${profile}`)
console.log(`profile=${profile} provider=${provider} registered`)
NODE
```

Expected output: none; the script file is private to this rollback run.

The temporary patch disables only row id `sessionbus` for these two boots. The
lane row refuses peer mode without a launch token, while a fake token would
open a daemon connection; neither is part of an offline provider check. Base
and provider composition remain untouched. Run the same probe for both model-
running profiles with the launch token and peer groups explicitly absent:

```sh
for profile_name in sessionbus web; do
  if ! env -u SESSIONBUS_LAUNCH_TOKEN -u SESSIONBUS_GROUPS DSH_HOME="$DSH_HOME" \
    node "$ROLLBACK_ROOT/check-profile-provider.mjs" \
    "$profile_name" "$DSH_INSTALL_DIR" "$MODEL_PROVIDER" "$LANE_CWD"; then
    printf 'provider check failed for profile=%s\n' "$profile_name" >&2
    exit 1
  fi
done
```

Expected output, with the provider selected on this host, is:

```text
profile=sessionbus provider=deepseek-official registered
profile=web provider=deepseek-official registered
```

Both commands exit 0. Any missing selected provider or `NO_ADAPTER` failure
stops the run before the real-daemon turn.

## 6. Verification on the real daemon

Plugin pre.14 makes both interactive and managed-lane delivery active. An
interactive message admitted while its DSH root is idle starts a native turn.
For a lane, the daemon's default `idle_message: run` policy seeds one managed
Run when an ordinary message reaches the idle worker. In dashi,
`/sessionbus <free text>` is a DSH skill invocation: the typed text remains the
user message and the Sessionbus operating instructions are injected as skill
context before the model turn.

Use one long-lived originating controller built against Sessionbus SDK 0.5.7
or later for each spawn cell, and keep it connected through the terminal
record, acknowledgment, and close. Older callers with the pre-`policy.trace`
closed response schema can reject the successful Open response and disconnect;
the daemon has already committed the child, but the detached caller then sees
RPC `-32002 not_connected`. A one-shot caller is also invalid because its
identity disappears immediately after the call. Record the controller's
authenticated identity and SDK version before proceeding.

### Lane: package-owned launcher selects `dsh --profile sessionbus`

From the existing remote Sessionbus peer, first prove federated product
discovery. The daemon's local product list is not enough:

```json
{"action":"describe","arguments":{"product":"sessionbus-dsh","host":"umka-dev1"}}
```

Expected result: the call succeeds and lists the DSH lane's supported open
fields, including `cwd`.

In the umka-dev1 task shell, record the daemon's current direct children before
the spawn:

```sh
DAEMON_CHILDREN_BEFORE_RAW="$ROLLBACK_ROOT/daemon-children-before.raw"
DAEMON_CHILDREN_BEFORE="$ROLLBACK_ROOT/daemon-children-before"
pgrep_status=0
pgrep -P "$SESSIONBUS_PID" >"$DAEMON_CHILDREN_BEFORE_RAW" || pgrep_status=$?
test "$pgrep_status" -le 1
sed '/^$/d' "$DAEMON_CHILDREN_BEFORE_RAW" >"$DAEMON_CHILDREN_BEFORE.filtered"
LC_ALL=C sort "$DAEMON_CHILDREN_BEFORE.filtered" >"$DAEMON_CHILDREN_BEFORE"
printf '%s\n' 'daemon child baseline recorded'
```

Expected output is `daemon child baseline recorded`; child IDs are retained in
the shell and not printed.

Through the one long-lived controller, make the spawn, ordinary send, and wait
calls below. Replace `LANE_CWD` only with the exact `$LANE_CWD` printed during
preflight (`/home/antst/e2e-work` on umka-dev1); replace returned IDs only
after successful calls. Deliberately omit `idle_message`: this proves the
daemon's current default rather than an explicit override.

```json
{"id":"lane-spawn","action":"spawn","arguments":{"product":"sessionbus-dsh","host":"umka-dev1","name":"umka-dev1-lane-check","open":{"cwd":"LANE_CWD"},"extra_groups":["peer-dev"],"persistent":false,"auto_close_ms":0,"notify":false}}
{"id":"lane-send","action":"send","arguments":{"target":"RETURNED_SESSION_ID","message":"Reply with exactly: lane hello"}}
{"id":"lane-wait","action":"wait","arguments":{"session_id":"RETURNED_SESSION_ID","timeout_ms":150000}}
```

Expected spawn result: a new session ID with host suffix `@umka-dev1` and an
effective policy containing `idle_message: run`. The send returns one admitted
delivery. The idle worker starts one managed Run without an explicit `run` or
`start` call. Expected wait handling depends on the complete retained record:

- `state: done` is PASS only when `result.outcome: completed` and
  `result.result` is exactly `lane hello`. Record
  `result.native_stop_reason` when that optional field is present. A `done`
  record with a failed or interrupted `result.outcome` is recorded and
  acknowledged, but is not PASS.
- `state: unavailable` is recorded with its reason and acknowledged, but is
  not PASS and does not establish a native terminal.
- `state: running` is never acknowledged. Use `status` or one bounded `wait`
  with the same run ID, then apply these rules to the returned terminal record.

While the lane is open, identify the one new process owned directly by the
daemon and retain its PID for the close proof:

```sh
DAEMON_CHILDREN_AFTER_RAW="$ROLLBACK_ROOT/daemon-children-after.raw"
DAEMON_CHILDREN_AFTER="$ROLLBACK_ROOT/daemon-children-after"
NEW_LANE_PIDS_FILE="$ROLLBACK_ROOT/new-lane-pids"
pgrep_status=0
pgrep -P "$SESSIONBUS_PID" >"$DAEMON_CHILDREN_AFTER_RAW" || pgrep_status=$?
test "$pgrep_status" -le 1
sed '/^$/d' "$DAEMON_CHILDREN_AFTER_RAW" >"$DAEMON_CHILDREN_AFTER.filtered"
LC_ALL=C sort "$DAEMON_CHILDREN_AFTER.filtered" >"$DAEMON_CHILDREN_AFTER"
LC_ALL=C comm -13 "$DAEMON_CHILDREN_BEFORE" "$DAEMON_CHILDREN_AFTER" >"$NEW_LANE_PIDS_FILE"
mapfile -t NEW_LANE_PIDS <"$NEW_LANE_PIDS_FILE"
if [ "${#NEW_LANE_PIDS[@]}" -eq 1 ]; then
  LANE_PID=${NEW_LANE_PIDS[0]}
  test -d "/proc/$LANE_PID"
  printf '%s\n' 'one daemon-owned lane process recorded'
else
  LANE_PID=
  printf '%s\n' 'lane process attribution is ambiguous' >&2
fi
```

Expected output is `one daemon-owned lane process recorded`. If other daemon
launches race this check, retain the ambiguity, collect and acknowledge the
existing terminal record, close and forget this already-created lane, verify
its Sessionbus cleanup, and report that native-process attribution was not
proved. Do not create another lane or replay the run.

After recording the terminal state, `result.outcome`, optional
`result.native_stop_reason`, and `result.result`, ack the terminal record. Then
close and forget the disposable lane with the single public close call:

```json
{"id":"lane-ack","action":"ack","arguments":{"session_id":"RETURNED_SESSION_ID","run_id":"RETURNED_RUN_ID"}}
{"id":"lane-close","action":"close","arguments":{"session_id":"RETURNED_SESSION_ID","forget":true}}
{"id":"lane-after-list","action":"list","arguments":{"session_id":"RETURNED_SESSION_ID"}}
```

Expected results: `ack` consumes the already-inspected terminal record,
`close` succeeds, and `list` returns RPC error `unknown_session` with code
`-32001` (daemon `handlers.go:133-143`). `forget` removes the Sessionbus lane
record; it does not delete DSH's native session history. The all-rows check
below independently proves that no retained or offline row remains.

Back in the umka-dev1 task shell, also prove that the owned native process is
gone and that the daemon's all-rows roster has no forgotten row. Substitute
only the returned canonical session ID:

```sh
CLOSED_SESSION_ID='RETURNED_SESSION_ID'
if [ -n "${LANE_PID:-}" ]; then
  test ! -e "/proc/$LANE_PID"
else
  printf '%s\n' 'native process cleanup not attributable; report PID ambiguity' >&2
fi
sessionbus roster --all --json | node --input-type=module -e '
  let body = ""; for await (const chunk of process.stdin) body += chunk
  const target = process.argv[1]
  const roster = JSON.parse(body)
  const rows = [...(roster.local?.sessions ?? []), ...(roster.remote ?? []).flatMap(host => host.sessions ?? [])]
  if (rows.some(row => row.session_id === target)) throw new Error(`forgotten session remains: ${target}`)
  console.log("forgotten row absent")
' "$CLOSED_SESSION_ID"
```

Expected output:

```text
forgotten row absent
```

When one PID was attributed, the silent `/proc` assertion also proves that
native process is gone. When attribution was ambiguous, the roster cleanup is
still proved, but the native-process check remains an explicitly reported
uncertainty.

### Plain DSH peer: environment groups and a real reply

This proof deliberately does not use dashi. In a second terminal on
umka-dev1, run the plain web profile with no launch token and one non-secret
environment group:

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HOST_BIN_DIR="$HOME/node_modules/.bin"
export PATH="$HOST_BIN_DIR:$PATH"
env -u SESSIONBUS_LAUNCH_TOKEN SESSIONBUS_GROUPS='["peer-dev"]' "$HOST_BIN_DIR/dsh" --profile web --no-open --host 127.0.0.1 --port 0
```

Expected terminal result: the web server stays up without a sessionbus
configuration error. No socket export is needed: peer discovery uses a
nonempty `SESSIONBUS_SOCKET`, otherwise
`$XDG_RUNTIME_DIR/sessionbus/presence.sock`, otherwise
`/tmp/sessionbus-<uid>/presence.sock`. A daemon using a custom socket must set
`SESSIONBUS_SOCKET` for the launched peer. Open its local URL through the host's approved access
path and create one root DSH session. That root advertises product `dsh` and
group `peer-dev`; no profile row supplies the group.

Use the long-lived SDK 0.5.7+ controller as a same-group sender. Keep a
separate persistent native observer in `peer-dev` as the reply target because
the acceptance controller is not a model and may reject incoming deliveries.
The controller first lists and then messages the exact idle web session.
`list` shows only peers that share at least one group with its caller:

```json
{"id":"web-list","action":"list","arguments":{}}
{"id":"web-send","action":"send","arguments":{"target":"RETURNED_DSH_SESSION_ID","message":"Reply through sessionbus to REPLY_SESSION_ID with exactly: peer hello"}}
```

Expected results: the controller's `list` discovers the new `dsh` peer with
`peer-dev` among its groups. Replace `REPLY_SESSION_ID` with the persistent
observer's authenticated `self_info.session_id`, then `send` returns a
successful delivery receipt. A receipt proves admission, not model
consumption. Without a browser prompt or keypress, the idle web root starts a
native turn, uses its installed `sessionbus` tool, and the persistent observer
receives `peer hello` from the authenticated `dsh` session on the real bus.
Stop the web process normally and issue one more controller `list`; the web
row must be absent.

If a send has uncertain admission, preserve its delivery ID, receipt, and
reason and report the uncertainty. Never replay an uncertain send. Stop the
web process normally after the reply; rollback later preserves its profile for
inspection rather than deleting it.

### Dashi integration, separately

In another terminal, start the installed dashi profile without a launch token.
This is a separate integration check, not the peer-mode proof above:

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HOST_BIN_DIR="$HOME/node_modules/.bin"
export PATH="$HOST_BIN_DIR:$PATH"
env -u SESSIONBUS_LAUNCH_TOKEN SESSIONBUS_GROUPS='["peer-dev"]' "$HOST_BIN_DIR/dashi"
```

Expected terminal result: dashi opens normally with no Sessionbus
configuration error. The same-group controller's `list` sees its root as
product `dashi` with group `peer-dev`. Keep the persistent native observer as
the reply target and perform both human-visible checks:

1. Type `/sessionbus reply over the bus to REPLY_SESSION_ID with exactly:
   slash ok`. The transcript renders a Sessionbus skill-invocation context
   cell, the model runs, its tool result reports an admitted delivery, and the
   observer receives exactly `slash ok`.
2. Wait until dashi is idle. From the long-lived controller, send the dashi
   row `reply over the bus to REPLY_SESSION_ID with exactly: pong`. Without a
   dashi keypress, the transcript renders a delivered Context cell naming the
   controller, a new model turn starts, and the observer receives exactly
   `pong`.

For each case, a delivery receipt alone is insufficient: retain the dashi
session's skill or relay event, its model turn and tool result, and the
observer's authenticated reply. Exit dashi normally, then issue another
controller `list`; the dashi row must be absent.

Finally verify the dashi launcher without starting an interactive session:

```sh
HELP_FILE=$(mktemp)
"$DASHI_BIN" --help >"$HELP_FILE"
HELP_STATUS=$?
sed -n '1p' "$HELP_FILE"
printf 'dashi help exit=%s\n' "$HELP_STATUS"
rm "$HELP_FILE"
```

Expected output:

```text
dashi 0.1.2 on DSH 0.1.5-rc.2
dashi help exit=0
```

## 7. Rollback

Rollback is safe after any partial stage. Stop any interactive web or dashi
process first. Use the rollback directory printed in preflight and source only
its generated package-version record:

```sh
test -n "${ROLLBACK_ROOT:-}"
. "$ROLLBACK_ROOT/versions.env"
ROLLBACK_FAILED="$ROLLBACK_ROOT/failed-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROLLBACK_FAILED"
```

Expected output: none; one private `failed-*` directory now exists for any
new artifacts moved aside during recovery.

Remove the current plugin rows and package from every profile where its
installer is present. This path does not require a profile to boot:

```sh
for profile_name in web sessionbus; do
  installer="$DSH_HOME/profiles/$profile_name/node_modules/.bin/sessionbus-dsh-install"
  package="$DSH_HOME/profiles/$profile_name/node_modules/@sessionbus/dsh/package.json"
  installed_version=$(if [ -f "$package" ]; then node -p 'require(process.argv[1]).version' "$package" 2>/dev/null || true; fi)
  if [ "$installed_version" = '0.1.0-pre.14' ] && [ -x "$installer" ]; then
    pnpm --dir "$DSH_HOME/profiles/$profile_name" exec sessionbus-dsh-install --remove "$profile_name"
  fi
done
```

Expected output: each installer-managed profile reports removal of the current
`@sessionbus/dsh` package and its managed rows; absent or not-yet-installed
profiles are explicitly skipped. The dashi-app-owned dependency and bundle row
are restored with the dashi profile files below, not removed by this installer.

Restore the service environment and its prior PATH authority. Every operation
is guarded for a rollback that began before the service edit:

```sh
if [ -f "$ROLLBACK_ROOT/service/service.env" ]; then
  cp --preserve=mode "$ROLLBACK_ROOT/service/service.env" "$SESSIONBUS_SERVICE_ENV"
  chmod "$(cat "$ROLLBACK_ROOT/service/service-env-mode")" "$SESSIONBUS_SERVICE_ENV"
fi
if [ -f "$ROLLBACK_ROOT/service/dropin-existed" ] && [ -f "$ROLLBACK_ROOT/service/override.conf" ]; then
  mkdir -p "$(dirname "$SERVICE_DROPIN")"
  cp --preserve=mode "$ROLLBACK_ROOT/service/override.conf" "$SERVICE_DROPIN"
elif [ -e "$SERVICE_DROPIN" ]; then
  mv "$SERVICE_DROPIN" "$ROLLBACK_FAILED/created-service-override.conf"
  rmdir "$(dirname "$SERVICE_DROPIN")" 2>/dev/null || true
fi
systemctl --user daemon-reload
systemctl --user restart "$SESSIONBUS_UNIT"
systemctl --user is-active "$SESSIONBUS_UNIT"
cmp -s "$ROLLBACK_ROOT/service/service.env" "$SESSIONBUS_SERVICE_ENV"
test "$(stat -c '%a' "$SESSIONBUS_SERVICE_ENV")" = "$(cat "$ROLLBACK_ROOT/service/service-env-mode")"
test "$(stat -c '%u:%g' "$SESSIONBUS_SERVICE_ENV")" = "$(cat "$ROLLBACK_ROOT/service/service-env-owner")"
SESSIONBUS_PID=$(systemctl --user show "$SESSIONBUS_UNIT" -p MainPID --value)
RESTORED_PATH_LINE=$(tr '\0' '\n' < "/proc/$SESSIONBUS_PID/environ" | grep '^PATH=')
test "$RESTORED_PATH_LINE" = "PATH=$(cat "$ROLLBACK_ROOT/service/effective-path")"
sessionbus roster --local --json | node --input-type=module -e '
  let body = ""; for await (const chunk of process.stdin) body += chunk
  const products = JSON.parse(body).local.products
  if (products.includes("sessionbus-dsh")) process.exit(1)
  console.log("original daemon advertisement restored")
'
```

Expected final lines:

```text
active
original daemon advertisement restored
```

Restore the exact host manifest and lockfile, then install that frozen graph.
This replaces the target versions with the versions captured before the first
mutation; it does not pretend that top-level version re-adds reconstruct a
dependency graph:

```sh
if [ -f "$ROLLBACK_ROOT/host/package.json" ] && [ -f "$ROLLBACK_ROOT/host/pnpm-lock.yaml" ]; then
  cp --preserve=mode "$ROLLBACK_ROOT/host/package.json" "$DSH_INSTALL_DIR/package.json"
  cp --preserve=mode "$ROLLBACK_ROOT/host/pnpm-lock.yaml" "$DSH_INSTALL_DIR/pnpm-lock.yaml"
  pnpm --dir "$DSH_INSTALL_DIR" install --frozen-lockfile
fi
cmp -s "$ROLLBACK_ROOT/host/package.json" "$DSH_INSTALL_DIR/package.json"
cmp -s "$ROLLBACK_ROOT/host/pnpm-lock.yaml" "$DSH_INSTALL_DIR/pnpm-lock.yaml"
printf '%s\n' 'host manifest and frozen lock restored'
```

Expected output ends with:

```text
host manifest and frozen lock restored
```

Restore each pre-existing profile's manifest, lockfile, and patch, then install
its frozen graph. A file absent from the snapshot is moved aside if the upgrade
created it. The test-only web profile did not exist before preflight, so retain
it under `failed-*` rather than deleting it:

```sh
restore_profile_file() {
  profile_name=$1
  file=$2
  saved="$ROLLBACK_ROOT/profiles/$profile_name/$file"
  target="$DSH_HOME/profiles/$profile_name/$file"
  if [ -f "$saved" ]; then
    cp --preserve=mode "$saved" "$target"
  elif [ -e "$target" ]; then
    mkdir -p "$ROLLBACK_FAILED/$profile_name"
    mv "$target" "$ROLLBACK_FAILED/$profile_name/$file"
  fi
}
for profile_name in dashi sessionbus; do
  if [ -d "$DSH_HOME/profiles/$profile_name" ]; then
    restore_profile_file "$profile_name" package.json
    restore_profile_file "$profile_name" pnpm-lock.yaml
    restore_profile_file "$profile_name" cordis.patch.yml
    pnpm --dir "$DSH_HOME/profiles/$profile_name" install --frozen-lockfile
  fi
done
if [ -d "$DSH_HOME/profiles/web" ]; then
  mv "$DSH_HOME/profiles/web" "$ROLLBACK_FAILED/web"
fi
printf '%s\n' 'profile manifests, frozen locks, and patches restored'
```

Expected output ends with:

```text
profile manifests, frozen locks, and patches restored
```

Verify the restored files byte-for-byte and the installed package versions
against the preflight record:

```sh
for profile_name in dashi sessionbus; do
  for file in package.json pnpm-lock.yaml cordis.patch.yml; do
    saved="$ROLLBACK_ROOT/profiles/$profile_name/$file"
    target="$DSH_HOME/profiles/$profile_name/$file"
    if [ -f "$saved" ]; then cmp -s "$saved" "$target"; fi
  done
done
test ! -e "$DSH_HOME/profiles/web"
package_version() {
  if [ -f "$1" ]; then node -p 'require(process.argv[1]).version' "$1"; fi
}
test "$(package_version "$DSH_INSTALL_DIR/node_modules/@deepseek-ai/dsh/package.json")" = "$PREVIOUS_DSH_VERSION"
test "$(package_version "$DSH_INSTALL_DIR/node_modules/@antst/dashi-launcher/package.json")" = "$PREVIOUS_DASHI_LAUNCHER_VERSION"
test "$(package_version "$DSH_INSTALL_DIR/node_modules/@sessionbus/dsh/package.json")" = "$PREVIOUS_HOST_SESSIONBUS_DSH_VERSION"
test "$(package_version "$DSH_HOME/profiles/dashi/node_modules/@antst/dashi-app/package.json")" = "$PREVIOUS_DASHI_APP_VERSION"
test "$(package_version "$DSH_HOME/profiles/dashi/node_modules/@sessionbus/dsh/package.json")" = "$PREVIOUS_DASHI_SESSIONBUS_DSH_VERSION"
test "$(package_version "$DSH_HOME/profiles/sessionbus/node_modules/@sessionbus/dsh/package.json")" = "$PREVIOUS_LANE_SESSIONBUS_DSH_VERSION"
"$DSH_BIN" --version
printf '%s\n' 'rollback consistency verified'
```

Expected output on the recorded umka-dev1 baseline ends with:

```text
0.1.2-rc.1
rollback consistency verified
```

Recovery guarantees the prior frozen host and profile dependency graphs are
installed from their saved manifests and lockfiles, the target release's
managed rows are removed, the previous profile patches are restored, and the
service environment and effective PATH match preflight. It does not claim that
`node_modules` is byte-for-byte identical to its old physical layout; the
manifest, lockfile, resolved package versions, profile rows, service bytes, and
live service state are the consistency checks.
