# `@sessionbus/dsh` — technical proposal

Design only. Greenfield on `@sessionbus/kit`; the shipped `dsh-comms` +
`dsh-lane` pair is the predecessor, not the base (as §3.5).

Citation roots — `dsh:`/`as:` = the `dsh-0.1.2-rc.1/` and `as-design/` trees under
`/tmp/claude-1000/-home-antst-dtui/4e09852f-b0d6-4344-b2c4-741ea0134a4b/scratchpad/`;
`dashi:` = `/home/antst/dtui-main/`. Every DSH line number was re-verified against
0.1.2-rc.1; four differ from the brief and are marked `(was N)`.

---

## 1. Plugin structure on the kit

### 1.1 Mode selection

| Fact | Rule | Source |
|---|---|---|
| `SESSIONBUS_LAUNCH_TOKEN` present | worker mode | as §3.1 (`as:docs/designs/UNIVERSAL-SESSION-PROTOCOL.md:927-934`) |
| absent | peer mode | as §3.4:1000-1004 |
| config `mode: lane`, no token | fatal startup error | as §3.4:1064-1065 |
| config `mode: peer`, token present | fatal startup error (recommended) | symmetry; fail loud |
| config `mode` absent | derive from env | — |

The config row **asserts**, it never overrides: the token is the only authority.
The dashi boot layer performs the *same* token check, independently, to pick the
profile (§2) — one env fact, two readers, no flag and no handshake between them.
Env is read through `ctx.launchEnvironment` (`dsh:packages/util/launch-environment/src/index.ts:106,114-124`),
the launcher-owned provenance-tracked snapshot filled "before any config entry
mounts"; it falls back to `process.env` when a host provided none. The plugin
never reads `ctx.cmdlineArgs` (`dsh:packages/boot/cmdline/src/index.ts:27-33`) —
no argv parsing anywhere, in either mode.

"Fatal" means `ctx.appExit(1)` after one stderr line, never a throw from `apply`:
a non-disabled row whose fiber never activates is a hard boot failure
(`dsh:packages/boot/app-boot/src/index.ts:673-679`, error text at
`:772-822` — `plugin tree failed to load`).

**Source precedence** (owner addendum, one rule for every profile: dashi, plain
DSH, and any web profile, which then needs only the plugin row inserted):

| Input | 1. config row | 2. environment | 3. default |
|---|---|---|---|
| groups | `groups: [..]` | `SESSIONBUS_GROUPS` (JSON array) | private group only |
| socket | `socket: <path>` | `SESSIONBUS_SOCKET` | the documented socket path |
| local key | `local_key: <k>` | `SESSIONBUS_LOCAL_KEY` | no key |
| launch token | never in config | `SESSIONBUS_LAUNCH_TOKEN` | absent → peer mode |

The first present source wins per input; sources never merge. Per-root-session
semantics (one connection per root, identity and title per root, delivery by
connection) already cover web-profile sessions. Groups are fixed for the life
of a session: a re-hello with a different group set is invalid, and a session
with different groups is a new session.

### 1.2 The six callbacks

| Kit callback | DSH primitive | Citation |
|---|---|---|
| `hello` | `appReady.onReady` gate; identity from `agent.session.id` + `session.header.cwd` + the `session/title` projection | `dsh:packages/boot/cmdline/src/index.ts:52,88`; `dsh:packages/core/session/src/types.ts:100,104`; `dsh:packages/session/session-title/src/index.ts:74-77` |
| `open` | `sessionController.create` (`:235`, was 234) then `resolveAgent` (`:182`); resume = `resolveAgent(resume_native_id)` | `dsh:packages/api/session-controller/src/index.ts:182,235` |
| `open` (options) | `rename` (`:306`, was 305), `selectModel` (`:245`, was 244), `permissionPresets.set` (`:379`) validated against `.names` (`:282`, was 277), then `sessions.flush` (`:1086`) | `dsh:packages/interaction/permission-presets/src/index.ts:282,379`; `dsh:packages/core/session/src/index.ts:1086` |
| `run` | `createUserMessage` (`:194`) → `agent.followup(message)` (`:131`); observe `session/event` | `dsh:packages/llm/llm/src/message.ts:194`; `dsh:packages/core/agent-loop/src/agent.ts:131` |
| `interrupt` | `agent.cancel({kind:'user'}, {keepInbox:true})` | `dsh:packages/core/agent-loop/src/agent.ts:143`; `dsh:packages/core/agent/src/runtime-types.ts:85-91` |
| `deliver` | idle → `session.append('user/message', msg, {surfaceOp:'append'})`; running → `agent.steer(message)` | `dsh:packages/core/session/src/index.ts:668-716`; `dsh:packages/core/agent-loop/src/agent.ts:135` |
| `close` | `agent.cancel({kind:'disposed'})` if running, `agent.whenIdle()` (`:204`), `sessions.flush` | `dsh:packages/core/agent-loop/src/agent.ts:143,204` |

