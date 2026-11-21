import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./publish.mjs", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const name = manifest.name;
const version = manifest.version;

const stub = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.NPM_CALL_LOG, JSON.stringify(args) + "\\n");
const mode = process.env.PUBLISH_MODE;
const packageName = process.env.PACKAGE_NAME;
const packageVersion = process.env.PACKAGE_VERSION;
if (args[0] === "--version") {
  process.stdout.write("11.15.0\\n");
  process.exit(0);
}
if (args[0] === "view") {
  if (mode === "listed") {
    process.stdout.write(packageVersion + "\\n");
    process.exit(0);
  }
  process.stderr.write("npm error code E404\\n");
  process.exit(1);
}
if (args[0] === "publish") {
  if (mode === "success") {
    process.stdout.write("+ " + packageName + "@" + packageVersion + "\\n");
    process.exit(0);
  }
  if (mode === "previously-published") {
    process.stderr.write(
      "npm error code E403\\nYou cannot publish over the previously published versions: " +
        packageVersion +
        ".\\n",
    );
    process.exit(1);
  }
  if (mode === "epublishconflict") {
    process.stderr.write(
      "npm error code EPUBLISHCONFLICT\\nCannot publish over existing version.\\n",
    );
    process.exit(1);
  }
  if (mode === "staged") {
    process.stderr.write(
      "npm error code EPUBLISHCONFLICT\\n409 Conflict - Cannot publish over previously staged version \\"" +
        packageVersion +
        "\\".\\n",
    );
    process.exit(1);
  }
  process.stderr.write(
    "npm error code ENEEDAUTH\\nThis command requires you to be logged in to publish packages.\\n",
  );
  process.exit(1);
}
process.stderr.write("unexpected npm invocation\\n");
process.exit(99);
`;

function runPublish(mode) {
  const dir = mkdtempSync(join(tmpdir(), "publish-npm-"));
  const log = join(dir, "calls.log");
  const npmBin = join(dir, "npm");
  writeFileSync(log, "");
  writeFileSync(npmBin, stub);
  chmodSync(npmBin, 0o755);
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
        HOME: process.env.HOME,
        PUBLISH_MODE: mode,
        NPM_CALL_LOG: log,
        PACKAGE_NAME: name,
        PACKAGE_VERSION: version,
      },
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const publishCommand = ["publish", "--access", "public"];

describe("npm publish outcomes", () => {
  it("leaves a version npm view already lists", () => {
    const result = runPublish("listed");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${name}@${version} is already on npm.`);
    expect(result.calls).toEqual([["--version"], ["view", `${name}@${version}`, "version"]]);
  });

  it("streams a successful publish", () => {
    const result = runPublish("success");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`+ ${name}@${version}`);
    expect(result.stdout).not.toContain("is already on npm.");
    expect(result.stderr).not.toContain("E404");
    expect(result.calls).toEqual([
      ["--version"],
      ["view", `${name}@${version}`, "version"],
      publishCommand,
    ]);
  });

  it("treats a previously published version as already on npm", () => {
    const result = runPublish("previously-published");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`${name}@${version} is already on npm.`);
    expect(result.stderr).toContain("previously published versions");
    expect(result.stderr).not.toContain("E404");
    expect(result.calls.at(-1)).toEqual(publishCommand);
  });

  it("treats EPUBLISHCONFLICT as already on npm", () => {
    const result = runPublish("epublishconflict");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`${name}@${version} is already on npm.`);
    expect(result.stderr).toContain("EPUBLISHCONFLICT");
    expect(result.stderr).not.toContain("npm stage approve");
    expect(result.calls.at(-1)).toEqual(publishCommand);
  });

  it("fails a previously staged version even when npm also reports EPUBLISHCONFLICT", () => {
    const result = runPublish("staged");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("previously staged version");
    expect(result.stderr).toContain("npm stage list");
    expect(result.stderr).toContain("npm stage approve <id>");
    expect(result.stderr).toContain("Staged Packages");
    expect(result.stderr).toContain("npmjs.com");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("is already on npm.");
    expect(result.calls.at(-1)).toEqual(publishCommand);
  });

  it("fails any other publish error", () => {
    const result = runPublish("other");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("ENEEDAUTH");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("is already on npm.");
    expect(result.stderr).not.toContain("npm stage approve");
    expect(result.calls.at(-1)).toEqual(publishCommand);
  });
});
