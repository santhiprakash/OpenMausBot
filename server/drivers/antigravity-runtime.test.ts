import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { retryOnWindowsFileLock, sweepStaleStaging, transientWindowsFileError } from "./antigravity-runtime.ts";

const withCode = (code: string) => Object.assign(new Error(code), { code });
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

describe("installing the Antigravity runtime on Windows", () => {
  it("knows the refusals Windows gives for a file something still holds open", () => {
    for (const code of ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]) expect(transientWindowsFileError(withCode(code)), code).toBe(true);
    expect(transientWindowsFileError(withCode("ENOENT"))).toBe(false);
    expect(transientWindowsFileError(new Error("plain"))).toBe(false);
    expect(transientWindowsFileError(null)).toBe(false);
  });

  it("retries a rename that Windows refuses while the runtime is still exiting, with growing delays", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retryOnWindowsFileLock(
      async () => {
        calls += 1;
        if (calls < 3) throw withCode("EPERM");
        return "renamed";
      },
      { sleep: async (ms) => { delays.push(ms); } },
    );
    expect(result).toBe("renamed");
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it("gives up after the attempts with the original error, and never retries other errors", async () => {
    let calls = 0;
    await expect(retryOnWindowsFileLock(async () => {
      calls += 1;
      throw withCode("EBUSY");
    }, { attempts: 4, sleep: async () => {} })).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(4);

    calls = 0;
    await expect(retryOnWindowsFileLock(async () => {
      calls += 1;
      throw withCode("ENOENT");
    }, { sleep: async () => {} })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("caps the delay at two seconds so a long lock does not turn into a long wait per attempt", async () => {
    const delays: number[] = [];
    await expect(retryOnWindowsFileLock(async () => {
      throw withCode("EPERM");
    }, { attempts: 8, sleep: async (ms) => { delays.push(ms); } })).rejects.toMatchObject({ code: "EPERM" });
    expect(delays).toEqual([250, 500, 1000, 2000, 2000, 2000, 2000]);
  });

  it("sweeps leftover .install- folders from earlier attempts and nothing else", async () => {
    const versions = mkdtempSync(join(tmpdir(), "omb-antigravity-versions-"));
    scratch.push(versions);
    mkdirSync(join(versions, ".install-old-1", "runtime"), { recursive: true });
    writeFileSync(join(versions, ".install-old-1", "runtime", "agy_acp_server.exe"), "x");
    mkdirSync(join(versions, ".install-old-2"));
    mkdirSync(join(versions, "abc123"));
    writeFileSync(join(versions, "abc123", ".install-complete.json"), "{}");
    const removed = await sweepStaleStaging(versions);
    expect(removed).toBe(2);
    expect(existsSync(join(versions, ".install-old-1"))).toBe(false);
    expect(existsSync(join(versions, ".install-old-2"))).toBe(false);
    expect(existsSync(join(versions, "abc123", ".install-complete.json"))).toBe(true);
    expect(await sweepStaleStaging(join(versions, "does-not-exist"))).toBe(0);
  });
});
