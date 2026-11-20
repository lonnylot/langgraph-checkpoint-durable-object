import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import {
  validate,
  type CheckpointSaverTestInitializer,
} from "@langchain/langgraph-checkpoint-validation";
import { stub } from "./helpers.js";
import type { CheckpointHarness } from "./harness.js";

/**
 * The official suite calls the saver from the test isolate. SQL still runs
 * inside the Durable Object: this subclass forwards each call over RPC.
 */
class RemoteDurableObjectSaver extends BaseCheckpointSaver {
  constructor(private readonly object: DurableObjectStub<CheckpointHarness>) {
    super();
  }

  override getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.object.getTuple(config);
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    // The RPC type for an array of checkpoint tuples collapses to `never`
    // because channel values are `unknown`. The runtime still returns the rows.
    const listed = await Promise.resolve(this.object.list(config, options));
    const tuples = listed as CheckpointTuple[];
    for (const tuple of tuples) yield tuple;
  }

  override put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return this.object.put(config, checkpoint, metadata, newVersions);
  }

  override putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    return this.object.putWrites(config, writes, taskId, taskPath ?? "");
  }

  override deleteThread(threadId: string): Promise<void> {
    return this.object.deleteThread(threadId);
  }
}

const initializer: CheckpointSaverTestInitializer<RemoteDurableObjectSaver> = {
  checkpointerName: "DurableObjectCheckpointSaver",
  createCheckpointer(): RemoteDurableObjectSaver {
    return new RemoteDurableObjectSaver(stub(`validation-${crypto.randomUUID()}`));
  },
};

validate(initializer);
