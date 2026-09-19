# Installing a DSH lane host

This runbook installs a DSH lane host, with `umka-dev1` as the worked
example. Run it as the ordinary account returned by `id -un`, never with
`sudo`, and refer to its home as `$HOME` in commands. On `umka-dev1` that
account is `antst` and its home is `/home/antst`; earlier references to `pdev`
were wrong. The target set is DSH `0.1.5-rc.2`, dashi
`0.1.0-alpha.19`, and `@sessionbus/dsh` `0.1.0-pre.2`. Do not continue
past a failed assertion.

This runbook is the real-daemon acceptance procedure for DSH `0.1.5-rc.2`.
The equivalent acceptance on `0.1.6-alpha.2` is still outstanding.

None of the commands below prints `SESSIONBUS_LAUNCH_TOKEN`,
`SESSIONBUS_GROUPS`, the local key, or the federation secret. The only
environment assignments intentionally displayed are the daemon's filtered
`PATH=` and `SESSIONBUS_PRODUCTS=` lines.

Dashi alpha.18 lacked the `sessionbus` profile row and the launcher token
path. The pinned packages below are published. Run these exact probes
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
login-path dsh=<not found>
pnpm=10.28.1
node=v25.3.0
npm=11.6.2
explicit dsh=/home/antst/node_modules/.bin/dsh
```

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

Define one checker and one bounded repair for the host and profile lock graphs.
The checker accepts any nonzero package count but exactly one DSH version. The
repair rewrites only package names in the DSH family; it never deletes
`node_modules`, deletes a lockfile, or runs a broad dedupe:

```sh
check_dsh_graph() {
node --input-type=module - "$1" <<'NODE'
import { readFileSync } from 'node:fs'
const lockfile = readFileSync(process.argv[2], 'utf8')
const packageSection = lockfile.split('\nsnapshots:\n', 1)[0] ?? ''
const records = [...packageSection.matchAll(/^  '?(@deepseek-ai\/dsh[^@']*)@([^':]+)'?:$/gm)]
const versions = [...new Set(records.map(([, , version]) => version))].sort()
console.log(`DSH packages: ${records.length}`)
console.log(`DSH versions: ${versions.join(', ')}`)
if (records.length === 0 || versions.length !== 1 || versions[0] !== '0.1.5-rc.2') process.exit(1)
NODE
}
repair_dsh_graph() {
  graph_root=$1
  test ! -e "$graph_root/.pnpmfile.cjs"
  cat >"$graph_root/.pnpmfile.cjs" <<'HOOK'
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
  if pnpm --dir "$graph_root" install --lockfile-only --fix-lockfile; then
    :
  else
    repair_status=$?
    rm -f "$graph_root/.pnpmfile.cjs"
    return "$repair_status"
  fi
  rm "$graph_root/.pnpmfile.cjs"
  pnpm --dir "$graph_root" install --frozen-lockfile
}
ensure_dsh_graph() {
  graph_root=$1
  if check_dsh_graph "$graph_root/pnpm-lock.yaml"; then
    printf 'DSH graph coherent: %s\n' "$graph_root"
  else
    printf 'repairing DSH graph only: %s\n' "$graph_root"
    repair_dsh_graph "$graph_root"
    check_dsh_graph "$graph_root/pnpm-lock.yaml"
  fi
}
ensure_dsh_graph "$DSH_INSTALL_DIR"
```

Expected output is a nonzero, inventory-dependent package count, exactly one
version, and either the coherent line or one bounded repair followed by the
same successful check:

```text
DSH packages: <nonzero count>
DSH versions: 0.1.5-rc.2
DSH graph coherent: /home/antst
```

The explicit conditional is important under `set -e`: a failed first check
enters the documented DSH-only repair instead of terminating the task shell.
If `.pnpmfile.cjs` already exists or the second check fails, stop with the
rollback copy intact.

## 3. Upgrade dashi to alpha.19 in place

Upgrade the host launcher, then immediately re-check the host graph because a
host-level `pnpm add` may re-resolve peers:

```sh
cd "$DSH_INSTALL_DIR"
pnpm add --save-exact @antst/dashi-launcher@0.1.0-alpha.19
test -x "$DASHI_BIN"
ensure_dsh_graph "$DSH_INSTALL_DIR"
```

Expected output reports launcher `0.1.0-alpha.19`, then a nonzero host DSH
count at the single version `0.1.5-rc.2`.

Upgrade the existing dashi profile rather than replacing it, and re-check that
profile immediately after the add:

```sh
"$DSH_BIN" plugin --profile dashi add @antst/dashi-app@0.1.0-alpha.19
ensure_dsh_graph "$DSH_HOME/profiles/dashi"
pnpm --dir "$DSH_HOME/profiles/dashi" list --depth 0 @antst/dashi-app @sessionbus/dsh
```

Expected output contains `@antst/dashi-app 0.1.0-alpha.19` and a nonzero DSH
package count at the single version `0.1.5-rc.2`. The count `11` was observed
in a clean rebuilt profile, but it is inventory only and is never an acceptance
criterion. The pre-existing `@sessionbus/dsh` row remains at its old version
until the next section.

## 4. Upgrade sessionbus-dsh and its profiles

Install the package in the host project. This supplies the command for the
daemon's service PATH; the task shell PATH already lets the package-owned
launcher and installer find their child `dsh`:

```sh
cd "$DSH_INSTALL_DIR"
pnpm add --save-exact @sessionbus/dsh@0.1.0-pre.2
test -x "$HOST_BIN_DIR/sessionbus-dsh"
ensure_dsh_graph "$DSH_INSTALL_DIR"
```

Expected output reports `@sessionbus/dsh 0.1.0-pre.2` and a nonzero host DSH
count at the single version `0.1.5-rc.2`.

Upgrade both installed profiles in place. Re-running the installer repairs the
old rows by adding their required stable products: `sessionbus-dsh` for the
lane profile and `dashi` for the dashi peer profile.

```sh
"$DSH_BIN" plugin --profile sessionbus add @sessionbus/dsh@0.1.0-pre.2
ensure_dsh_graph "$DSH_HOME/profiles/sessionbus"
"$DSH_BIN" plugin --profile sessionbus exec sessionbus-dsh-install
"$DSH_BIN" plugin --profile dashi add @sessionbus/dsh@0.1.0-pre.2
ensure_dsh_graph "$DSH_HOME/profiles/dashi"
"$DSH_BIN" plugin --profile dashi exec sessionbus-dsh-install --product dashi dashi
pnpm --dir "$DSH_HOME/profiles/sessionbus" list --depth 0 @sessionbus/dsh
pnpm --dir "$DSH_HOME/profiles/dashi" list --depth 0 @sessionbus/dsh
grep -F 'config: { mode: lane, product: sessionbus-dsh }' "$DSH_HOME/profiles/sessionbus/cordis.patch.yml"
grep -F 'config: { product: dashi }' "$DSH_HOME/profiles/dashi/cordis.patch.yml"
```

Expected output contains `@sessionbus/dsh 0.1.0-pre.2` for both profiles,
nonzero single-version rc.2 graphs, and these exact repaired rows:

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
"$DSH_BIN" plugin --profile web add @sessionbus/dsh@0.1.0-pre.2
ensure_dsh_graph "$DSH_HOME/profiles/web"
"$DSH_BIN" plugin --profile web exec sessionbus-dsh-install --product dsh web
grep -F 'config: { product: dsh }' "$DSH_HOME/profiles/web/cordis.patch.yml"
if grep -Eq '(^|[[:space:]{,])groups:' "$DSH_HOME/profiles/web/cordis.patch.yml"; then
  printf '%s\n' 'unexpected configured groups in web profile' >&2
  exit 1
fi
printf '%s\n' 'web profile has no configured groups'
```

