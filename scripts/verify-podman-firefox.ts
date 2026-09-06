// Opt-in acceptance against disposable containers only. No app or provider data.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const podman = process.env.OMB_VERIFY_PODMAN;
const machine = process.env.OMB_VERIFY_MACHINE;
if (!podman || !machine) throw new Error("Set OMB_VERIFY_PODMAN and OMB_VERIFY_MACHINE to an explicit test engine");
const output = resolve(process.env.OMB_VERIFY_OUTPUT || ".omb-scratch/firefox");
mkdirSync(output, { recursive: true });
process.env.OMB_DATA_DIR = resolve(output, "app-data");
const { containerRunArgs, perBotLocalVmTarget, IMAGE } = await import("../server/container-computer.ts");
const run = (args: string[]) => execFileSync(podman, ["--connection", machine, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const receipt = [];
for (const mode of ["before", "after"] as const) {
  const workspace = execFileSync(podman, ["machine", "ssh", machine, "mktemp", "-d", "/tmp/omb-firefox-XXXXXXXX"], { encoding: "utf8" }).trim();
  assert.match(workspace, /^\/tmp\/omb-firefox-[A-Za-z0-9]+$/);
  const target = { ...perBotLocalVmTarget(randomUUID()), workspaceDir: workspace };
  const args = containerRunArgs("podman", randomUUID(), target);
  if (mode === "before") {
    const cap = args.indexOf("SYS_CHROOT");
    assert.equal(args[cap - 1], "--cap-add");
    args.splice(cap - 1, 2);
  }
  let created = false;
  try {
    run(args);
    created = true;
    const script = "timeout 30 firefox-esr --headless --no-remote --profile /tmp/firefox-proof-profile --screenshot /tmp/firefox-proof.png about:blank";
    run(["exec", "--user", "cua", target.containerName, "mkdir", "-p", "/tmp/firefox-proof-profile"]);
    const probe = spawnSync(podman, ["--connection", machine, "exec", "--user", "cua", target.containerName, "sh", "-c", script], { encoding: "utf8", timeout: 45_000 });
    const log = `${probe.stdout || ""}\n${probe.stderr || ""}`;
    writeFileSync(resolve(output, `${mode}.log`), log);
    const screenshot = spawnSync(podman, ["--connection", machine, "exec", target.containerName, "cat", "/tmp/firefox-proof.png"], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    const png = screenshot.status === 0 && screenshot.stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mode === "before") {
      assert(!png, "Baseline unexpectedly renders: investigate before claiming reproduction");
      assert.match(log, /chroot.*EPERM/);
    } else {
      assert.equal(probe.status, 0, log);
      assert(png, "Patched Firefox must generate an actual PNG with sandbox enabled");
      writeFileSync(resolve(output, "after.png"), screenshot.stdout);
    }
    receipt.push({ mode, image: IMAGE, target: target.containerName, firefoxExit: probe.status, png, chrootEperm: /chroot.*EPERM/.test(log) });
    console.log(JSON.stringify(receipt.at(-1)));
  } finally {
    if (created) run(["rm", "-f", target.containerName]);
    // Only the literal mktemp result validated above, never an app workspace.
    execFileSync(podman, ["machine", "ssh", machine, "rm", "-rf", "--", workspace]);
  }
}
writeFileSync(resolve(output, "receipt.json"), JSON.stringify({ passed: true, receipt }, null, 2));
