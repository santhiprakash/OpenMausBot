# Firefox sandbox in Podman Local VMs

Fixes #853. Podman's default seccomp policy gates `chroot` on `SYS_CHROOT`;
Firefox uses this syscall while establishing its own Linux sandbox. Managed
Podman desktops now retain that capability alongside `SETUID` and `SETGID`.
Effective and bounding capability validation requires the same exact set.
Docker and VPS policies remain unchanged.

Existing Podman desktops with the old capability set require recreation through
the normal Local VM lifecycle. Retain the workspace bind mount; do not delete
user files or silently recreate a busy desktop. Privileged mode and unconfined
security profiles are not required or accepted by this repair.

## Isolated before/after acceptance

Set `OMB_VERIFY_PODMAN` and `OMB_VERIFY_MACHINE` explicitly, with the managed
image already prepared on that test engine, then run:

```sh
node --experimental-strip-types scripts/verify-podman-firefox.ts
```

The script creates disposable desktops and engine-host temporary workspaces.
It compares identical generated arguments with and without `SYS_CHROOT`, runs
Firefox headlessly with a fresh profile, validates PNG bytes and cleans up only
the containers and workspaces it created. Logs and receipt remain under
`.omb-scratch/firefox` (override with `OMB_VERIFY_OUTPUT`).

2026-09-06: Windows/WSL2 Linux x86_64, rootless Podman 5.8.3, managed driver
0.20.0-v4 image. Baseline: `chroot: EPERM`, timeout exit 124, no PNG. Patched:
Firefox exit 0, valid PNG, no `chroot: EPERM`. Browser sandbox remained enabled.
Related container/VPS tests: 64 passed; server TypeScript checking passed.

This is browser startup/rendering evidence, not an interactive-input test.
Native Linux, ARM64, SELinux enforcing and other runtime versions were not
certified by this run; the full repository suite was not repeated.
