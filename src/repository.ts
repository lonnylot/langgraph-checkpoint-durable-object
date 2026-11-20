import type { TableNames } from "./types.js";
import {
  bytesFromSql,
  chunkBytes,
  concatBytes,
  sqlBlob,
  type SqlCell,
  type StoredBytes,
} from "./bytes.js";

export interface CheckpointRecord {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  type: string | null;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
  writes: WriteRecord[];
}

export interface WriteRecord {
  taskId: string;
  taskPath: string;
  idx: number;
  channel: string;
  type: string | null;
  value: Uint8Array;
}

export interface CheckpointInsert {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  type: string;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
}

export interface WriteInsert {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  taskId: string;
  taskPath: string;
  idx: number;
  channel: string;
  type: string;
  value: Uint8Array;
}

export interface ListQuery {
  threadId?: string;
  checkpointNs?: string;
  beforeCheckpointId?: string;
  /** JSON path keys paired with the JSON-encoded value to compare. */
  metadata: readonly (readonly [string, string])[];
  limit?: number;
}

interface CheckpointRow extends Record<string, SqlCell> {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: SqlCell;
  checkpoint_blob_id: string | null;
  metadata: SqlCell;
}

interface WriteRow extends Record<string, SqlCell> {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  task_path: string | null;
  idx: number;
  channel: string;
  type: string | null;
  value: SqlCell;
  value_blob_id: string | null;
}

interface BlobRow extends Record<string, SqlCell> {
  chunk_index: number;
  data: SqlCell;
}

interface BlobIdRow extends Record<string, SqlCell> {
  blob_id: string | null;
}

/**
 * All SQL for the saver. Statements are parameterized. Table names come from
 * the validated identifier set and are the only interpolated fragments.
 */
