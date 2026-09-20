# Changelog

## 0.1.0-pre.9 — 2026-09-20

- Peer mode publishes only with the native session id, updates titles through the kit's rehello(signal, name, info), and replaces the identity when the durable session id changes; the fake daemon enforces the daemon's identity rules (W-089).

## 0.1.0-pre.8 — 2026-09-20

- The installer merges into an existing lane profile manifest and preserves every other dependency, bundle and field (W-088).
- docs/HOST-INSTALL.md: check loops stop at the first failure; host assertions are the lockfile, the executing install anchor, the headless boot and the healed fallback closure; the hoisted top-level projection is reported, not asserted.

## 0.1.0-pre.7 — 2026-09-20

- Run input text is taken from the kit's run seed ({text} or {delivery.body}) and stored as a plain text part; proofs assert the exact durable text on every DSH version (W-087).
- A turn that fails before the input commit ends the run as failed with DSH's error code and message instead of an unavailable record (W-086).
- docs/HOST-INSTALL.md: physical graph checks (top-level projection and healed profile fallback), one-boot reconciliation, provider parity with an offline registration check, and the rule that provider plugins must be the release built for the host's DSH floor (dsh-codex 0.3.0 for openai-codex on 0.1.5-rc.2).

## 0.1.0-pre.6 — 2026-09-20

- Supersedes 0.1.0-pre.5, which was tagged but never published to npm (release runner npm too old for trusted publishing; W-085).
- A host with dashi installed may register `dashi` as the only product: `sessionbus-dsh-install --product dashi` for the lane profile (W-084).
- Release workflow publishes through npm trusted publishing on npm 11.5+ (W-085).

## 0.1.0-pre.5 — 2026-09-20

- A host with dashi installed may register `dashi` as the only product: `sessionbus-dsh-install --product dashi` for the lane profile (W-084).
- docs/HOST-INSTALL.md: the graph repair is one helper based on exact pins of stale peer-only DSH records; zero DSH records is coherent for lane and web profiles.

## 0.1.0-pre.4 — 2026-09-19

- Supersedes 0.1.0-pre.3, which was tagged but never published to npm; do not reference it.
- The `sessionbus` tool is permitted by default in every composition (lane profile, dashi row, web or custom peer) through DSH's tools/pre-execute decision; no opt-out; a session without comms is an ordinary launch without the plugin (W-081).
- @sessionbus/kit 0.5.5: accepts the daemon's optional `policy.trace` on spawn/resume responses (W-083).
- docs/HOST-INSTALL.md: the host install runbook (daemon service PATH, product registration, in-place profile upgrade, rollback).

## 0.1.0-pre.3 — 2026-09-19

- The `sessionbus` tool is permitted by default in every composition (lane profile, dashi row, web or custom peer) through DSH's tools/pre-execute decision; no opt-out; a session without comms is an ordinary launch without the plugin (W-081).
- docs/HOST-INSTALL.md: the host install runbook (dev1 handoff), with the daemon service PATH, product registration, in-place profile upgrade and rollback steps.

## 0.1.0-pre.2 — 2026-09-19

- DSH compatibility floor: every DSH peer is `>=0.1.5-rc.2`; tested on 0.1.5-rc.2, 0.1.6-alpha.1 and 0.1.6-alpha.2.
- Package-owned `sessionbus-dsh` launcher; the plugin row's `product` field is required and written by the installer.
- `sessionbus-dsh-install --remove <profile>` uninstalls without booting DSH.
- Lane mode never reads SESSIONBUS_GROUPS; peer mode uses config groups, else the environment.
- Depends on the published `@antst/dsh-file-uploads-none@0.1.0-alpha.18`.

## 0.1.0-pre.1

- Initial preview of Sessionbus peer and lane modes, validated with DSH
  0.1.5-rc.2 and 0.1.6-alpha.2.