**hello.** Declared open fields: `name`, `cwd`, `permission_mode`, `model`,
`reasoning_effort`. `extra_arguments: []` (see §4.6). Product token `dashi`
(as §3.4:998). Product version comes from the plugin's own `package.json` — DSH
publishes no version service (§4.4).

**open.** Fresh open must let DSH mint the native id: `create` without
`sessionId` yields `session-<uuid>` (`dsh:packages/api/session-controller/src/commands.ts:77`),
the returned `native_id`. The predecessor forced the caller's id
(`as:integrations/dsh/lane/plugin.cjs:202-203`); the daemon now owns `uuid@host`
separately, so forcing is unnecessary and a §1.1 grammar trap. Resume asserts
`agent.id === agent.session.id === resume_native_id` (`lane/plugin.cjs:208`).

**run.** One root-context listener,
`ctx.on('session/event', (session, event) => …, {global:true})`
(`dsh:packages/core/session/src/index.ts:74`), correlating by message id:
`agent/inbox/spliced.inserted` = receipt, `user/message` = consumption inside
the open `turn/start` turn, `assistant/message` accumulates text,
`turn/end` records the native stop reason, and `agent.whenIdle()` is the
authoritative terminal. If DSH reaches idle after a plugin-issued cancel without
committing `turn/end`, the plugin reports `interrupted` with its recorded
`aborted:user` reason. Reason map when `turn/end` is present
(`dsh:packages/core/session/src/types.ts:193-215`):

| `TurnEndReason.kind` | Wire outcome |
|---|---|
| `completed` | `completed` |
| `aborted`, `interrupted` | `interrupted` |
| `blocked`, `error`, `max-tokens` | `failed` |

Unknown kind throws → `{outcome:"failed"}` per as §3.1:947-951. The 262,144-char
truncation and `truncated:true` are kit-side (as §1.1:64-68), not DSH-layer.

**deliver.** Discriminate on `agent.status`
(`dsh:packages/core/agent-loop/src/agent.ts:108`; event
`agent/status` at `dsh:packages/core/agent/src/runtime-types.ts:185`). Idle uses
`append`, which "writes synchronously to the durable surface, starts no turn"
and the next turn derives from the whole surface via `deriveMessages()`
(`dsh:packages/core/session/src/index.ts:790-810`). The ack is the durable
artefact itself: `append` returns the committed `SessionEvent` (`:668-716`);
for `steer` the ack is the observed `agent/inbox/spliced.inserted` entry
(`as:integrations/dsh/comms/plugin.cjs:144-148,171-175`). Both report
`injected`; DSH never needs `queued_for_next_turn`.

**close.** `close()` cancels if needed, awaits `whenIdle`, flushes, returns.
`appExit(0)` (`dsh:packages/boot/cmdline/src/index.ts:60,87`) belongs to a
separate outer task awaiting the kit's `closed` signal (as §3.2:936-940), worker
mode only. The predecessor called it from inside the handler via `setImmediate`
(`lane/plugin.cjs:158-162`); that races the close response and is dropped.

### 1.3 Root identity and rename

