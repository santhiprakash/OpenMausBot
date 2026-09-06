import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireDataDirLease,
  acquireDataDirLeaseForProcess,
} from "./data-dir-lease.mjs";

const MODULE_URL = new URL("./data-dir-lease.mjs", import.meta.url).href;
const LEASE_NAME = "openmausbot-server.lease";
const roots = [];

function temporaryDirectory(name = "data") {
  const root = mkdtempSync(path.join(tmpdir(), "omb-electron-lease-"));
  roots.push(root);
  const dataDir = path.join(root, name);
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir };
}

function delegationEntry(lease) {
  const entries = Object.entries(lease.utilityServerLeaseEnvironment());
  assert.equal(entries.length, 1);
  assert.match(entries[0][0], /INTERNAL.*LEASE/);
  assert.match(entries[0][1], /^v1:[1-9][0-9]*:[0-9a-f-]{36}$/);
  return entries[0];
}

function runNode(source, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function exitedPid() {
  const child = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return pid;
}

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an Electron parent delegates one child claim without releasing its own lease", async () => {
  const { dataDir } = temporaryDirectory();
  const parent = acquireDataDirLease(dataDir);
  const [environmentName, capability] = delegationEntry(parent);
  try {
    const result = await runNode(`
      const { acquireDataDirLeaseForProcess } = await import(${JSON.stringify(MODULE_URL)});
      const privateValue = process.env[${JSON.stringify(environmentName)}];
      const lease = acquireDataDirLeaseForProcess(${JSON.stringify(dataDir)});
      process.stdout.write(JSON.stringify({
        delegated: lease.delegated,
        ownerPid: lease.ownerPid,
        consumed: process.env[${JSON.stringify(environmentName)}] === undefined,
        retainedByValue: Object.values(process.env).includes(privateValue),
        released: lease.release(),
      }));
    `, parent.utilityServerLeaseEnvironment());
    assert.deepEqual(
      { code: result.code, signal: result.signal, stderr: result.stderr },
      { code: 0, signal: null, stderr: "" },
    );
    const output = JSON.parse(result.stdout);
    assert.equal(output.delegated, true);
    assert.notEqual(output.ownerPid, parent.ownerPid);
    assert.equal(output.consumed, true);
    assert.equal(output.retainedByValue, false);
    assert.equal(output.released, true);
    assert.equal(result.stdout.includes(capability), false);
    assert.throws(() => acquireDataDirLease(dataDir), /already using this data directory/i);
  } finally {
    parent.release();
  }
});

test("an invalid child capability fails closed without acquisition or secret logging", async () => {
  const parentDirectory = temporaryDirectory("parent");
  const otherDirectory = temporaryDirectory("other");
  const parent = acquireDataDirLease(parentDirectory.dataDir);
  const [environmentName, capability] = delegationEntry(parent);
  const replacement = capability.endsWith("0") ? "1" : "0";
  const invalidCapability = `${capability.slice(0, -1)}${replacement}`;
  try {
    const result = await runNode(`
      const { acquireDataDirLeaseForProcess } = await import(${JSON.stringify(MODULE_URL)});
      try {
        acquireDataDirLeaseForProcess(${JSON.stringify(otherDirectory.dataDir)});
        process.stdout.write(JSON.stringify({ acquired: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          error: String(error?.message ?? error),
          consumed: process.env[${JSON.stringify(environmentName)}] === undefined,
        }));
      }
    `, { [environmentName]: invalidCapability });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      error: "The OpenMausBot desktop lease delegation is invalid; refusing to start to protect its state.",
      consumed: true,
    });
    assert.equal(result.stdout.includes(invalidCapability), false);
    assert.equal(result.stderr.includes(invalidCapability), false);
    assert.equal(readFileSync(path.join(parentDirectory.dataDir, LEASE_NAME), "utf8").includes(capability), false);
    const standalone = acquireDataDirLease(otherDirectory.dataDir);
    assert.equal(standalone.release(), true);
  } finally {
    parent.release();
  }
});

test("a standalone contender cannot enter the same directory as the Electron parent", async () => {
  const { dataDir } = temporaryDirectory();
  const parent = acquireDataDirLease(dataDir);
  try {
    const result = await runNode(`
      const { acquireDataDirLeaseForProcess } = await import(${JSON.stringify(MODULE_URL)});
      try {
        acquireDataDirLeaseForProcess(${JSON.stringify(dataDir)}, {});
        process.stdout.write(JSON.stringify({ acquired: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    `);
    assert.equal(result.stderr, "");
    assert.match(JSON.parse(result.stdout).error, /already using this data directory/i);
  } finally {
    parent.release();
  }
});

