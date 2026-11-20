import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { DurableObjectCheckpointSaver } from "../src/index.js";
import type { CheckpointHarness } from "./harness.js";

let sequence = 0;

export function objectName(label: string): string {
  sequence += 1;
  return `${label}-${sequence}-${crypto.randomUUID()}`;
}

function objects(): DurableObjectNamespace<CheckpointHarness> {
  return env.CHECKPOINT;
}

export function stub(name: string): DurableObjectStub<CheckpointHarness> {
  return objects().get(objects().idFromName(name));
}

export async function withSaver<T>(
  name: string,
  run: (saver: DurableObjectCheckpointSaver, state: DurableObjectState) => Promise<T>,
): Promise<T> {
  return runInDurableObject(stub(name), async (_instance, state) => {
    const saver = new DurableObjectCheckpointSaver({ storage: state.storage });
    return run(saver, state);
  });
}

export function checkpoint(id: string, values: Record<string, unknown> = {}): Checkpoint {
  return {
    v: 4,
    id,
    ts: "2026-11-20T00:00:00.000Z",
    channel_values: values,
    channel_versions: { __start__: 1 },
    versions_seen: { __input__: {} },
  };
}

export function metadata(extra: Record<string, unknown> = {}): CheckpointMetadata {
  return { source: "loop", step: 1, parents: {}, ...extra };
}

export function config(threadId: string, checkpointNs = "", checkpointId?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    },
  };
}

/** Lexicographically ordered checkpoint ids. `0002` sorts after `0001`. */
export function versions(values: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.keys(values).map((key) => [key, 1]));
}

export function nextId(counter: number): string {
  return `cp-${String(counter).padStart(4, "0")}`;
}
