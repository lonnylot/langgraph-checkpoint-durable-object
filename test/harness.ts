import { DurableObject } from "cloudflare:workers";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { DurableObjectCheckpointSaver } from "../src/index.js";

export interface Env {
  CHECKPOINT: DurableObjectNamespace<CheckpointHarness>;
}

/**
 * Test object. Production code constructs {@link DurableObjectCheckpointSaver}
 * the same way: in the constructor, from `ctx.storage`.
 */
export class CheckpointHarness extends DurableObject<Env> {
  readonly saver: DurableObjectCheckpointSaver;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.saver = new DurableObjectCheckpointSaver({ storage: ctx.storage });
  }

  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.saver.getTuple(config);
  }

  async list(config: RunnableConfig, options?: CheckpointListOptions): Promise<CheckpointTuple[]> {
    const tuples: CheckpointTuple[] = [];
    for await (const tuple of this.saver.list(config, options)) tuples.push(tuple);
    return tuples;
  }

  put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return this.saver.put(config, checkpoint, metadata, newVersions);
  }

  putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ): Promise<void> {
    return this.saver.putWrites(config, writes, taskId, taskPath);
  }

  deleteThread(threadId: string): Promise<void> {
    return this.saver.deleteThread(threadId);
  }
}

export default {
  fetch(): Response {
    return new Response("langgraph-checkpoint-durable-object tests");
  },
};