Peer mode holds one connection per live DSH root
(`as:docs/designs/DSH-TUI-REQUIREMENTS.md:37`). `session.update` dies (as §1.3);
a title change is an **in-place re-hello on the same connection** with the
identical `session_id` (owner ruling D2), replacing name and info only; a
re-hello with a different group set is invalid. Trigger: the `session/title`
latest-wins event (`dsh:packages/session/session-title/src/index.ts:74-77`),
written by `sessionController.rename`. Lane mode: the composed bus name is applied with
`rename` at open, and that **pins** the title: an explicit user-source title
supersedes in-flight automatic generation and later user messages schedule
none (`dsh:packages/session/session-title/src/index.ts:388-399`, guard at
`:500-501`); only an explicit `refresh` unpins (`:427-453`), which the plugin
never calls. No config row, no patch, no re-apply loop; the lane title is
fixed by DSH's own rule. Workers never re-hello.

One name only: the DSH session title. No separate sessionbus name is stored.

### 1.4 Tool surface

`tools.register` (`dsh:packages/core/tools/src/index.ts:1028`) registers exactly
**one** promptless tool, `sessionbus`, with an `action` enum —
`start | wait | status | interrupt | spawn | describe | close | list | send` —
plus a free-shape `arguments` object, exactly the predecessor's shape
(`as:integrations/dsh/comms/plugin.cjs:210-224`) with the enum widened from two
to nine. Caller identity is `execution.agent`, host-supplied, never a model
argument (`comms/plugin.cjs:221-223`; DSH-TUI-REQUIREMENTS:20-22). The kit
carries the calls as ordinary client-to-daemon methods on the same socket
(as §1.1:57-60) — no tool frame.

---

## 2. Profile and patch shapes

| Artefact | Contents |
|---|---|
| `sessionbus` profile `package.json` | `dsh.profile = {"bundles":["@deepseek-ai/dsh-base"],"patchReload":"startup"}`. The product owner confirmed that `dsh-headless` is a one-shot task app and cannot own a resident lane (2026-09-06, `delivery-feb6ed09b1365dbb6c33071baefe8d59`). |
| its `cordis.patch.yml` | fixed coding-agent `system-prompt` persona; disabled `session-title-llm`; the fourth permission preset; and `{id: sessionbus, name: '@sessionbus/dsh', config: {mode: lane}}`, `session-controller`, and `workspace` rows |
| `dashi-app` `cordis.patch.yml` | insert `{id: sessionbus, name: '@sessionbus/dsh'}` (no `config`; peer is the default) as a sibling of `dashi`/`roller` (`dashi:packages/dashi-app/cordis.patch.yml:103-107`) |

Patch rows are `{id, name, config?, disabled?, inject?}`; composition is bundle
patches, then the profile's own, then `--patch` overlays
(`dsh:packages/boot/app-boot/src/profile.ts:5-17`, `composeEntries` at `:854-861`).
Row order is irrelevant — a plugin dependency is a service `inject` and the
Cordis fiber waits for it.

**Verified addition to as §3.4's patch text:** `@deepseek-ai/dsh-api-session-controller`
and `@deepseek-ai/dsh-workspace` appear in neither the base nor the headless
bundle patch (`dsh:packages/bundle/base/cordis.patch.yml`,
`dsh:packages/bundle/headless/cordis.patch.yml` — grepped, absent), so the
profile must insert them as the predecessor did
(`as:integrations/dsh/lane/cordis.patch.yml:17-23`). The `permission` plugin
*is* in base with three presets (`base/cordis.patch.yml:235-247`); the fourth,
`workspace-write-noninteractive` (`lane/cordis.patch.yml:10-12`), remains a
profile-level config override.

**Verified on DSH 0.1.2-rc.1:** launching the former base-plus-headless profile
with no task exits before plugin hello because the headless app requires a CLI
task. The sealed failure and installed manifest are
`/home/antst/sessionbus-evidence/dsh-20260906T213752Z/cell-03-describe/describe.result.json`
and
`/home/antst/sessionbus-evidence/dsh-20260906T213752Z/setup/sessionbus-package.json`.
The resident base-only shape above is the product owner's correction to this
section (2026-09-06, `delivery-feb6ed09b1365dbb6c33071baefe8d59`).

`dashi-app` already inserts `session-controller` (`:85-86`) and `workspace`
(`:82-83`), so peer mode needs no extra rows.

### What dashi must change

There is **no `--lane` flag** (owner ruling). The daemon execs `dashi` with an
empty argv and `SESSIONBUS_LAUNCH_TOKEN` in the environment; that token is
the sole lane signal at both layers.

