# Changelog

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
