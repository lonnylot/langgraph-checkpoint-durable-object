import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const npmVersion = execSync("npm --version", { encoding: "utf8" }).trim();
const [major = 0, minor = 0, patch = 0] = npmVersion.split(".").map((part) => Number(part));
const supportsTrustedPublishing =
  major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
if (!supportsTrustedPublishing) {
  console.error(
    `npm ${npmVersion} is too old for trusted publishing. Install npm 11.5.1 or newer.`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const name = manifest.name;
const version = manifest.version;

try {
  const published = execSync(`npm view ${name}@${version} version`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (published === version) {
    console.log(`${name}@${version} is already on npm.`);
    process.exit(0);
  }
} catch {
  // npm view exits non-zero when that version is not in the registry.
}

// Trusted publishing from GitHub Actions attaches provenance for a public
// package built from a public repository. Do not pass --provenance.
try {
  execSync("npm publish --access public", { stdio: "inherit" });
} catch (error) {
  const output = errorText(error);
  if (/previously published|EPUBLISHCONFLICT|cannot publish over/i.test(output)) {
    console.log(`${name}@${version} is already on npm.`);
    process.exit(0);
  }
  console.error(output);
  process.exit(1);
}

function errorText(error) {
  if (typeof error !== "object" || error === null) return String(error);
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return `${stderr}\n${message}`;
}