| Change | Where | Size |
|---|---|---|
| token present in `process.env` → spawn `--profile sessionbus`, else `--profile dashi` (unchanged) | `dashi:packages/dashi-launcher/bin/dashi.js:4` | ~4 lines |
| `-g/--group` (repeatable, comma-splitting) → `SESSIONBUS_GROUPS` as a JSON array string in the child env; the flag and its value are removed from argv | same file | ~8 lines |
| exact pin + patch row | `dashi:packages/dashi-app/package.json:32-45`, `cordis.patch.yml` | 2 lines |
| README paragraph on presence, groups, title-as-name | per W-036 | ~10 lines |
| D-036 amended (see §7.1) | `dashi:LEDGER.md:429-441` | ledger |

Everything else is forwarded untouched, the token env inherited unchanged (the
kit scrubs it inside DSH, as §3.1:920-924); the launcher stays 23 → ~35 lines
with zero state. A stale exported token plus an interactive `dashi` yields
headless lane mode and a loud `invalid_hello`; no heuristic guards that.

---

## 3. Lifecycle edges from the DSH side

**App-ready.** `appReady.onReady` runs the listener "once successful startup is
committed" and never on a failed start
(`dsh:packages/boot/cmdline/src/index.ts:44-52`, provided at `:88`). In peer
mode dashi's roots already exist when the plugin activates, so the plugin must
present existing roots at apply *and* subscribe to `agent/created` — exactly the
predecessor's two paths (`comms/plugin.cjs:140,225`). In worker mode no session
exists until `session.open`.

**Event ordering.** `session/event` is a "post-commit, fire-and-forget append
feed"; the listener snapshot resolves before the log push, callbacks run after
it, and observer failures are logged and contained without failing the append
(`dsh:packages/core/session/src/index.ts:64-74`, implementation `:700-712`).
Because the feed is the log in order, `turn/end` necessarily follows the last
`assistant/message` of that turn when it is committed. Run completion is the
agent's idle transition through `whenIdle`, not the optional event. No polling,
no timers.

**flush / appExit vs `closed`.** `sessions.flush` is "THE flush entry point"
(`dsh:packages/core/session/src/index.ts:1074-1086`); `appExit` exits "once the
tree has been disposed" (`cmdline:35-42`). Order per as §3.2: `close()` → flush →
return; kit writes the response, closes the socket, resolves `closed`; then `appExit(0)`.

**Cancel.** Interrupt uses `{kind:'user'}` with `keepInbox: true`, which
"preserves queued and steering inbox items instead of discarding them … and no
canceled inbox splice is logged" (`dsh:packages/core/agent/src/runtime-types.ts:36-41`)
— so a concurrent delivery survives. The ordinary terminal is `aborted` with
`reason:{kind:'user'}` (`dsh:packages/core/session/src/types.ts:196`). Close uses
`{kind:'disposed'}` without `keepInbox`. DSH architect's `w068-abort` harness
on 0.1.2-rc.1 verified that undici adds a non-enumerable `stack` accessor to a
pre-header abort reason, session append rejects that object inside the
`turn/end` finally path, and only `agent/error` is logged while the agent still
reaches idle. The idle transition therefore settles the run from the plugin's
recorded cancel reason.

**Multiple root sessions.** dashi's `/new`, `/resume`, `/fork` leave idle roots
in `ctx.agents.roots()` (`dsh:packages/core/agent/src/index.ts:607`).
**Recommendation: one connection per root session, not one per process.** as
§1.1:9-12 makes a session *be* a connection; canonical identity is set per
connection by `session.hello` and `message.deliver` carries no target-session
field — routing *is* the connection. Multiplexing would need a dashi-side
session-id demux: owned state and a second identity mechanism, which rules 2–4
forbid. Cost: N idle roots = N sockets, peer mode only (worker mode has one root).

**No-daemon rule.** Activation never throws (a thrown apply is
`plugin tree failed to load`, `app-boot:772-822`); at most one stderr line
(`comms/plugin.cjs:182`); tool calls return plain errors rather than hang;
reconnect is one fixed 2 s interval — `DEFAULT_RECONNECT_MS = 2000`
(`as:integrations/shared/live-session.js:13,266-268`). Worker mode never
reconnects (as §3.2:941-942).

