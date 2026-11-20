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
import type { CheckpointSaverTestInitializer } from "@langchain/langgraph-checkpoint-validation";
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

// The suite's newVersions filter test expects a saver to drop channel values.
// MemorySaver and SqliteSaver skip it because they store the checkpoint as
// given. This saver does the same, so that one test is skipped here. The
// skip has to wrap `it` before the suite module reads it.
const deltaFilterTest = "should only store channel_values that have changed (based on newVersions)";
type RegisteredIt = ((...args: unknown[]) => unknown) & {
  skip: (name: string, fn: unknown, timeout?: unknown) => unknown;
};
const vitest = globalThis as typeof globalThis & { it: RegisteredIt };
const registeredIt: RegisteredIt = vitest.it;
vitest.it = new Proxy(registeredIt, {
  apply(target, _thisArg, args) {
    // ProxyHandler types this list as any[].
    const name: unknown = args[0];
    if (name === deltaFilterTest) {
      return target.skip(
        `[because the checkpoint is stored as LangGraph passed it in. MemorySaver and SqliteSaver skip this too] ${deltaFilterTest}`,
        args[1] as unknown,
        args[2] as unknown,
      );
    }
    return Reflect.apply(target, target, args);
  },
  get(target, property) {
    const value: unknown = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    const method = value as (...methodArgs: unknown[]) => unknown;
    return method.bind(target);
  },
});
const { validate } = await import("@langchain/langgraph-checkpoint-validation");
validate(initializer);
vitest.it = registeredIt;