export class CheckpointRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly names: TableNames,
    private readonly inlineByteLimit: number,
  ) {}

  getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId: string | undefined,
  ): CheckpointRecord | undefined {
    const sql = checkpointId
      ? `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, checkpoint_blob_id, metadata
         FROM ${this.names.checkpoints}
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      : `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, checkpoint_blob_id, metadata
         FROM ${this.names.checkpoints}
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY checkpoint_id DESC
         LIMIT 1`;
    const bindings: SqlCell[] = checkpointId
      ? [threadId, checkpointNs, checkpointId]
      : [threadId, checkpointNs];
    const row = this.rows<CheckpointRow>(sql, bindings)[0];
    if (!row) return undefined;
    return this.hydrate(row);
  }

  listCheckpoints(query: ListQuery): CheckpointRecord[] {
    const where: string[] = [];
    const bindings: SqlCell[] = [];
    if (query.threadId !== undefined) {
      where.push("thread_id = ?");
      bindings.push(query.threadId);
    }
    if (query.checkpointNs !== undefined) {
      where.push("checkpoint_ns = ?");
      bindings.push(query.checkpointNs);
    }
    if (query.beforeCheckpointId !== undefined) {
      where.push("checkpoint_id < ?");
      bindings.push(query.beforeCheckpointId);
    }
    for (const [path, jsonValue] of query.metadata) {
      where.push("json_extract(CAST(metadata AS TEXT), ?) = json_extract(?, '$')");
      bindings.push(path, jsonValue);
    }
    let sql = `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, checkpoint_blob_id, metadata
      FROM ${this.names.checkpoints}`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY checkpoint_id DESC";
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      bindings.push(query.limit);
    }
    return this.rows<CheckpointRow>(sql, bindings).map((row) => this.hydrate(row));
  }

  /**
   * Insert or replace one checkpoint and its blob chunks.
   * The whole update is one synchronous transaction.
   */
  upsertCheckpoint(row: CheckpointInsert): void {
    this.storage.transactionSync(() => {
      const existing = this.rows<BlobIdRow>(
        `SELECT checkpoint_blob_id AS blob_id FROM ${this.names.checkpoints}
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        [row.threadId, row.checkpointNs, row.checkpointId],
      )[0];
      if (existing?.blob_id) this.deleteBlob(existing.blob_id);
      const stored = this.storeBytes(row.checkpoint);
      this.exec(
        `INSERT OR REPLACE INTO ${this.names.checkpoints}
          (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, checkpoint_blob_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.threadId,
          row.checkpointNs,
          row.checkpointId,
          row.parentCheckpointId,
          row.type,
          sqlBlob(stored.inline),
          stored.blobId,
          sqlBlob(row.metadata),
        ],
      );
    });
  }

  /**
   * Insert a batch of writes. `replace` overwrites rows at the same primary
   * key (special channels). `ignore` keeps the first row (regular channels).
   * Chunks and inserts commit or roll back together.
   */
  insertWrites(rowsToInsert: readonly WriteInsert[], mode: "replace" | "ignore"): void {
    if (rowsToInsert.length === 0) return;
    const conflict = mode === "replace" ? "OR REPLACE" : "OR IGNORE";
    this.storage.transactionSync(() => {
      for (const row of rowsToInsert) {
        const existing = this.rows<BlobIdRow>(
          `SELECT value_blob_id AS blob_id FROM ${this.names.writes}
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND task_id = ? AND idx = ?`,
          [row.threadId, row.checkpointNs, row.checkpointId, row.taskId, row.idx],
        )[0];
        if (existing && mode === "ignore") continue;
        if (existing?.blob_id) this.deleteBlob(existing.blob_id);
        const stored = this.storeBytes(row.value);
        this.exec(
          `INSERT ${conflict} INTO ${this.names.writes}
            (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value, value_blob_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.threadId,
            row.checkpointNs,
            row.checkpointId,
            row.taskId,
            row.taskPath,
            row.idx,
            row.channel,
            row.type,
            sqlBlob(stored.inline),
            stored.blobId,
          ],
        );
      }
    });
  }

  /** Delete every checkpoint, write, and blob chunk for one thread. */
  deleteThread(threadId: string): void {
    this.storage.transactionSync(() => {
      this.exec(
        `DELETE FROM ${this.names.blobs} WHERE blob_id IN (
          SELECT checkpoint_blob_id FROM ${this.names.checkpoints}
          WHERE thread_id = ? AND checkpoint_blob_id IS NOT NULL
          UNION
          SELECT value_blob_id FROM ${this.names.writes}
          WHERE thread_id = ? AND value_blob_id IS NOT NULL
        )`,
        [threadId, threadId],
      );
      this.exec(`DELETE FROM ${this.names.writes} WHERE thread_id = ?`, [threadId]);
      this.exec(`DELETE FROM ${this.names.checkpoints} WHERE thread_id = ?`, [threadId]);
    });
  }

  /** Parent channel payloads, in `idx` order. Used to migrate checkpoints older than v4. */
  pendingSends(
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string,
    channel: string,
  ): WriteRecord[] {
    const rows = this.rows<WriteRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value, value_blob_id
       FROM ${this.names.writes}
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel = ?
       ORDER BY idx`,
      [threadId, checkpointNs, parentCheckpointId, channel],
    );
    return rows.map((row) => this.hydrateWrite(row));
  }

  private hydrate(row: CheckpointRow): CheckpointRecord {
    const writes = this.rows<WriteRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value, value_blob_id
       FROM ${this.names.writes}
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
      [row.thread_id, row.checkpoint_ns, row.checkpoint_id],
    ).map((write) => this.hydrateWrite(write));
    return {
      threadId: row.thread_id,
      checkpointNs: row.checkpoint_ns,
      checkpointId: row.checkpoint_id,
      parentCheckpointId: row.parent_checkpoint_id,
      type: row.type,
      checkpoint: this.loadBytes(row.checkpoint, row.checkpoint_blob_id),
      metadata: bytesFromSql(row.metadata) ?? new Uint8Array(),
      writes,
    };
  }

  private hydrateWrite(row: WriteRow): WriteRecord {
    return {
      taskId: row.task_id,
      taskPath: row.task_path ?? "",
      idx: row.idx,
      channel: row.channel,
      type: row.type,
      value: this.loadBytes(row.value, row.value_blob_id),
    };
  }

  private storeBytes(bytes: Uint8Array): StoredBytes {
    if (bytes.byteLength <= this.inlineByteLimit) {
      return { inline: bytes, blobId: null };
    }
    const blobId = crypto.randomUUID();
    const chunks = chunkBytes(bytes, this.inlineByteLimit);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) continue;
      this.exec(`INSERT INTO ${this.names.blobs} (blob_id, chunk_index, data) VALUES (?, ?, ?)`, [
        blobId,
        index,
        sqlBlob(chunk),
      ]);
    }
    return { inline: null, blobId };
  }

  private loadBytes(inline: SqlCell, blobId: string | null): Uint8Array {
    if (blobId == null) return bytesFromSql(inline) ?? new Uint8Array();
    const chunks = this.rows<BlobRow>(
      `SELECT chunk_index, data FROM ${this.names.blobs} WHERE blob_id = ? ORDER BY chunk_index`,
      [blobId],
    );
    return concatBytes(chunks.map((chunk) => bytesFromSql(chunk.data) ?? new Uint8Array()));
  }

  private deleteBlob(blobId: string): void {
    this.exec(`DELETE FROM ${this.names.blobs} WHERE blob_id = ?`, [blobId]);
  }

  private rows<Row extends Record<string, SqlCell>>(
    query: string,
    bindings: readonly SqlCell[] = [],
  ): Row[] {
    return this.storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  private exec(query: string, bindings: readonly SqlCell[]): void {
    this.storage.sql.exec(query, ...bindings).toArray();
  }
}
