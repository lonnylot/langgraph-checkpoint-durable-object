import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  maxChannelVersion,
  writesSortKey,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { toBytes } from "./bytes.js";
import { dumpTyped, loadTyped } from "./serde.js";
import {
  CheckpointRepository,
  type CheckpointRecord,
  type WriteInsert,
  type WriteRecord,
} from "./repository.js";
import {
  assertInlineByteLimit,
  DEFAULT_INLINE_BYTE_LIMIT,
  migrateSchema,
  readSchemaVersion,
  resolveTableNames,
} from "./schema.js";
import type { DurableObjectCheckpointSaverOptions, TableNames } from "./types.js";

/**
 * LangGraph.js checkpoint saver for Cloudflare Durable Object SQLite.
 *
 * ## Concurrency
 *
 * A Durable Object runs JavaScript on one thread, but every `await` opens the
 * input gate. Another request, including `deleteThread`, can run while a call
 * is waiting. Storage writes that run with no `await` between them are atomic.
 *
 * `put`, `putWrites`, and `deleteThread` therefore do their async work first
 * (serde only; it does not touch storage) and then apply every SQL statement
 * for that call inside one `transactionSync` callback. A concurrent
 * `deleteThread` cannot delete some rows of a `putWrites` batch and leave the
 * rest. It runs entirely before that transaction, or entirely after it commits.
 *
 * Serialization itself is not inside the transaction. A `deleteThread` that
 * starts while `put` is still serializing finishes first, and the `put` then
 * inserts. That is last writer wins, not a torn write. This saver does not
 * hold `blockConcurrencyWhile` across serde, because that would stall every
 * other request on the object for the duration of serialization.
 */
export class DurableObjectCheckpointSaver extends BaseCheckpointSaver {
  readonly #storage: DurableObjectCheckpointSaverOptions["storage"];
  readonly #names: TableNames;
  readonly #inlineByteLimit: number;
  readonly #repo: CheckpointRepository;

  constructor(options: DurableObjectCheckpointSaverOptions) {
    super(options.serde);
    this.#storage = options.storage;
    this.#names = resolveTableNames(options.tablePrefix);
    this.#inlineByteLimit = assertInlineByteLimit(
      options.inlineByteLimit ?? DEFAULT_INLINE_BYTE_LIMIT,
    );
    this.#repo = new CheckpointRepository(this.#storage, this.#names, this.#inlineByteLimit);
    this.setup();
  }

  /** Create or upgrade tables. Idempotent. The constructor calls this. */
  setup(): void {
    migrateSchema(this.#storage, this.#names);
  }

  /** Stored schema version, or 0 before `setup()`. */
  schemaVersion(): number {
    return readSchemaVersion(this.#storage, this.#names);
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const configurable = readConfigurable(config);
    const threadId = optionalString(configurable.thread_id);
    if (!threadId) return undefined;
    const checkpointNs = optionalString(configurable.checkpoint_ns) ?? "";
    const checkpointId = optionalString(configurable.checkpoint_id);
    const row = this.#repo.getCheckpoint(threadId, checkpointNs, checkpointId);
    if (!row) return undefined;
    return this.#tupleFrom(row, config, checkpointId !== undefined);
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const configurable = readConfigurable(config);
    const { limit, before } = options ?? {};
    const threadId = optionalString(configurable.thread_id);
    const checkpointNs = textIfPresent(configurable.checkpoint_ns);
    const beforeId = beforeCheckpointId(before);
    const records = this.#repo.listCheckpoints({
      ...(threadId !== undefined ? { threadId } : {}),
      ...(checkpointNs !== undefined ? { checkpointNs } : {}),
      ...(beforeId !== undefined ? { beforeCheckpointId: beforeId } : {}),
      metadata: metadataFilters(options?.filter),
      ...(limit !== undefined ? { limit: sanitizeLimit(limit) } : {}),
    });
    for (const record of records) {
      yield await this.#tupleFrom(record, config, false);
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = requireThreadId(config);
    const configurable = readConfigurable(config);
    const checkpointNs = optionalString(configurable.checkpoint_ns) ?? "";
    const parent =
      configurable.checkpoint_id == null
        ? null
        : (textIfPresent(configurable.checkpoint_id) ?? null);
    const prepared = copyCheckpoint(checkpoint);
    const [[checkpointType, serializedCheckpoint], [metadataType, serializedMetadata]] =
      await Promise.all([dumpTyped(this.serde, prepared), dumpTyped(this.serde, metadata)]);
    if (checkpointType !== metadataType) {
      throw new Error("Failed to serialize checkpoint and metadata to the same type.");
    }
    const metadataBytes = toBytes(serializedMetadata);
    if (metadataBytes.byteLength > this.#inlineByteLimit) {
      throw new Error(
        `Checkpoint metadata is ${metadataBytes.byteLength} bytes, above inlineByteLimit (${this.#inlineByteLimit}). Metadata stays inline so list() filters can read it.`,
      );
    }
    this.#repo.upsertCheckpoint({
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: parent,
      type: checkpointType,
      checkpoint: toBytes(serializedCheckpoint),
      metadata: metadataBytes,
    });
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ): Promise<void> {
    const threadId = requireThreadId(config);
    const configurable = readConfigurable(config);
    const checkpointId = optionalString(configurable.checkpoint_id);
    if (!checkpointId) {
      throw new Error('Missing "checkpoint_id" field in passed "config.configurable".');
    }
    if (writes.length === 0) return;
    const checkpointNs = optionalString(configurable.checkpoint_ns) ?? "";
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const serialized = await Promise.all(
      writes.map(async (write, index) => {
        const [type, value] = await dumpTyped(this.serde, write[1]);
        const mapped = WRITES_IDX_MAP[write[0]];
        const row: WriteInsert = {
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          taskPath,
          idx: mapped ?? index,
          channel: write[0],
          type,
          value: toBytes(value),
        };
        return row;
      }),
    );
    this.#repo.insertWrites(serialized, allSpecial ? "replace" : "ignore");
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.#repo.deleteThread(threadId);
  }

  async #tupleFrom(
    row: CheckpointRecord,
    requested: RunnableConfig,
    hadCheckpointId: boolean,
  ): Promise<CheckpointTuple> {
    const pendingWrites = await Promise.all(
      sortWrites(row.writes).map(async (write) => {
        const loaded = await loadTyped(this.serde, write.type ?? "json", write.value);
        return [write.taskId, write.channel, loaded] as [string, string, unknown];
      }),
    );
    const checkpoint = asCheckpoint(
      await loadTyped(this.serde, row.type ?? "json", row.checkpoint),
    );
    if (checkpoint.v < 4 && row.parentCheckpointId != null) {
      await this.#migratePendingSends(
        checkpoint,
        row.threadId,
        row.checkpointNs,
        row.parentCheckpointId,
      );
    }
    const storedConfig: RunnableConfig = {
      configurable: {
        thread_id: row.threadId,
        checkpoint_ns: row.checkpointNs,
        checkpoint_id: row.checkpointId,
      },
    };
    return {
      config: hadCheckpointId ? requested : storedConfig,
      checkpoint,
      metadata: asMetadata(await loadTyped(this.serde, row.type ?? "json", row.metadata)),
      parentConfig:
        row.parentCheckpointId == null
          ? undefined
          : {
              configurable: {
                thread_id: row.threadId,
                checkpoint_ns: row.checkpointNs,
                checkpoint_id: row.parentCheckpointId,
              },
            },
      pendingWrites,
    };
  }

  async #migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const sends = sortWrites(
      this.#repo.pendingSends(threadId, checkpointNs, parentCheckpointId, TASKS),
    );
    checkpoint.channel_values[TASKS] = await Promise.all(
      sends.map((send) => loadTyped(this.serde, send.type ?? "json", send.value)),
    );
    const versions = Object.values(checkpoint.channel_versions);
    checkpoint.channel_versions[TASKS] =
      versions.length > 0 ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
  }
}