Expected output contains one nonzero rc.2 graph, the exact peer row below, and
the no-groups confirmation:

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
sessionbus-dsh advertised: true
```

Do not edit a shell rc file. The task-shell export is temporary; the systemd
drop-in is the persistent authority used by daemon-launched products.

## 5. Verification on the real daemon

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

From the remote peer, make the spawn and run calls below. Replace `LANE_CWD`
only with the exact `$LANE_CWD` printed during preflight
(`/home/antst/e2e-work` on umka-dev1); replace returned IDs only after
successful calls:

```json
{"action":"spawn","arguments":{"product":"sessionbus-dsh","host":"umka-dev1","name":"umka-dev1-lane-check","open":{"cwd":"LANE_CWD"},"extra_groups":["peer-dev"],"persistent":false,"auto_close_ms":0,"idle_message":"stage"}}
{"action":"run","arguments":{"session_id":"RETURNED_SESSION_ID","input":"Reply with exactly: lane hello"}}
```

Expected spawn result: a new session ID with host suffix `@umka-dev1`.
Expected run handling depends on the complete retained record:

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
{"action":"ack","arguments":{"session_id":"RETURNED_SESSION_ID","run_id":"RETURNED_RUN_ID"}}
{"action":"close","arguments":{"session_id":"RETURNED_SESSION_ID","forget":true}}
{"action":"list","arguments":{"session_id":"RETURNED_SESSION_ID"}}
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
env -u SESSIONBUS_LAUNCH_TOKEN SESSIONBUS_GROUPS='["peer-dev"]' "$HOST_BIN_DIR/dsh" --profile web --no-open --port 3081
```

