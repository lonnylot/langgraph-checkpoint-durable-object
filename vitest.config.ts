import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          {
            name: "langgraph-validation-vitest-globals",
            enforce: "pre",
            transform(code, id) {
              if (!id.includes("@langchain/langgraph-checkpoint-validation")) return;
              return {
                code: `const { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } = globalThis;\n${code}`,
                map: null,
              };
            },
          },
          cloudflareTest({
            wrangler: { configPath: "./test/wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          globals: true,
          testTimeout: 30_000,
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["scripts/**/*.test.mjs"],
        },
      },
    ],
  },
});
