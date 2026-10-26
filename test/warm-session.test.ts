import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";

it("reuses recent released sessions and only rebuilds the oldest idle child", async () => {
  const previous = { executable: process.env.BB_MUSE_EXECUTABLE, key: process.env.META_API_KEY, capacity: process.env.BB_MUSE_MAX_IDLE_RUNTIMES };
  process.env.BB_MUSE_EXECUTABLE = join(dirname(fileURLToPath(import.meta.url)), "fake-muse-serve.mjs");
  process.env.META_API_KEY = "warm-session-test";
  process.env.BB_MUSE_MAX_IDLE_RUNTIMES = "2";
  const { handleLine } = await import("../src/provider-bridge.js");
  const harness = createHarness(handleLine);
  const cwd = mkdtempSync(join(tmpdir(), "bb-muse-warm-"));
  const options = { model: "muse-spark-1.3", permissionMode: "auto", permissionScope: "workspace", approvalReviewer: "automatic", permissionEscalation: "ask" };
  const sessions = new Map<string, string>();
  let id = 0;
  async function request(method: string, params: Parameters<typeof harness.sendRequest>[2]) {
    const requestId = ++id;
    harness.sendRequest(requestId, method, params);
    return await harness.waitForResponse(requestId);
  }
  try {
    await request("initialize", { protocolVersion: 1, client: { name: "bb", version: "test" } });
    for (const threadId of ["warm-first", "warm-second", "warm-third", "still-attached"]) {
      const response = await request("thread/start", { threadId, cwd, instructionMode: "append", options });
      const result = response as { result?: { providerThreadId?: string } };
      expect(result.result?.providerThreadId).toBeTruthy();
      sessions.set(threadId, result.result!.providerThreadId!);
      if (threadId !== "still-attached") {
        const released = await request("thread/stop", { threadId, providerThreadId: sessions.get(threadId)!, intent: "release", activeTurnId: null });
        expect(released).toHaveProperty("result");
      }
    }
    process.env.BB_MUSE_EXECUTABLE = join(cwd, "missing-muse");
    for (const threadId of ["warm-second", "warm-third", "still-attached"]) {
      const response = await request("thread/resume", { threadId, cwd, providerThreadId: sessions.get(threadId)!, instructionMode: "append", options });
      expect(response).toHaveProperty("result.providerThreadId", sessions.get(threadId));
    }
    const evicted = await request("thread/resume", { threadId: "warm-first", cwd, providerThreadId: sessions.get("warm-first")!, instructionMode: "append", options });
    expect(evicted).toHaveProperty("error");
  } finally {
    for (const threadId of sessions.keys()) await request("thread/discard", { threadId, providerThreadId: sessions.get(threadId)! });
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ BB_MUSE_EXECUTABLE: previous.executable, META_API_KEY: previous.key, BB_MUSE_MAX_IDLE_RUNTIMES: previous.capacity })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
