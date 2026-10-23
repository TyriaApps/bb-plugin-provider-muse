import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcOutputMessage,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const previousExecutable = process.env.BB_MUSE_EXECUTABLE;
const previousApiKey = process.env.META_API_KEY;
const previousSessionStore = process.env.FAKE_MUSE_SESSION_STORE;
process.env.BB_MUSE_EXECUTABLE = join(fixtureDir, "fake-muse-serve.mjs");
process.env.META_API_KEY = "checkpoint-key";

const { handleLine } = await import("../src/provider-bridge.js");

const OPTIONS = {
  model: "muse-spark-1.3",
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} as const;

let harness: BridgeJsonRpcTestHarness;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-checkpoint-"));
  process.env.FAKE_MUSE_SESSION_STORE = join(workspaceDir, "sessions.json");
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(() => {
  harness.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

afterAll(() => {
  restore("BB_MUSE_EXECUTABLE", previousExecutable);
  restore("META_API_KEY", previousApiKey);
  restore("FAKE_MUSE_SESSION_STORE", previousSessionStore);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function deltas(messages: readonly BridgeJsonRpcOutputMessage[]): Record<
  string,
  unknown
>[] {
  return messages.flatMap((message) => {
    const params = (message as { params?: { deltas?: unknown } }).params;
    return Array.isArray(params?.deltas)
      ? (params.deltas as Record<string, unknown>[])
      : [];
  });
}

async function drainUntil(
  done: (seen: readonly Record<string, unknown>[]) => boolean,
): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await harness.flushWork();
    await new Promise((resolve) => setTimeout(resolve, 20));
    seen.push(...deltas(harness.takeMessages()));
    if (done(seen)) {
      return seen;
    }
  }
  return seen;
}

async function startTurn(args: {
  id: number;
  input: string;
  providerThreadId: string;
  threadId: string;
}): Promise<Record<string, unknown>[]> {
  harness.sendRequest(args.id, "turn/start", {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    clientRequestId: `creq_abcdefghi${String(args.id)}`,
    input: [{ type: "text", text: args.input, mentions: [] }],
    options: OPTIONS,
  });
  const response = await harness.waitForResponse(args.id);
  expect(response).toMatchObject({ result: {} });
  return drainUntil((seen) =>
    seen.some((delta) => delta.kind === "turn.boundary"),
  );
}

it("rebuilds a checkpoint fork without carrying later turns", async () => {
  harness.sendRequest(1, "initialize", {
    protocolVersion: 1,
    client: { name: "bb", version: "1" },
  });
  const initialized = await harness.waitForResponse(1);
  expect(initialized).toMatchObject({
    result: { capabilities: { fork: "checkpoint" } },
  });

  const sourceThreadId = `thr_${randomUUID().slice(0, 8)}`;
  harness.sendRequest(2, "thread/start", {
    threadId: sourceThreadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: OPTIONS,
  });
  const source = (await harness.waitForResponse(2)) as {
    result?: { providerThreadId?: string };
  };
  const sourceProviderThreadId = source.result?.providerThreadId ?? "";
  expect(sourceProviderThreadId, JSON.stringify(source)).not.toBe("");
  harness.takeMessages();

  const first = await startTurn({
    id: 3,
    input: "first message",
    providerThreadId: sourceProviderThreadId,
    threadId: sourceThreadId,
  });
  const checkpoint = first.find(
    (delta) => delta.kind === "turn.boundary",
  )?.providerCheckpointId;
  expect(checkpoint, JSON.stringify(first)).toEqual(expect.any(String));
  if (typeof checkpoint !== "string") {
    throw new Error("The first turn did not publish a Muse checkpoint");
  }

  await startTurn({
    id: 4,
    input: "later message that must be removed",
    providerThreadId: sourceProviderThreadId,
    threadId: sourceThreadId,
  });

  const forkThreadId = `thr_${randomUUID().slice(0, 8)}`;
  harness.sendRequest(5, "thread/fork", {
    threadId: forkThreadId,
    cwd: workspaceDir,
    sourceProviderThreadId,
    sourceProviderCheckpointId: checkpoint,
    instructionMode: "append",
    options: OPTIONS,
  });
  const forked = (await harness.waitForResponse(5)) as {
    result?: { providerThreadId?: string };
  };
  const forkProviderThreadId = forked.result?.providerThreadId ?? "";
  expect(forkProviderThreadId, JSON.stringify(forked)).not.toBe("");
  expect(forkProviderThreadId).not.toBe(sourceProviderThreadId);
  harness.takeMessages();

  const replacement = await startTurn({
    id: 6,
    input: "replacement message",
    providerThreadId: forkProviderThreadId,
    threadId: forkThreadId,
  });
  const rendered = JSON.stringify(replacement);
  expect(rendered).toContain("session_handoff");
  expect(rendered).toContain("first message");
  expect(rendered).toContain("replacement message");
  expect(rendered).not.toContain("later message that must be removed");
}, 45_000);