---

## 4. Where DSH cannot honour §3 as written

| # | §3 requirement | DSH reality | Missing / differing primitive |
|---|---|---|---|
| 1 | Peer hello supplies "a bare RFC UUID `session_id`" (as §1.1:88-92) | DSH mints `session-${randomUUID()}` (`dsh:packages/api/session-controller/src/commands.ts:77`) | No DSH primitive yields a bare v4 UUID as the native id. Either the daemon relaxes the peer grammar, or the plugin strips the fixed `session-` prefix on the wire and re-adds it locally. **Owner call required** — a plugin cannot invent this. |
| 2 | Terminal outcome `interrupted` (as §1.1, §3.1) | DSH's `interrupted` reason is emitted only "by a persistence backend … on reload. The loop never emits this marker" (`dsh:packages/core/session/src/types.ts:209-213`) | A live interrupt is `aborted` + `TurnEndCancelCause` (`types.ts:196`). `interrupted` is *reconstructed* from `aborted`, never observed live. Conformant, but the mapping is lossy: `aborted{kind:'hook'}` and `aborted{kind:'parent'}` also collapse to `interrupted`. |
| 3 | `session.list` reports lane titles (as §1.1:120-135) | `summarizeCold` probes projections only when the session file is under `coldBlankProbeMaxBytes`; a larger cold session returns no `projections`, hence no title (`dsh:packages/api/session-controller/src/list.ts:164-183`, `probeSmallCold` `:185-215`) | Cold titles for large sessions and forks are unavailable without opening the session. Affects a sessionbus caller naming resumable DSH rows; dashi itself does not list sessionbus rows. |
| 4 | hello reports "optionally the product version" (as §1.1:96-99) | No DSH version service exists (grepped `packages/boot`, `packages/*/src` for `harnessVersion`/`dshVersion`/`provide('version'…)` — none) | The plugin can report only its own package version. Not DSH's. |
| 5 | `session.update` dies; a name change is a fresh hello (as §1.3, §3.4:1057-1059) | DSH's title service is latest-wins and titles automatically (`dsh:packages/session/session-title/src/index.ts:74-77,116-125`) | Every ordinary session therefore reconnects at least once mid-session, unprompted. No DSH primitive suppresses or batches the title event, and rules 3–4 forbid a debounce timer. See §7.5. |
| 6 | `open.arguments` is "handed to the product in its exact order" (as §3.1:915-918) | DSH's only argv surface is `ctx.cmdlineArgs` (`dsh:packages/boot/cmdline/src/index.ts:27-33`), which the owner rules forbid the plugin from reading | No DSH primitive consumes ordered extra arguments from a plugin config path. Recommend declaring `extra_arguments: []` and failing a non-empty `arguments` with `spawn_failed` / `stderr_tail:["argument conflicts with typed field"]`-style text. |
| 7 | `model` is one opaque product-native string (as §1.1, §3.1:911-914) | `selectModel` takes `sessionId`, `provider` **and** `model`, plus optional `reasoningEffort` (`dsh:packages/api/session-controller/src/index.ts:245`; `types.ts:269`), and it **also persists the deployment default** via `agentDefaultModel.saveSelection` (`dsh:packages/api/session-controller/src/commands.ts:119-145`); rc.1 has no session-only selection (dashi W-025) | Two differences: shape — the wire's one string must be spelled `provider/model` and split by the plugin, a bare model fails as `unsupported value model=<v>`; and scope — an `open` with `model` moves the host's default for every later session in that `$DSH_HOME`. State both in hello's field docs; a session-only selection is a queued DSH upstream ask. |
| 8 | `permission_mode` is an opaque string the product validates | `permissionPresets.names` reflects the `permission` row's config (`dsh:packages/interaction/permission-presets/src/index.ts:279-282`); base ships three presets (`dsh:packages/bundle/base/cordis.patch.yml:235-247`), the lane profile adds a fourth | Conformant but profile-dependent: the same product token advertises different valid values under different profiles. `lane.describe` cannot see that. |
| 9 | `closeBound = 10 s` covers interrupt + terminal + native close (as §1.1, §3.2) | `agent.whenIdle()` has no bound and "follows both the task and any waking work released behind it" (`dsh:packages/core/agent/src/runtime-types.ts:99,105-106`) | No DSH primitive bounds idling. A slow hook or `runMaintenance` task exceeds 10 s → daemon KILL, `last_turn` unchanged. The plugin must **not** add a timer (rules 3–4); state the exposure instead. |
| 10 | The design text execs `<product> --lane` (as §1.1:164, §2.1:425, §2.3:516,530,558, §3.4:1014, §5.3:1248, §5.5:1293) | The owner ruling removes `--lane` entirely: the daemon execs `dashi` with empty argv and lane mode is derived from `SESSIONBUS_LAUNCH_TOKEN` | Not a DSH gap — a signed-design text that the ruling supersedes in eight places, including the `lane.describe` probe and the W-DSH conformance cell. The DSH side is unaffected either way (the plugin reads env, never argv), but §5.5's `W-DSH: … against dashi --lane` must be respelled before it is run. |
| 11 | Package identity | as §3.4:1044 says the row's `name` is `@sessionbus/dsh`; as §3.5:1080-1082 says `integrations/dsh/comms` "remains under its current package identity", i.e. `@sessionbus/dsh-comms` (`as:integrations/dsh/comms/package.json:2`) | Internal contradiction in the signed design. dashi must pin whichever name the patch row carries. See §7.6. |