function sortWrites(writes: readonly WriteRecord[]): WriteRecord[] {
  return writes
    .map((write) => ({
      key: writesSortKey(write.taskPath, write.taskId, write.idx),
      write,
    }))
    .sort((left, right) => compareWritesSortKeys(left.key, right.key))
    .map((item) => item.write);
}

function readConfigurable(config: RunnableConfig): Record<string, unknown> {
  const configurable: unknown = config.configurable;
  if (configurable == null || typeof configurable !== "object") return {};
  return configurable as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) return undefined;
  throw new Error("Expected a string configurable value.");
}

/** `undefined` when the key is absent. A present value must be text. */
function textIfPresent(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return optionalString(value);
}

function requireThreadId(config: RunnableConfig): string {
  const threadId = optionalString(readConfigurable(config).thread_id);
  if (!threadId) {
    throw new Error('Missing "thread_id" field in passed "config.configurable".');
  }
  return threadId;
}

function beforeCheckpointId(before: RunnableConfig | undefined): string | undefined {
  if (!before) return undefined;
  return optionalString(readConfigurable(before).checkpoint_id);
}

function sanitizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("limit must be a non-negative integer.");
  }
  return limit;
}

function metadataFilters(
  filter: CheckpointListOptions["filter"],
): readonly (readonly [string, string])[] {
  if (!filter) return [];
  const source = filter as Record<string, unknown>;
  const entries: (readonly [string, string])[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    entries.push([`$.${key}`, JSON.stringify(value)]);
  }
  return entries;
}

function asCheckpoint(value: unknown): Checkpoint {
  if (value == null || typeof value !== "object" || !("id" in value) || !("v" in value)) {
    throw new Error("Stored checkpoint payload is not a checkpoint.");
  }
  return value as Checkpoint;
}

function asMetadata(value: unknown): CheckpointMetadata {
  if (value == null || typeof value !== "object") {
    throw new Error("Stored checkpoint metadata is not an object.");
  }
  return value as CheckpointMetadata;
}
