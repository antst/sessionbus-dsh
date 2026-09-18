# Lane without a TUI

The Sessionbus daemon starts a DSH lane directly; dashi is not involved. It
executes `dsh --profile sessionbus` with `SESSIONBUS_LAUNCH_TOKEN` set in the
child environment and supplies no CLI task. The token selects lane mode, while
the installed `sessionbus` profile provides the resident base-only DSH app.
