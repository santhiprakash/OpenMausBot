import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { killCliTree, spawnCli } from "../procs.ts";
import { AntigravityAcpClient, validateAntigravityRuntime } from "./antigravity-acp.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

const scratch = vi.hoisted(() => [] as string[]);
vi.mock("../procs.ts", () => ({ spawnCli: vi.fn(), killCliTree: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rm: vi.fn(fs.rm),
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      const directory = await fs.mkdtemp(...args);
      scratch.push(String(directory));
      return directory;
    },
  };
});
const realRm = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm;

const runtime: AntigravityRuntime = {
  executablePath: "/fixture/antigravity",
  harnessPath: "/fixture/harness",
  source: "managed",
  version: "1.1.1",
};
const initialized = {
  protocolVersion: 1,
  agentInfo: { name: "antigravity-acp", version: "1.1.1" },
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
  authMethods: [{ id: "oauth-personal" }],
};

function fakeChild(reply: object | null = { result: initialized }) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  child.stdin.on("data", (line) => {
    if (reply === null) return;
    const request = JSON.parse(String(line));
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`);
  });
  vi.mocked(spawnCli).mockReturnValue(child as unknown as ReturnType<typeof spawnCli>);
  return child;
}

function client() {
  return new AntigravityAcpClient(runtime, { directory: "/fixture", tokenPath: "/fixture/token", environment: {} }, "/fixture");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(spawnCli).mockReset();
  vi.mocked(killCliTree).mockReset();
  vi.mocked(rm).mockReset().mockImplementation(realRm);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Only mocked processes use these test profiles; no child is alive here.
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Antigravity validation shutdown", () => {
  it.each(["kill EPERM", "spawn ENOENT"])("does not treat %s as close", async (message) => {
    const child = fakeChild(null);
    const acp = client();
    let exited = false;
    void acp.exited.then(() => { exited = true; });
    const rejected = expect(acp.initialize()).rejects.toThrow(message);
    child.emit("error", new Error(message));
    await rejected;
    expect(exited).toBe(false);

    const stopping = acp.closeAndWait(100);
    await vi.advanceTimersByTimeAsync(99);
    expect(exited).toBe(false);
    child.emit("close", message.startsWith("spawn") ? -2 : 0);
    await expect(stopping).resolves.toBe(true);
    expect(exited).toBe(true);
    expect(killCliTree).toHaveBeenCalledWith(child);
  });

  it("times out without close and still observes a later close", async () => {
    const child = fakeChild();
    const acp = client();
    const stopping = acp.closeAndWait(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).resolves.toBe(false);
    child.emit("close", 0);
    await expect(acp.closeAndWait(100)).resolves.toBe(true);
    expect(killCliTree).toHaveBeenCalledTimes(1);
  });

  it("rejects a validated runtime that does not stop, leaving its profile intact", async () => {
    fakeChild();
    let killed!: () => void;
    const stopping = new Promise<void>((resolve) => { killed = resolve; });
    vi.mocked(killCliTree).mockImplementation(killed);
    const validation = validateAntigravityRuntime(runtime, "1.1.1");
    const rejected = expect(validation).rejects.toThrow("did not shut down");
    await stopping;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(rm).not.toHaveBeenCalled();
    expect(existsSync(scratch[0])).toBe(true);
  });

  it.each([
    { reply: { error: { message: "initialize failed" } }, error: "initialize failed" },
    { reply: { result: {} }, error: "did not identify" },
  ])("preserves $error when shutdown times out", async ({ reply, error }) => {
    fakeChild(reply);
    let killed!: () => void;
    const stopping = new Promise<void>((resolve) => { killed = resolve; });
    vi.mocked(killCliTree).mockImplementation(killed);
    const rejected = expect(validateAntigravityRuntime(runtime, "1.1.1")).rejects.toThrow(error);
    await stopping;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(rm).not.toHaveBeenCalled();
    expect(existsSync(scratch[0])).toBe(true);
  });

  it.each([
    { reply: { error: { message: "initialize failed" } }, error: "initialize failed" },
    { reply: { result: {} }, error: "did not identify" },
  ])("preserves $error when profile cleanup fails after close", async ({ reply, error }) => {
    const child = fakeChild(reply);
    vi.mocked(killCliTree).mockImplementation(() => { child.emit("close", 0); });
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error("cleanup EPERM"), { code: "EPERM" }));
    await expect(validateAntigravityRuntime(runtime, "1.1.1")).rejects.toThrow(error);
    expect(rm).toHaveBeenCalledWith(scratch[0], { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup EPERM"));
  });

  it("keeps successful validation when profile cleanup remains locked after close", async () => {
    const child = fakeChild();
    vi.mocked(killCliTree).mockImplementation(() => { child.emit("close", 0); });
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error("cleanup EPERM"), { code: "EPERM" }));
    await expect(validateAntigravityRuntime(runtime, "1.1.1")).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledWith(scratch[0], { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`verification profile ${scratch[0]}: cleanup EPERM`));
  });
});