---

## 5. Size against the 300 / 300 DSH-layer cap

Logical lines, excluding the generic JS kit and shared fixtures (as §3.4:1084-1086).

| Unit | Prod | Tests | Justification |
|---|---:|---:|---|
| mode select, env read, activation guard, diagnostics | 25 | 30 | four env names, one config assertion, one stderr line, never-throw wrapper |
| `hello` | 20 | 20 | five declared fields + identity read; no logic |
| `open` | 55 | 55 | create/resolve, id assertion, rename, `provider/model` split, preset validation, flush — six calls each with one failure path |
| `run` | 70 | 50 | the only stateful unit: one `session/event` fold over four event types plus the reason map |
| `interrupt` | 8 | 15 | one call; the coalescing is kit-side |
| `deliver` | 35 | 45 | status branch, two primitives, two receipt observations |
| `close` + `appExit` task | 20 | 20 | cancel/whenIdle/flush, then the `closed` await |
| tool registration (one enum tool) | 25 | 20 | nine-value enum, pass-through execute |
| peer root tracking + rename re-hello | 30 | 35 | roots-at-apply, `agent/created`/`agent/disposed`, `session/title` → re-hello |
| **Total** | **288** | **290** | 12 / 10 lines of slack |

The predecessor is 507 physical lines (`comms/plugin.cjs` 232 +
`lane/plugin.cjs` 275). What makes 288 reachable: the extension registry and
deferred presence (`comms/plugin.cjs:92-138,155-159`), the presence-served lane
RPC with its `inflight`/`byInput` double index (`lane/plugin.cjs:132-166`), the
the predecessor-specific env translation (`:192-228`), and `inspectSession`
(`:178-190`) all die. The risk is `run`: if correlation needs a second index it
passes 70 and the cap binds — a redesign signal, not a licence to split files.

---

## 6. Packaging

| Stage | Mechanism |
|---|---|
| sessionbus→dashi integration testing | `pkg.pr.new` preview of `@sessionbus/dsh` per PR; dashi consumes it **only on a work branch** |
| dashi→sessionbus integration testing | `pkg.pr.new` preview of `@antst/dashi-app` + `@antst/dashi-launcher` from dashi `develop` |
| Pins | npm only. `dashi-app` `dependencies` gains `"@sessionbus/dsh": "<exact>"` — no range, matching every existing row (`dashi:packages/dashi-app/package.json:34-44`) |
| Release order | sessionbus publishes `@sessionbus/dsh` to npm → dashi pins it exactly on a `w-NNN` branch → gate → squash-merge to `develop` → dashi alpha release → sessionbus pins that dashi version for its own conformance run |

