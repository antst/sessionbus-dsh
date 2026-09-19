# Lane without a TUI

The Sessionbus daemon starts a DSH lane directly; dashi is not involved. Its
`sessionbus-dsh` product command executes the package-owned `sessionbus-dsh` bin
with `SESSIONBUS_LAUNCH_TOKEN` set and supplies no CLI task. The bin selects
`dsh --profile sessionbus`; the profile's `product: sessionbus-dsh` row identifies
the launched product and its resident base-only DSH app.
