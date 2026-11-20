# Contributing

Issues and pull requests are welcome.

## Setup

Node.js 20 or newer.

```bash
npm install
npm test
```

`npm test` runs the suite inside the Workers runtime with `@cloudflare/vitest-plugin` and a SQLite Durable Object. The first run downloads the workerd binary that Wrangler uses.

## Checks

Before opening a pull request:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Lint is ESLint plus Prettier. `npm run format` writes Prettier's changes.

## Changes

- Keep SQL in `src/repository.ts`. Parameters stay bound. Table names come from the validated prefix in `src/schema.ts`.
- Keep serde calls out of `transactionSync`. Await serialization, then do every write for that call in one synchronous transaction. The concurrency notes in the README describe the guarantee.
- Schema changes are additive and idempotent. Bump `CHECKPOINT_SCHEMA_VERSION` and add a step that existing databases can run more than once.
- Do not add product-specific table names, thread layouts, or business logic. This package is a generic LangGraph saver.
- Add a changeset for user-visible changes: `npx changeset`. Publishing that changeset is described in [RELEASING.md](RELEASING.md).

## Tests

Cover the behavior you changed with a Workers test. The official suite in `test/validation.test.ts` should stay green. A storage race belongs in a test that fails if an `await` is put back between SQL writes.