Expected terminal result: the web server stays up without a sessionbus
configuration error. Open its local URL through the host's approved access
path and create one root DSH session. That root advertises product `dsh` and
group `peer-dev`; no profile row supplies the group.

From a different authenticated peer on the real daemon, list and message that
exact web session:

```json
{"action":"list","arguments":{}}
{"action":"send","arguments":{"target":"RETURNED_DSH_SESSION_ID","message":"Reply through sessionbus to ORIGINATING_SESSION_ID with exactly: peer hello"}}
```

Expected results: `list` discovers the new `dsh` peer with `peer-dev` among its
groups. Replace `ORIGINATING_SESSION_ID` with that caller's authenticated
`self_info.session_id`, then `send` returns a successful delivery receipt. A
receipt proves admission, not model consumption. In the web UI for that exact
session, submit `Carry out the preceding Sessionbus request now.` The agent
uses its installed `sessionbus` tool, and the originating peer receives
`peer hello` from the authenticated `dsh` session on the real bus.

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

Expected terminal result: dashi opens normally with no sessionbus
configuration error. A remote `list` sees its root as product `dashi` with
group `peer-dev`. Exit dashi normally after recording that row.

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
dashi 0.1.0-alpha.19 on DSH 0.1.5-rc.2
dashi help exit=0
```

## 6. Rollback

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
for profile_name in web dashi sessionbus; do
  installer="$DSH_HOME/profiles/$profile_name/node_modules/.bin/sessionbus-dsh-install"
  package="$DSH_HOME/profiles/$profile_name/node_modules/@sessionbus/dsh/package.json"
  installed_version=$(if [ -f "$package" ]; then node -p 'require(process.argv[1]).version' "$package" 2>/dev/null || true; fi)
  if [ "$installed_version" = '0.1.0-pre.2' ] && [ -x "$installer" ]; then
    pnpm --dir "$DSH_HOME/profiles/$profile_name" exec sessionbus-dsh-install --remove "$profile_name"
  fi
done
```

Expected output: each present profile reports removal of the current
`@sessionbus/dsh` package and its managed rows; absent or not-yet-installed
profiles are explicitly skipped.

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
