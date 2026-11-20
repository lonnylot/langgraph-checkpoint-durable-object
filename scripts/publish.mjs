import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// setup-node can inject a registry token when registry-url is set. Trusted
// publishing must use the GitHub OIDC token instead.
delete process.env.NODE_AUTH_TOKEN;
delete process.env.NPM_TOKEN;

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

if (view(name) === null) {
  console.log(`${name} is not on npm. Publish the first version from a local checkout. Skipping.`);
  process.exit(0);
}

if (view(`${name}@${version}`) === version) {
  console.log(`${name}@${version} is already on npm.`);
  process.exit(0);
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

function view(spec) {
  try {
    return execSync(`npm view ${spec} version`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const output = errorText(error);
    if (/E404|404 Not Found|not found/i.test(output)) return null;
    console.error(output);
    process.exit(1);
  }
}

function errorText(error) {
  if (typeof error !== "object" || error === null) return String(error);
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return `${stderr}\n${message}`;
}
