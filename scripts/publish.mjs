import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const token = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN;
if (!token) {
  console.log("NPM_TOKEN is not set. Skipping npm publish.");
  process.exit(0);
}

const { name, version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

try {
  const published = execSync(`npm view ${name}@${version} version`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (published === version) {
    console.log(`${name}@${version} is already published.`);
    process.exit(0);
  }
} catch {
  // npm view exits non-zero when the version is not in the registry.
}

execSync("npm publish --provenance --access public", {
  stdio: "inherit",
  env: { ...process.env, NPM_CONFIG_PROVENANCE: "true", NODE_AUTH_TOKEN: token },
});
