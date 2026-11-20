import "@langchain/core/callbacks/dispatch";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { INTERRUPT, RESUME, type SerializerProtocol } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_SCHEMA_VERSION, DurableObjectCheckpointSaver } from "../src/index.js";
import {
  checkpoint,
  config,
  metadata,
  nextId,
  objectName,
  stub,
  versions,
  withSaver,
} from "./helpers.js";

describe("DurableObjectCheckpointSaver", () => {
  it("round-trips a checkpoint", async () => {
    const threadId = "thread-round";
    const id = nextId(1);
    await withSaver(objectName("round"), async (saver) => {
      const written = await saver.put(
        config(threadId),
        checkpoint(id, { message: "hello" }),
        metadata(),
        versions({ message: "hello" }),
      );
      expect(written.configurable).toEqual({
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: id,
      });
      const loaded = await saver.getTuple(config(threadId));
      expect(loaded?.checkpoint.channel_values).toEqual({ message: "hello" });
      expect(loaded?.checkpoint.id).toBe(id);
      expect(loaded?.metadata).toMatchObject({ source: "loop", step: 1 });
      expect(loaded?.config.configurable?.checkpoint_id).toBe(id);
      expect(loaded?.pendingWrites).toEqual([]);
    });
  });

  it("lists newest first and honors before, limit, metadata, and namespace filters", async () => {
    await withSaver(objectName("list"), async (saver) => {
      const first = nextId(1);
      const second = nextId(2);
      const third = nextId(3);
      const child = nextId(4);
      await saver.put(
        config("alpha"),
        checkpoint(first, { n: 1 }),
        metadata({ source: "input", step: 0 }),
        {},
      );
      await saver.put(
        config("alpha", "", first),
        checkpoint(second, { n: 2 }),
        metadata({ source: "loop", step: 1 }),
        {},
      );
      await saver.put(
        config("alpha", "", second),
        checkpoint(third, { n: 3 }),
        metadata({ source: "loop", step: 2 }),
        {},
      );
      await saver.put(
        config("alpha", "child"),
        checkpoint(child, { n: 9 }),
        metadata({ source: "loop", step: 1 }),
        {},
      );
      await saver.put(
        config("beta"),
        checkpoint(nextId(5)),
        metadata({ source: "loop", step: 7 }),
        {},
      );

      const all = [];
      for await (const tuple of saver.list(config("alpha", ""))) all.push(tuple.checkpoint.id);
      expect(all).toEqual([third, second, first]);

      const limited = [];
      for await (const tuple of saver.list(config("alpha", ""), { limit: 1 })) {
        limited.push(tuple.checkpoint.id);
      }
      expect(limited).toEqual([third]);

      const before = [];
      for await (const tuple of saver.list(config("alpha", ""), {
        before: config("alpha", "", third),
      })) {
        before.push(tuple.checkpoint.id);
      }
      expect(before).toEqual([second, first]);

      const filtered = [];
      for await (const tuple of saver.list(config("alpha", ""), {
        filter: { source: "input" },
      })) {
        filtered.push(tuple.checkpoint.id);
      }
      expect(filtered).toEqual([first]);

      const childNs = [];
      for await (const tuple of saver.list(config("alpha", "child")))
        childNs.push(tuple.checkpoint.id);
      expect(childNs).toEqual([child]);

      const everyThread = [];
      for await (const tuple of saver.list({}))
        everyThread.push(tuple.config.configurable?.thread_id);
      expect(everyThread).toEqual(["beta", "alpha", "alpha", "alpha", "alpha"]);
    });
  });

  it("stores pending writes, parents, and namespace-scoped rows", async () => {
    await withSaver(objectName("writes"), async (saver) => {
      const parent = nextId(1);
      const child = nextId(2);
      await saver.put(config("t", "ns"), checkpoint(parent, { step: "parent" }), metadata(), {});
      const stored = await saver.put(
        config("t", "ns", parent),
        checkpoint(child, { step: "child" }),
        metadata(),
        {},
      );
      await saver.putWrites(
        stored,
        [
          ["messages", ["hello"]],
          ["notes", "later"],
        ],
        "task-b",
        "b",
      );
      await saver.putWrites(stored, [["messages", ["first"]]], "task-a", "a");

      const loaded = await saver.getTuple(config("t", "ns", child));
      expect(loaded?.parentConfig?.configurable).toEqual({
        thread_id: "t",
        checkpoint_ns: "ns",
        checkpoint_id: parent,
      });
      expect(loaded?.pendingWrites).toEqual([
        ["task-a", "messages", ["first"]],
        ["task-b", "messages", ["hello"]],
        ["task-b", "notes", "later"],
      ]);

      const root = await saver.getTuple(config("t", ""));
      expect(root).toBeUndefined();
    });
  });

  it("replaces special-channel writes and ignores duplicate regular writes", async () => {
    await withSaver(objectName("special"), async (saver) => {
      const id = nextId(1);
      await saver.put(config("t"), checkpoint(id), metadata(), {});
      const at = config("t", "", id);
      await saver.putWrites(at, [["messages", "keep"]], "task", "");
      await saver.putWrites(at, [["messages", "ignored"]], "task", "");
      await saver.putWrites(at, [[INTERRUPT, ["pause"]]], "task", "");
      await saver.putWrites(at, [[RESUME, ["go"]]], "task", "");

      const loaded = await saver.getTuple(at);
      expect(loaded?.pendingWrites).toEqual([
        ["task", RESUME, ["go"]],
        ["task", INTERRUPT, ["pause"]],
        ["task", "messages", "keep"],
      ]);
    });
  });

  it("deleteThread removes one thread and leaves the others", async () => {
    await withSaver(objectName("delete"), async (saver) => {
      await saver.put(
        config("gone"),
        checkpoint(nextId(1), { secret: true }),
        metadata(),
        versions({ secret: true }),
      );
      await saver.putWrites(config("gone", "", nextId(1)), [["ch", 1]], "task");
      await saver.put(
        config("kept"),
        checkpoint(nextId(2), { secret: false }),
        metadata(),
        versions({ secret: false }),
      );
      await saver.deleteThread("gone");
      expect(await saver.getTuple(config("gone"))).toBeUndefined();
      const kept = await saver.getTuple(config("kept"));
      expect(kept?.checkpoint.channel_values).toEqual({ secret: false });
    });
  });

  it("creates the schema once and upgrades a version-1 database without dropping rows", async () => {
    await withSaver(objectName("schema"), async (saver, state) => {
      expect(saver.schemaVersion()).toBe(CHECKPOINT_SCHEMA_VERSION);
      await saver.put(
        config("keep"),
        checkpoint(nextId(1), { n: 1 }),
        metadata(),
        versions({ n: 1 }),
      );
      saver.setup();
      expect((await saver.getTuple(config("keep")))?.checkpoint.channel_values).toEqual({ n: 1 });

      state.storage.sql.exec("DROP TABLE IF EXISTS lg_blobs");
      state.storage.sql.exec("DROP TABLE IF EXISTS lg_writes");
      state.storage.sql.exec("DROP TABLE IF EXISTS lg_checkpoints");
      state.storage.sql.exec("DROP TABLE IF EXISTS lg_schema_meta");
      state.storage.sql.exec(`CREATE TABLE lg_checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )`);
      state.storage.sql.exec(`CREATE TABLE lg_writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )`);
      state.storage.sql.exec(
        "CREATE TABLE lg_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO lg_schema_meta (key, value) VALUES ('schema_version', '1')",
      );
      state.storage.sql.exec(
        `INSERT INTO lg_writes
          (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
         VALUES ('old', '', 'cp-1', 'task-1', 0, 'messages', 'json', ?)`,
        '{"kept":true}',
      );

      const upgraded = new DurableObjectCheckpointSaver({ storage: state.storage });
      expect(upgraded.schemaVersion()).toBe(CHECKPOINT_SCHEMA_VERSION);
      upgraded.setup();
      const columns = state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(lg_writes)")
        .toArray()
        .map((row) => row.name);
      expect(columns).toContain("task_path");
      expect(columns).toContain("value_blob_id");
      const kept = state.storage.sql
        .exec<{ value: string; task_path: string }>(
          "SELECT CAST(value AS TEXT) AS value, task_path FROM lg_writes WHERE checkpoint_id = 'cp-1'",
        )
        .toArray()[0];
      expect(kept?.value).toBe('{"kept":true}');
      expect(kept?.task_path).toBe("");
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lg_blobs'",
          )
          .toArray(),
      ).toHaveLength(1);
    });
  });

  it("chunks payloads above the inline limit and reads them back", async () => {
    await withSaver(objectName("blobs"), async (saver, state) => {
      const small = new DurableObjectCheckpointSaver({
        storage: state.storage,
        inlineByteLimit: 1024,
        tablePrefix: "blob_",
      });
      const id = nextId(1);
      const bulky = "x".repeat(3000);
      await small.put(config("wide"), checkpoint(id, { bulky }), metadata(), versions({ bulky }));
      const chunks = state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM blob_blobs")
        .one().n;
      expect(chunks).toBeGreaterThan(1);
      const loaded = await small.getTuple(config("wide"));
      expect(loaded?.checkpoint.channel_values).toEqual({ bulky });
      await small.deleteThread("wide");
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM blob_blobs").one().n,
      ).toBe(0);
    });
  });

  it("does not let deleteThread tear a putWrites batch", async () => {
    await withSaver(objectName("race"), async (saver, state) => {
      const id = nextId(1);
      const threadId = "racy";
      await saver.put(config(threadId), checkpoint(id), metadata(), {});
      const inner = saver.serde;
      let dumps = 0;
      const yielding: SerializerProtocol = {
        async dumpsTyped(value: unknown) {
          dumps += 1;
          const encoded = await inner.dumpsTyped(value);
          if (dumps === 2) {
            // The previous implementation awaited serde inside the write loop,
            // after earlier rows were already inserted. deleteThread at this
            // point then removed those rows and the loop inserted the rest.
            await saver.deleteThread(threadId);
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
          return encoded;
        },
        loadsTyped(type: string, data: string | Uint8Array) {
          return inner.loadsTyped(type, data);
        },
      };
      const racing = new DurableObjectCheckpointSaver({
        storage: state.storage,
        serde: yielding,
      });
      await racing.putWrites(
        config(threadId, "", id),
        [
          ["one", 1],
          ["two", 2],
        ],
        "task",
      );
      const channels = state.storage.sql
        .exec<{ channel: string }>(
          "SELECT channel FROM lg_writes WHERE thread_id = ? ORDER BY channel",
          threadId,
        )
        .toArray()
        .map((row) => row.channel);
      expect(channels).toEqual(["one", "two"]);
    });
  });

  it("keeps every channel after a later step writes only one of them", async () => {
    await withSaver(objectName("channels"), async (saver) => {
      const State = Annotation.Root({
        title: Annotation<string>({
          reducer: (_current, next) => next,
          default: () => "",
        }),
        note: Annotation<string>({
          reducer: (_current, next) => next,
          default: () => "",
        }),
      });
      const graph = new StateGraph(State)
        .addNode("setTitle", () => ({ title: "milk" }))
        .addNode("setNote", () => ({ note: "later" }))
        .addEdge(START, "setTitle")
        .addEdge("setTitle", "setNote")
        .addEdge("setNote", END)
        .compile({ checkpointer: saver });
      const result = await graph.invoke({ title: "", note: "" }, config("channels"));
      expect(result.title).toBe("milk");
      expect(result.note).toBe("later");
    });
  });

  it("resumes an interrupted graph after the object is evicted", async () => {
    const name = objectName("graph");
    const thread = stub(name);
    const threadId = "graph-thread";
    await runInDurableObject(thread, async (_instance, state) => {
      const saver = new DurableObjectCheckpointSaver({ storage: state.storage });
      const graph = interruptedGraph(saver);
      const first = await graph.invoke({ answer: "" }, config(threadId));
      expect(first.answer).toBe("");
      expect(interruptValue(first)).toBe("approve?");
    });

    await evictDurableObject(thread);

    await runInDurableObject(thread, async (_instance, state) => {
      const saver = new DurableObjectCheckpointSaver({ storage: state.storage });
      const graph = interruptedGraph(saver);
      const resumed = await graph.invoke(new Command({ resume: "yes" }), config(threadId));
      expect(resumed.answer).toBe("yes");
    });
  });
});

function interruptedGraph(saver: DurableObjectCheckpointSaver) {
  return buildInterruptedGraph(saver);
}

function interruptValue(state: { answer: string }): unknown {
  const record = state as { answer: string; __interrupt__?: readonly { value: unknown }[] };
  return record.__interrupt__?.[0]?.value;
}

function buildInterruptedGraph(saver: DurableObjectCheckpointSaver) {
  const State = Annotation.Root({
    answer: Annotation<string>({
      reducer: (_current, next) => next,
      default: () => "",
    }),
  });
  return new StateGraph(State)
    .addNode("review", () => {
      const decision: unknown = interrupt("approve?");
      return { answer: typeof decision === "string" ? decision : "" };
    })
    .addEdge(START, "review")
    .addEdge("review", END)
    .compile({ checkpointer: saver });
}
