# Changelog

## 0.1.0

Initial release of `DurableObjectCheckpointSaver`, a LangGraph.js `BaseCheckpointSaver` on Cloudflare Durable Object SQLite storage.

- `getTuple`, `list`, `put`, `putWrites`, and `deleteThread`, with namespaces, metadata filters, `before`, and `limit`.
- Versioned, idempotent schema with a configurable table prefix.
- Checkpoint and write payloads above the inline limit are stored as blob chunks.
- Each write method serializes first, then applies its SQL inside one `transactionSync` callback so a concurrent `deleteThread` cannot tear a batch.
