# sessionbus for DSH

`@sessionbus/dsh` connects DSH roots to sessionbus and runs daemon-managed DSH lanes.
It depends on the exact `@sessionbus/kit` prerelease `0.1.0-pre.2`.
`@sessionbus/dsh` is a pkg.pr.new preview until a separately reviewed trusted-
publishing workflow exists; its first registry version must be published manually
before trusted publishing can be configured.

The plugin reads the token once, deletes it from process.env, and retains it
nowhere in the plugin; DSH's immutable launch snapshot keeps it for the process
lifetime (trusted host).

The installer always configures the `sessionbus` lane profile. It adds the
home-level peer row only when no installed product profile already provides a
loader entry with id `sessionbus`, so product bundles such as dashi remain the
single owner of their peer-mode entry.
