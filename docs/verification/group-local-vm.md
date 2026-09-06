# Group and Goal Local VM routing

Related: #430. This change gives a room member its configured Local VM; it does
not create a room-owned desktop or a room Computer panel.

`runGroupMemberTurn` now mounts the speaking bot's computer MCP and prompt after
claiming the same target-scoped lease used by direct turns. Setup cancellation
and terminal cleanup release the lease; timed-out or stalled providers retain
the existing busy-owner protection rather than handing a live desktop away.

## Opt-in isolated acceptance

Prepare the managed desktop image on an explicitly selected Podman test machine.
Build the renderer (`node node_modules/vite/bin/vite.js build`), set
`OMB_VERIFY_PODMAN` to the executable and `OMB_VERIFY_MACHINE` to that connection,
then run:

```sh
node --experimental-strip-types scripts/verify-group-vm.ts
```

The launcher creates a temporary home, data directory, explicit loopback server
and fake Claude engine. It grants that fixture access to the selected engine,
creates only fixture-specific desktop targets and removes them afterward.
Do not substitute a live application URL or data directory. The JSON receipt
records the exact MCP target for each speaker and the computer-off case.

2026-09-06 on Windows/WSL2, rootless Podman 5.8.3:

- Two Goal speakers received different matching desktop targets and settled.
- A speaker switched to `computer: off` received no computer MCP.
- Related Goal, lease and fixture-launcher tests: 31 passed.
- Server TypeScript checking and server bundling passed.

This fake-engine fixture proves routing, not model-driven clicks or screen
streaming. Firefox sandbox compatibility and Japanese guest fonts are separate
changes. The full repository test suite was not repeated for this change.
