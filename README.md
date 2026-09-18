# sessionbus for DSH

`@sessionbus/dsh` connects DSH roots to sessionbus and runs daemon-managed DSH lanes.
It depends on the exact `@sessionbus/kit` prerelease `0.1.0-pre.3`.
It supports DeepSeek Harness `0.1.5-rc.2` and `0.1.6-alpha.2`.
`@sessionbus/dsh` is a pkg.pr.new preview until a separately reviewed trusted-
publishing workflow exists; its first registry version must be published manually
before trusted publishing can be configured.

The plugin reads the token once, deletes it from process.env, and retains it
nowhere in the plugin; DSH's immutable launch snapshot keeps it for the process
lifetime (trusted host).

Create the base-only lane profile with:

```sh
dsh plugin --profile sessionbus add @sessionbus/dsh && dsh plugin --profile sessionbus exec sessionbus-dsh-install
```

Add the peer plugin to another profile, such as `web`, with:

```sh
dsh plugin --profile web add @sessionbus/dsh && dsh plugin --profile web exec sessionbus-dsh-install web
```

The installer writes only profile-local rows and leaves an existing
`sessionbus` row, such as dashi's, unchanged. With no profile arguments it
configures only the `sessionbus` lane profile.

See [Lane without a TUI](docs/LANE-WITHOUT-TUI.md) for the daemon launch contract.
