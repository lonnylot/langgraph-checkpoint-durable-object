import type { TableNames } from "./types.js";

/** Schema version written to `${prefix}schema_meta`. */
export const CHECKPOINT_SCHEMA_VERSION = 2;

/** Default table prefix. */
export const DEFAULT_TABLE_PREFIX = "lg_";

/**
 * Payloads at or under this size are stored in the checkpoint or write row.
 * Larger payloads are chunked. 1_000_000 bytes leaves headroom under the
 * 8 MB Durable Object SQLite row limit.
 */
export const DEFAULT_INLINE_BYTE_LIMIT = 1_000_000;

export const MIN_INLINE_BYTE_LIMIT = 1024;
export const MAX_INLINE_BYTE_LIMIT = 6_000_000;

const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9]*_$/;

/**
 * Resolve and quote the table names for a prefix.
 * Identifiers are validated before they are interpolated into SQL.
 */
export function resolveTableNames(prefix: string = DEFAULT_TABLE_PREFIX): TableNames {
  const normalized = prefix === "" ? "" : prefix.endsWith("_") ? prefix : `${prefix}_`;
  if (normalized !== "" && !PREFIX_PATTERN.test(normalized)) {
    throw new Error(
      'tablePrefix must be empty or start with a letter and contain only letters, digits, and underscores (for example "lg_").',
    );
  }
  const raw = (name: string): string => `${normalized}${name}`;
  const quote = (name: string): string => `"${raw(name)}"`;
  return {
    prefix: normalized,
    checkpoints: quote("checkpoints"),
    writes: quote("writes"),
    blobs: quote("blobs"),
    meta: quote("schema_meta"),
    checkpointsIndex: quote("checkpoints_by_id"),
    checkpointsRaw: raw("checkpoints"),
    writesRaw: raw("writes"),
    blobsRaw: raw("blobs"),
    metaRaw: raw("schema_meta"),
  };
}

export function assertInlineByteLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < MIN_INLINE_BYTE_LIMIT || limit > MAX_INLINE_BYTE_LIMIT) {
    throw new Error(
      `inlineByteLimit must be an integer from ${MIN_INLINE_BYTE_LIMIT} to ${MAX_INLINE_BYTE_LIMIT}.`,
    );
  }
  return limit;
}

interface TableInfoRow extends Record<string, SqlStorageValue> {
  name: string;
}

interface MasterRow extends Record<string, SqlStorageValue> {
  name: string;
}

interface VersionRow extends Record<string, SqlStorageValue> {
  value: string;
}

function rows<Row extends Record<string, SqlStorageValue>>(
  storage: DurableObjectStorage,
  query: string,
  bindings: readonly SqlStorageValue[] = [],
): Row[] {
  return storage.sql.exec<Row>(query, ...bindings).toArray();
}

function tableExists(storage: DurableObjectStorage, name: string): boolean {
  const found = rows<MasterRow>(
    storage,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return found.length > 0;
}

function columnNames(storage: DurableObjectStorage, table: string): Set<string> {
  const info = rows<TableInfoRow>(storage, `PRAGMA table_info(${table})`);
  return new Set(info.map((row) => row.name));
}

function ensureColumn(
  storage: DurableObjectStorage,
  table: string,
  columns: Set<string>,
  name: string,
  definition: string,
): void {
  if (columns.has(name)) return;
  storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

/**
 * Create or upgrade the checkpoint tables.
 *
 * Version 1 is the checkpoint and write tables. Version 2 adds `task_path`
 * when it is missing, blob pointers, and the blob chunk table. Every step is
 * additive and safe to run again. The work is synchronous and wrapped in
 * `transactionSync`.
 */
export function migrateSchema(storage: DurableObjectStorage, names: TableNames): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${names.meta} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );

    if (!tableExists(storage, names.checkpointsRaw)) {
      storage.sql.exec(`CREATE TABLE ${names.checkpoints} (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        checkpoint_blob_id TEXT,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )`);
      storage.sql.exec(`CREATE TABLE ${names.writes} (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_path TEXT NOT NULL DEFAULT '',
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        value_blob_id TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )`);
      storage.sql.exec(`CREATE TABLE ${names.blobs} (
        blob_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (blob_id, chunk_index)
      )`);
      storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS ${names.checkpointsIndex} ON ${names.checkpoints} (checkpoint_id)`,
      );
      writeVersion(storage, names);
      return;
    }

    const checkpointColumns = columnNames(storage, names.checkpoints);
    ensureColumn(storage, names.checkpoints, checkpointColumns, "checkpoint_blob_id", "TEXT");

    if (!tableExists(storage, names.writesRaw)) {
      storage.sql.exec(`CREATE TABLE ${names.writes} (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_path TEXT NOT NULL DEFAULT '',
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        value_blob_id TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )`);
    } else {
      const writeColumns = columnNames(storage, names.writes);
      ensureColumn(storage, names.writes, writeColumns, "task_path", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(storage, names.writes, writeColumns, "value_blob_id", "TEXT");
    }

    if (!tableExists(storage, names.blobsRaw)) {
      storage.sql.exec(`CREATE TABLE ${names.blobs} (
        blob_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (blob_id, chunk_index)
      )`);
    }

    storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS ${names.checkpointsIndex} ON ${names.checkpoints} (checkpoint_id)`,
    );
    writeVersion(storage, names);
  });
}

function writeVersion(storage: DurableObjectStorage, names: TableNames): void {
  storage.sql.exec(
    `INSERT INTO ${names.meta} (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(CHECKPOINT_SCHEMA_VERSION),
  );
}

/** Read the stored schema version, or 0 when the meta table is absent. */
export function readSchemaVersion(storage: DurableObjectStorage, names: TableNames): number {
  if (!tableExists(storage, names.metaRaw)) return 0;
  const row = rows<VersionRow>(storage, `SELECT value FROM ${names.meta} WHERE key = ?`, [
    "schema_version",
  ])[0];
  if (!row) return 0;
  const parsed = Number(row.value);
  return Number.isInteger(parsed) ? parsed : 0;
}