test("fallback children serialize and recover a predecessor that exited without release", async () => {
  const { dataDir } = temporaryDirectory();
  const parent = acquireDataDirLease(dataDir);
  const childEnvironment = parent.utilityServerLeaseEnvironment();
  const [environmentName] = delegationEntry(parent);
  const holder = spawn(process.execPath, ["--input-type=module", "--eval", `
    const { acquireDataDirLeaseForProcess } = await import(${JSON.stringify(MODULE_URL)});
    acquireDataDirLeaseForProcess(${JSON.stringify(dataDir)});
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `], { env: { ...process.env, ...childEnvironment }, stdio: ["ignore", "pipe", "pipe"] });
  holder.stdout.setEncoding("utf8");
  try {
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", (chunk) => chunk.includes("ready") ? resolve() : reject(new Error(String(chunk))));
    });
    assert.throws(
      () => parent.release(),
      /previous server process .* still shutting down/i,
    );

    const blocked = await runNode(`
      const { acquireDataDirLeaseForProcess } = await import(${JSON.stringify(MODULE_URL)});
      try {
        acquireDataDirLeaseForProcess(${JSON.stringify(dataDir)});
        process.stdout.write(JSON.stringify({ acquired: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    `, childEnvironment);
    assert.match(JSON.parse(blocked.stdout).error, /already using this data directory/i);

    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("close", resolve));

    const replacement = await runNode(`
      const { acquireDataDirLeaseForProcess } = await import(${JSON.stringify(MODULE_URL)});
      const lease = acquireDataDirLeaseForProcess(${JSON.stringify(dataDir)});
      process.stdout.write(JSON.stringify({
        delegated: lease.delegated,
        consumed: process.env[${JSON.stringify(environmentName)}] === undefined,
        released: lease.release(),
      }));
    `, childEnvironment);
    assert.deepEqual(JSON.parse(replacement.stdout), { delegated: true, consumed: true, released: true });
    assert.equal(replacement.stderr, "");
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    parent.release();
  }
});

