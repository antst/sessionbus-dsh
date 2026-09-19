# sessionbus for DSH

`@sessionbus/dsh` connects DSH roots to sessionbus and runs daemon-managed DSH lanes.
It depends on the exact `@sessionbus/kit` prerelease `0.1.0-pre.3`.
It supports DeepSeek Harness `0.1.5-rc.2` and later; tested versions are
`0.1.5-rc.2`, `0.1.6-alpha.1`, and `0.1.6-alpha.2`.
A DSH profile must install every DSH package at one uniform DSH version; adding
one prerelease package can otherwise pull newer prereleases through DSH's caret peers.
`@sessionbus/dsh` is a pkg.pr.new preview until a separately reviewed trusted-
publishing workflow exists; its first registry version must be published manually
before trusted publishing can be configured.
`@antst/dsh-file-uploads-none` is a preview until its npm publish and is swapped
for the exact published version at release.

The plugin reads the token once, deletes it from process.env, and retains it
nowhere in the plugin; DSH's immutable launch snapshot keeps it for the process
lifetime (trusted host).

Create the base-only lane profile with:

```sh
dsh plugin --profile sessionbus add @sessionbus/dsh && dsh plugin --profile sessionbus exec sessionbus-dsh-install
```

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

Register the daemon's `sessionbus-dsh` product command as the package's
`sessionbus-dsh` bin. With a launch token it selects the installed `sessionbus`
profile; without one it forwards arguments to `dsh` unchanged.
The daemon finds that command on `PATH`, so install this package alongside
`dsh` at the host level too—for example, run `pnpm add @sessionbus/dsh` in the
directory where `dsh` is installed—so both bins share one `node_modules/.bin`.

Uninstall without invoking DSH by running the installed bin from the profile:

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec sessionbus-dsh-install --remove web
```

When the DSH CLI works, `dsh plugin --profile web exec
sessionbus-dsh-install --remove web` is the equivalent convenience form. The
installer removes the package first, then strips its managed `sessionbus` and
`file-uploads-none` rows.

See [Lane without a TUI](docs/LANE-WITHOUT-TUI.md) for the daemon launch contract.
