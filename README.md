# sessionbus for DSH

`@sessionbus/dsh` connects DSH roots to sessionbus and runs daemon-managed DSH lanes.
It depends on the exact `@sessionbus/kit` version `0.5.5`.
It supports DeepSeek Harness `0.1.5-rc.2` and later; tested versions are
`0.1.5-rc.2`, `0.1.6-alpha.1`, and `0.1.6-alpha.2`.
A DSH profile must install every DSH package at one uniform DSH version; adding
one prerelease package can otherwise pull newer prereleases through DSH's caret peers.
The default single-tool permission grant relies on DSH's `tools/pre-execute`
waterfall, present since the `0.1.5-rc.2` peer floor.
`@sessionbus/dsh` is a pkg.pr.new preview until a separately reviewed trusted-
publishing workflow exists; its first registry version must be published manually
before trusted publishing can be configured.
The plugin reads the token once, deletes it from process.env, and retains it
nowhere in the plugin; DSH's immutable launch snapshot keeps it for the process
lifetime (trusted host).

## Installation

See [Installing a DSH lane host](docs/HOST-INSTALL.md) for the complete
preflight, installation, verification, and rollback procedure.

Create the base-only lane profile for the package-owned `sessionbus-dsh`
product with:

```sh
dsh plugin --profile sessionbus add @sessionbus/dsh && dsh plugin --profile sessionbus exec sessionbus-dsh-install
```

On a host that already uses dashi, one product can own both peers and lanes:

```sh
dsh plugin --profile sessionbus add @sessionbus/dsh && dsh plugin --profile sessionbus exec sessionbus-dsh-install --product dashi
```

In that form `SESSIONBUS_PRODUCTS` contains `dashi`, not `sessionbus-dsh`,
and the daemon maps it to `@antst/dashi-launcher`'s `dashi` bin.

Add the peer plugin to another profile, such as `web`, with:

```sh
dsh plugin --profile web add @sessionbus/dsh && dsh plugin --profile web exec sessionbus-dsh-install --product dsh web
```

The installer writes only profile-local rows and leaves an existing
`sessionbus` row's other fields unchanged while adding or updating its required
`product`. With no profile arguments it configures only the `sessionbus` lane
profile and derives product `sessionbus-dsh`. Use product `dashi` for the dashi
profile, `dsh` for a standalone web or custom peer profile, or another stable
operator-chosen identifier matching `^[a-z0-9][a-z0-9-]{0,31}$`.
Non-web profiles also receive the no-upload provider required by DSH's Session
Controller; ordinary text prompts work while file-upload receipts are rejected.

For the two-product form, register the daemon's `sessionbus-dsh` product as the
package's `sessionbus-dsh` bin. For the one-product form, register only `dashi`
as the `dashi` bin. Both launchers select the installed `sessionbus` profile
when given a launch token. Install the selected launcher alongside `dsh` at the
host level and put their shared `node_modules/.bin` on the daemon service's
`PATH`; the `dashi` launcher resolves its child `dsh` by name.

Uninstall without invoking DSH by running the installed bin from the profile:

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec sessionbus-dsh-install --remove web
```

When the DSH CLI works, `dsh plugin --profile web exec
sessionbus-dsh-install --remove web` is the equivalent convenience form. The
installer removes the package first, then strips its managed `sessionbus` and
`file-uploads-none` rows.

`SESSIONBUS_GROUPS` configures peer identities only. Lane membership is owned
by the daemon; the plugin accepts and does not consume groups in `session.open`.

See [Lane without a TUI](docs/LANE-WITHOUT-TUI.md) for the daemon launch contract.
