/** Value returned by Durable Object `sql.exec` for a column. */
export type SqlCell = SqlStorageValue;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Normalize a serde payload to bytes without changing its contents. */
export function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? textEncoder.encode(data) : data;
}

/** Value stored for one checkpoint or write payload. */
export interface StoredBytes {
  /** Inline bytes when the payload fits in the row. Null when chunked. */
  inline: Uint8Array | null;
  /** Id of the chunk set when the payload was too large for one row. */
  blobId: string | null;
}

export function bytesFromSql(value: SqlCell | undefined): Uint8Array | null {
  if (value == null) return null;
  if (typeof value === "string") return textEncoder.encode(value);
  if (typeof value === "number") {
    throw new Error("Expected a string or blob from SQLite, received a number.");
  }
  return new Uint8Array(value);
}

/** Copy a view into an ArrayBuffer that SQLite will store as a blob. */
export function sqlBlob(bytes: Uint8Array | null): ArrayBuffer | null {
  if (bytes == null) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function chunkBytes(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (chunkSize < 1) throw new Error("chunk size must be positive.");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return chunks;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Decode bytes for `loadsTyped`, which accepts the original string or bytes. */
export function asSerdeData(bytes: Uint8Array): Uint8Array {
  return bytes;
}

export function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}