A preview URL never reaches `develop` or `main`: dashi rule 7 permits published
packages at pinned versions only. Every injected `@deepseek-ai/*` service plus
`cordis` and `cordis-plugin-loader` must be **peer** dependencies so the Cordis
singletons stay singleton (`as:docs/designs/DSH-TUI-REQUIREMENTS.md:39-41`;
pattern at `as:integrations/dsh/comms/package.json:34-41`). The union of the two
predecessors' peer sets: `dsh-agent`, `dsh-api-session-controller`, `dsh-cmdline`,
`dsh-launch-environment`, `dsh-llm`, `dsh-permission-presets`, `dsh-session`,
`dsh-session-title`, `dsh-tools`, `dsh-workspace`, plus `dsh-commands` if §7.4 is
adopted.

---

## 7. Open questions, with recommended answers

**7.1 The launcher and `-g` (ruled; D-036 to be amended).**
D-036 (`dashi:LEDGER.md:429-441`) made the launcher a plain forwarder and
mapped `-g` to a native `/sessionbus group <g>` command at startup. The
owner's boot-layer ruling supersedes it: the plugin never reads argv, `-g`
lands in `SESSIONBUS_GROUPS`, and the launch token selects the profile.
*Applied as:* the launcher gains exactly one env read (the token → `--profile
sessionbus`) and one flag parse (`-g/--group`, repeatable and
comma-splitting, consumed into `SESSIONBUS_GROUPS` as a JSON array),
forwarding everything else untouched (`dashi:packages/dashi-launcher/bin/dashi.js:4`).
The dashi architect amends D-036 at W-036. Cost, stated plainly: the launcher
is no longer a purely dumb forwarder, and the documented no-launcher form
`dsh --profile dashi` (`dashi:DESIGN.md:218-219`) loses `-g` — lane mode still
works there because the plugin reads the token itself, but the operator must
spell `--profile sessionbus` by hand. The startup `/sessionbus group`
call from D-036 is dropped; groups have exactly one source, the environment,
and `/sessionbus` (7.4) reports them. Recorded as the smallest change; no
further decision needed.

**7.2 Does `dashi-app` ship the plugin in peer mode by default?**
*Recommendation: yes*, per D-036/W-036, gated on the no-daemon evidence
(§3). Rejected alternative — an optional row — is not expressible: a
non-disabled row that fails to import is a hard boot failure
(`dsh:packages/boot/app-boot/src/index.ts:673-679`), and `disabled: true` by
default would need a user patch edit to turn on, which is worse than a
dependency.

**7.3 Groups environment format.**
*Recommendation: a JSON array*, `SESSIONBUS_GROUPS='["a","b"]'` — the
shipped client's existing format (`as:integrations/dsh/comms/plugin.cjs:36,52-58`).
A comma list is ambiguous on the wire: as §1.1:44-47 permits any printable
non-whitespace character in a name part, comma included. The CLI spelling stays
`-g a,b` and `-g a -g b`; only launcher→plugin is JSON.

**7.4 A `/sessionbus` command.**
"No argv" does not forbid an interactive command; `commands.register`
(`dsh:packages/interaction/commands/src/index.ts:274-281`) executes "against
the receiving agent without sending the command to the model" (`:69-71`).
*Recommendation:* register one **read-only** `/sessionbus` in every mode —
mode, connection state, canonical identity, groups. Group mutation is not a
feature at all: groups are fixed for the life of a session (owner ruling D2),
so the command reports and refuses; a session with different groups is a new
session started with different `-g`.

**7.5 Rename flow.**
*Decided (D2):* peer mode watches `session/title`
(`dsh:packages/session/session-title/src/index.ts:74-77`) and re-hellos in
place on the same connection with the identical `session_id`; the daemon
replaces name and info. No debounce, no timer, no reconnect. Groups never
change through this path.

**7.6 Package name.**
*Recommendation:* `@sessionbus/dsh`, per the more specific statement in
as §3.4:1044, and publish `@sessionbus/dsh-comms` as a deprecated alias
pointing at it. dashi pins whatever the patch row names; a mismatch is a hard
boot failure, not a warning.

**7.7 Which rows the `sessionbus` profile inserts.**
*Recommendation:* the profile patch carries `session-controller` and
`workspace` alongside the plugin row, plus the
`workspace-write-noninteractive` preset override — verified absent from base
and headless (§2). as §3.4:1044-1047 as written would boot a profile whose
`open` callback has no `sessionController`.
