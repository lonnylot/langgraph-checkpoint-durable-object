# langgraph-checkpoint-durable-object

LangGraph.js checkpoint saver for [Cloudflare Durable Object](https://developers.cloudflare.com/durable-objects/) SQLite storage (`ctx.storage.sql`).

It implements `BaseCheckpointSaver` from `@langchain/langgraph-checkpoint`: `getTuple`, `list`, `put`, `putWrites`, and `deleteThread`, including metadata filters, `before`, `limit`, checkpoint namespaces, parent checkpoints, and pending writes.

```bash
npm install langgraph-checkpoint-durable-object @langchain/langgraph @langchain/langgraph-checkpoint @langchain/core
```

Peer dependencies:

| Package                           | Range    |
| --------------------------------- | -------- |
| `@langchain/langgraph-checkpoint` | `^1.2.0` |
| `@langchain/core`                 | `^1.1.0` |

`@langchain/langgraph` is required to compile and run a graph. It is not a dependency of this package.

## Quick start

Create the saver in the Durable Object constructor. Pass `ctx.storage`. The constructor creates and upgrades the tables before the constructor returns.

```typescript
import { DurableObject } from "cloudflare:workers";
import { DurableObjectCheckpointSaver } from "langgraph-checkpoint-durable-object";

export class ThreadObject extends DurableObject<Env> {
  readonly checkpointer: DurableObjectCheckpointSaver;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.checkpointer = new DurableObjectCheckpointSaver({ storage: ctx.storage });
  }
}
```

The Durable Object class must use SQLite storage (`new_sqlite_classes` in the Wrangler migration). `ctx.storage.sql` is only available on that backend. Set the `nodejs_compat` compatibility flag so `interrupt()` can read the graph config from `AsyncLocalStorage`.

```jsonc
{
  "compatibility_date": "2026-11-20",
  "durable_objects": {
    "bindings": [{ "name": "THREAD", "class_name": "ThreadObject" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ThreadObject"] }],
}
```

Compile the graph with that saver and pass a `thread_id`:

```typescript
import { Annotation, END, START, StateGraph, interrupt, Command } from "@langchain/langgraph";

const State = Annotation.Root({
  answer: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
});

const graph = new StateGraph(State)
  .addNode("review", () => {
    const decision: unknown = interrupt("approve?");
    return { answer: typeof decision === "string" ? decision : "" };
  })
  .addEdge(START, "review")
  .addEdge("review", END)
  .compile({ checkpointer });

const config = { configurable: { thread_id: "thread-1" } };
await graph.invoke({ answer: "" }, config);
await graph.invoke(new Command({ resume: "yes" }), config);
```

## One object per thread, or many threads in one object

`thread_id` is a column. Both layouts work.

**One Durable Object per thread.** Name the object with the thread id (`namespace.getByName(threadId)`). The object is the coordination boundary: requests for that thread are single-threaded, and the 10 GB SQLite quota belongs to that thread. Call `deleteThread(threadId)` when the thread is discarded, or delete the object.

**Many threads in one object.** One saver can store every thread. `list({})` returns checkpoints from all of them. `deleteThread(threadId)` removes that thread's checkpoints, writes, and blob chunks and leaves the other threads in place. Those threads share one input gate and one 10 GB database, so a busy object becomes a bottleneck. Prefer one object per thread unless the threads are few and short-lived.

`deleteThread` is synchronous with respect to storage: the deletes for checkpoints, writes, and chunks commit together.

## API

```typescript
new DurableObjectCheckpointSaver({
  storage, // ctx.storage
  serde, // optional SerializerProtocol, defaults to JsonPlusSerializer
  tablePrefix, // optional, default "lg_"
  inlineByteLimit, // optional, default 1_000_000
});
```

| Member                       | Behavior                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup()`                    | Create or upgrade tables. The constructor calls it. Safe to call again.                                                                                                                                                                |
| `schemaVersion()`            | Integer stored in `${prefix}schema_meta`, currently `2`.                                                                                                                                                                               |
| `getTuple(config)`           | Latest checkpoint for `thread_id` + `checkpoint_ns`, or the requested `checkpoint_id`. `undefined` when the thread id is missing or nothing is stored.                                                                                 |
| `list(config, options)`      | Newest `checkpoint_id` first. Filters: `thread_id`, `checkpoint_ns` (only when the key is present, so `""` is the root namespace), `before.configurable.checkpoint_id`, `limit`, and `filter` matched against top-level metadata keys. |
| `put`                        | Stores the checkpoint. Only channel values named in `newVersions` are written. `getTuple` and `list` copy any missing channel from the parent chain.                                                                                   |
| `putWrites` / `deleteThread` | Pending writes, and deletion of one thread's checkpoints, writes, and blob chunks.                                                                                                                                                     |

`putWrites` follows the LangGraph contract. A batch of regular channel writes uses `INSERT OR IGNORE`, so a retried task does not clobber a write already stored at the same index. A batch whose channels are all in `WRITES_IDX_MAP` (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) uses `INSERT OR REPLACE` and the fixed negative indexes from that map. Pending writes are returned in `writesSortKey` order (`task_path`, `task_id`, `idx`).

Table prefix `"lg"` and `"lg_"` both create `lg_checkpoints`, `lg_writes`, `lg_blobs`, and `lg_schema_meta`. The prefix is an identifier, not a SQL fragment. An empty prefix uses the bare names. Two prefixes in one database do not share rows.

Checkpoints older than format v4 get the legacy pending-sends migration on read: parent `__pregel_tasks` writes are copied onto `channel_values` in memory.

## Concurrency

A Durable Object runs your JavaScript on one thread, and every `await` opens the input gate. Another request can run while a call is waiting. Storage writes with no `await` between them are submitted atomically. `transactionSync` is the explicit form of that, and it rolls the statements back when the callback throws.

`put` and `putWrites` used to await `serde.dumpsTyped` between SQL statements. A `deleteThread` (or a second `putWrites`) that ran in that gap could delete rows the loop had already inserted and leave the rows it inserted afterwards. The stored thread was then a mix of the two calls.

This saver does the async work first and the SQL second:

1. Validate the config. Await serde for the checkpoint, the metadata, or every write in the batch. Nothing is written here.
2. Apply every `INSERT`, `DELETE`, and blob chunk for that call inside one `transactionSync` callback. The callback is synchronous. There is no `await` in it.

A `deleteThread` cannot delete half of a `putWrites` batch. It runs to completion before that transaction, or it runs after the transaction commits.

Serialization is not inside the transaction. If `deleteThread` starts while `put` is still serializing, the delete finishes first and the put then inserts. That is last writer wins, not a torn write. The saver does not wrap serde in `blockConcurrencyWhile`. Holding the input gate across serialization would stall every other request on the object for the cost of encoding, which is the wrong default for a library call. Callers who need that exclusion can wrap a specific invocation themselves.

Reads (`getTuple`, `list`) load the rows they need synchronously, then deserialize. Deserialization does not interleave with the SQL for that read.

## Limits

Figures below are the [Durable Object SQLite limits](https://developers.cloudflare.com/durable-objects/platform/limits/) as of 2026-11-20. Re-check them when you upgrade Workers.

| Limit                      | Value                                        |
| -------------------------- | -------------------------------------------- |
| String, blob, or table row | 8 MB                                         |
| SQL statement length       | 100 KB                                       |
| Bound parameters per query | 100                                          |
| Storage per object         | 10 GB on Workers Paid, 1 GB on the Free plan |
| Columns per table          | 100                                          |

Checkpoint and write payloads at or under `inlineByteLimit` (default 1 MB, maximum 6 MB) are stored in the row. Larger payloads are split into blob chunks of that size and reassembled on read. `deleteThread` and checkpoint replacement delete the chunks with the row.

Metadata is not chunked. `list({ filter })` uses SQLite `json_extract` on the inline metadata blob, which is the UTF-8 JSON produced by the default `JsonPlusSerializer`. Metadata larger than `inlineByteLimit` throws. Filters compare top-level keys (`filter: { source: "loop", step: 1 }`). A custom serde that does not store metadata as JSON will still round-trip through `type` + bytes, and those metadata filters will not match.

A single statement stays small because values are bound parameters, not inlined SQL. A multi-megabyte checkpoint becomes several chunk inserts inside one transaction.

When the object hits its storage quota, writes throw `SQLITE_FULL`. Reads and deletes still work, which is what you want for `deleteThread`.

This package does not talk to D1. D1's row limit and transaction model are different, and a D1 database is not `ctx.storage.sql`.

## Comparison

| Saver                          | Package                                    | Where it runs             | Notes                                                                   |
| ------------------------------ | ------------------------------------------ | ------------------------- | ----------------------------------------------------------------------- |
| `MemorySaver`                  | `@langchain/langgraph-checkpoint`          | Anywhere                  | Lost when the isolate dies. Fine for tests.                             |
| `SqliteSaver`                  | `@langchain/langgraph-checkpoint-sqlite`   | Node.js                   | `better-sqlite3` file or `:memory:`. Not a Worker.                      |
| `PostgresSaver`                | `@langchain/langgraph-checkpoint-postgres` | Node.js                   | Shared server. Needs a reachable Postgres.                              |
| `RedisSaver`                   | `@langchain/langgraph-checkpoint-redis`    | Node.js                   | Redis. Optional shallow mode keeps only the latest checkpoint.          |
| `DurableObjectCheckpointSaver` | `langgraph-checkpoint-durable-object`      | Workers / Durable Objects | SQLite on the object. Strong consistency per object. No extra database. |

LangGraph awaits outstanding checkpoint writes before `invoke` and a fully consumed `stream` resolve. On Workers you do not need `waitUntil` for those writes if you await the run. A stream that nobody consumes can still drop them.

## Schema

Version 2. Version 1 is the checkpoint and write tables. Version 2 adds `task_path` when a database from before that column is opened, plus `checkpoint_blob_id`, `value_blob_id`, and the blob table. Upgrades are additive. `setup()` is idempotent.

| Table                  | Rows                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `${prefix}checkpoints` | One checkpoint. Primary key `(thread_id, checkpoint_ns, checkpoint_id)`. |
| `${prefix}writes`      | One pending write. Primary key includes `task_id` and `idx`.             |
| `${prefix}blobs`       | Chunks for payloads above the inline limit.                              |
| `${prefix}schema_meta` | `schema_version`.                                                        |

## Development

Node.js 20 or newer.

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

Tests run in the Workers runtime through [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/), the package that replaced `@cloudflare/vitest-pool-workers`. They use a SQLite Durable Object and the real `ctx.storage.sql`. The official `@langchain/langgraph-checkpoint-validation` suite is loaded from `test/validation.test.ts` and drives the saver over Durable Object RPC.

## Releasing

Publishing is not done from this repository until a maintainer adds the `NPM_TOKEN` secret (an npm granular access token with publish permission for this package). The Release workflow then:

- publishes the current version with npm provenance if that version is not on npm yet
- runs [Changesets](https://github.com/changesets/changesets) so later version bumps open a "Version Packages" pull request and publish from `main`

Do not commit tokens. Provenance uses GitHub's OIDC `id-token` permission together with `NPM_TOKEN`.

Protect `main` with a pull-request requirement so releases only move through reviewed commits. This repository does not enable that setting by itself.

## License

MIT © 2026 Lonny Kapelushnik