test("a new parent refuses to pass an orphaned live delegated child", async () => {
  const { dataDir } = temporaryDirectory();
  const parent = acquireDataDirLease(dataDir);
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    const { acquireDataDirLeaseForProcess } = await import(${JSON.stringify(MODULE_URL)});
    acquireDataDirLeaseForProcess(${JSON.stringify(dataDir)});
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `], { env: { ...process.env, ...parent.utilityServerLeaseEnvironment() }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => chunk.includes("ready") ? resolve() : reject(new Error(String(chunk))));
    });
    // Simulate hard parent death: the primary record is complete but its pid
    // is dead, while the subordinate child remains live.
    const primaryPath = path.join(dataDir, LEASE_NAME);
    const stored = JSON.parse(readFileSync(primaryPath, "utf8"));
    stored.pid = await exitedPid();
    rmSync(primaryPath);
    writeFileSync(primaryPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

    assert.throws(
      () => acquireDataDirLease(dataDir),
      /previous server process .* still shutting down/i,
    );
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    // The original handle no longer matches the simulated dead owner. A fresh
    // claimant safely retires both stale records and performs final cleanup.
    const recovered = acquireDataDirLease(dataDir);
    recovered.release();
  }
});

test("a crashed stale-lease reaper can be succeeded without concurrent ownership", async () => {
  const { dataDir } = temporaryDirectory();
  const deadOwnerPid = await exitedPid();
  const deadReaperPid = await exitedPid();
  const ownerToken = randomUUID();
  const reaperToken = randomUUID();
  const leasePath = path.join(dataDir, LEASE_NAME);
  const owner = {
    version: 1,
    pid: deadOwnerPid,
    host: hostname(),
    token: ownerToken,
    createdAt: Date.now() - 2_000,
  };
  const reaper = {
    version: 1,
    pid: deadReaperPid,
    host: hostname(),
    token: reaperToken,
    createdAt: Date.now() - 1_000,
    targetToken: ownerToken,
  };
  writeFileSync(leasePath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  writeFileSync(`${leasePath}.reap-${ownerToken}`, `${JSON.stringify(reaper)}\n`, { mode: 0o600 });

  const lease = acquireDataDirLease(dataDir);
  try {
    assert.equal(lease.ownerPid, process.pid);
    const successor = createHash("sha256").update(reaperToken).digest("hex").slice(0, 32);
    const record = JSON.parse(readFileSync(`${leasePath}.reap-${ownerToken}-${successor}`, "utf8"));
    assert.equal(record.targetToken, ownerToken);
    assert.equal(record.pid, process.pid);
  } finally {
    lease.release();
  }
});

test("a foreign-host owner fails closed and identifies the preserved lease record", async () => {
  const { dataDir } = temporaryDirectory();
  const leasePath = path.join(dataDir, LEASE_NAME);
  const owner = {
    version: 1,
    pid: await exitedPid(),
    host: hostname() === "other-host.example" ? "another-host.example" : "other-host.example",
    token: randomUUID(),
    createdAt: Date.now(),
  };
  writeFileSync(leasePath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });

  assert.throws(
    () => acquireDataDirLease(dataDir),
    (error) => {
      assert.match(error.message, /owned by a process on another machine/i);
      assert.ok(error.message.includes(JSON.stringify(leasePath)));
      return true;
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(leasePath, "utf8")), owner);
});

test("a foreign-host delegated child fails closed and identifies its preserved lease record", () => {
  const { dataDir } = temporaryDirectory();
  const childLeasePath = path.join(dataDir, ".openmausbot-server-child", LEASE_NAME);
  const child = {
    version: 1,
    pid: process.pid,
    host: hostname() === "other-host.example" ? "another-host.example" : "other-host.example",
    token: randomUUID(),
    createdAt: Date.now(),
  };
  mkdirSync(path.dirname(childLeasePath), { recursive: true });
  writeFileSync(childLeasePath, `${JSON.stringify(child)}\n`, { mode: 0o600 });

  assert.throws(
    () => acquireDataDirLease(dataDir),
    (error) => {
      assert.match(error.message, /delegated server on another machine/i);
      assert.ok(error.message.includes(JSON.stringify(childLeasePath)));
      return true;
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(childLeasePath, "utf8")), child);
  assert.throws(() => readFileSync(path.join(dataDir, LEASE_NAME), "utf8"), /ENOENT/);
});

test("a foreign-host reaper fails closed and identifies its preserved recovery record", async () => {
  const { dataDir } = temporaryDirectory();
  const leasePath = path.join(dataDir, LEASE_NAME);
  const ownerToken = randomUUID();
  const owner = {
    version: 1,
    pid: await exitedPid(),
    host: hostname(),
    token: ownerToken,
    createdAt: Date.now() - 2_000,
  };
  const reaperPath = `${leasePath}.reap-${ownerToken}`;
  const reaper = {
    version: 1,
    pid: process.pid,
    host: hostname() === "other-host.example" ? "another-host.example" : "other-host.example",
    token: randomUUID(),
    createdAt: Date.now() - 1_000,
    targetToken: ownerToken,
  };
  writeFileSync(leasePath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  writeFileSync(reaperPath, `${JSON.stringify(reaper)}\n`, { mode: 0o600 });

  assert.throws(
    () => acquireDataDirLease(dataDir),
    (error) => {
      assert.match(error.message, /recovered on another machine/i);
      assert.ok(error.message.includes(JSON.stringify(reaperPath)));
      return true;
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(leasePath, "utf8")), owner);
  assert.deepEqual(JSON.parse(readFileSync(reaperPath, "utf8")), reaper);
});

test("legacy data is moved before lease creation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-electron-legacy-"));
  roots.push(root);
  const legacyDataDir = path.join(root, ".opengrokbot");
  const dataDir = path.join(root, ".openmausbot");
  mkdirSync(legacyDataDir);
  writeFileSync(path.join(legacyDataDir, "keep-me.txt"), "kept");

  const lease = acquireDataDirLease(dataDir, { legacyDataDir });
  try {
    assert.equal(readFileSync(path.join(dataDir, "keep-me.txt"), "utf8"), "kept");
    assert.throws(() => readFileSync(path.join(legacyDataDir, "keep-me.txt")), /ENOENT/);
  } finally {
    lease.release();
  }
});

test("process entry API remains compatible with a standalone server", () => {
  const { dataDir } = temporaryDirectory();
  const environment = {};
  const lease = acquireDataDirLeaseForProcess(dataDir, environment);
  assert.equal(lease.delegated, false);
  assert.equal(lease.ownerPid, process.pid);
  assert.equal(lease.release(), true);
});
