import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as capture,
  experimental_assembleCapturedThreadEvents as assemble,
  type CapturedBridgeNotification,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "../src/provider-bridge.js";

it.skipIf(process.env.BB_MUSE_TIMING !== "1")(
  "does not run reminder agents after a Muse answer",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bb-muse-timing-"));
    const output = capture();
    const transcript: CapturedBridgeNotification[] = [];
    const timed: { at: number; message: CapturedBridgeNotification }[] = [];
    const send = (id: number, method: string, params: unknown) =>
      handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const drain = async (done: () => boolean) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const messages = output.takeMessages();
        transcript.push(...messages);
        timed.push(...messages.map((message) => ({ at: Date.now(), message })));
        if (done()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "Live Muse timing request did not finish within two minutes",
      );
    };
    const reply = (id: number) =>
      transcript.find((message) => (message as { id?: number }).id === id) as
        | { result?: { providerThreadId: string }; error?: unknown }
        | undefined;
    const options = {
      model: "muse-spark-1.3",
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
      providerOptions: {},
    };
    try {
      send(1, "initialize", {
        protocolVersion: 2,
        client: { name: "bb", version: "timing" },
        grammarVersions: [3, 3],
      });
      await drain(() => !!reply(1));
      send(2, "thread/start", {
        threadId: "timing-thread",
        cwd,
        instructionMode: "append",
        options,
      });
      await drain(() => !!reply(2));
      expect(reply(2)?.error).toBeUndefined();
      const providerThreadId = reply(2)?.result?.providerThreadId;
      expect(providerThreadId).toEqual(expect.any(String));
      const measurements: unknown[] = [];
      for (const [index, reasoningLevel] of [
        "medium",
        "xhigh",
        "medium",
        "xhigh",
      ].entries()) {
        const start = Date.now();
        const offset = timed.length;
        send(index + 3, "turn/start", {
          threadId: "timing-thread",
          providerThreadId,
          clientRequestId: `creq_23456789a${index + 2}`,
          input: [
            {
              type: "text",
              text: "Reply with exactly TIMING_OK. Do not use tools or modify files.",
              mentions: [],
            },
          ],
          options: { ...options, reasoningLevel },
        });
        await drain(() => !!reply(index + 3));
        expect(reply(index + 3)?.error).toBeUndefined();
        await drain(
          () =>
            assemble(transcript, "timing-thread").filter(
              (event) => event.type === "turn/completed",
            ).length > index,
        );
        const events = assemble(transcript, "timing-thread");
        expect(
          events.filter((event) => event.type === "turn/input/accepted"),
        ).toHaveLength(index + 1);
        const checks = timed.slice(offset).flatMap(({ at, message }) => {
          const deltas =
            (
              message as {
                params?: {
                  deltas?: {
                    kind: string;
                    item?: { tool?: string; args?: unknown };
                  }[];
                };
              }
            ).params?.deltas ?? [];
          return deltas
            .filter(
              (delta) =>
                delta.kind === "item.open" &&
                delta.item?.tool === "muse.reminder_checks",
            )
            .map((delta) => ({ at, agents: delta.item?.args }));
        });
        expect(checks).toHaveLength(0);
        measurements.push({
          reasoningLevel,
          totalMs: Date.now() - start,
          foregroundMs: checks[0] ? checks[0].at - start : null,
          reminderMs: checks[0] ? Date.now() - checks[0].at : null,
          blockingAgents: checks[0]?.agents,
        });
        console.info("Muse timing sample", JSON.stringify(measurements.at(-1)));
      }
      console.info("Muse timing measurements", JSON.stringify(measurements));
      send(9, "thread/stop", {
        threadId: "timing-thread",
        providerThreadId,
        intent: "release",
        activeTurnId: null,
      });
      await drain(() => !!reply(9));
    } finally {
      output.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  540_000,
);
