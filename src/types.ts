/// <reference types="@cloudflare/workers-types" />
import type { SerializerProtocol } from "@langchain/langgraph-checkpoint";

export interface DurableObjectCheckpointSaverOptions {
  /**
   * The object's storage. Pass `ctx.storage` from a SQLite-backed
   * `DurableObject`. Writes for one saver call run inside `transactionSync`
   * after serialization has finished.
   */
  storage: DurableObjectStorage;
  /**
   * LangGraph serde. Defaults to the saver base class `JsonPlusSerializer`.
   */
  serde?: SerializerProtocol;
  /**
   * Prefix for every table this saver creates. An empty string uses the bare
   * names `checkpoints`, `writes`, `blobs`, and `schema_meta`. Any other
   * value must be an identifier; a trailing underscore is added when missing,
   * so `"lg"` and `"lg_"` both create `lg_checkpoints`.
   *
   * @default "lg_"
   */
  tablePrefix?: string;
  /**
   * Largest checkpoint or write payload, in bytes, stored in the row itself.
   * Larger payloads are split into blob chunks of this size. Must be at least
   * 1024 and at most 6_000_000 so a row stays under the 8 MB SQLite limit.
   *
   * @default 1_000_000
   */
  inlineByteLimit?: number;
}

export interface TableNames {
  readonly prefix: string;
  readonly checkpoints: string;
  readonly writes: string;
  readonly blobs: string;
  readonly meta: string;
  readonly checkpointsIndex: string;
  readonly checkpointsRaw: string;
  readonly writesRaw: string;
  readonly blobsRaw: string;
  readonly metaRaw: string;
}
