import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const name = manifest.name;
const version = manifest.version;

const npmVersion = await runNpm(["--version"]);
if (npmVersion.status !== 0) {
  console.error(npmVersion.stderr.trim() || "npm --version failed.");
  process.exit(npmVersion.status || 1);
}
const versionText = npmVersion.stdout.trim();
if (!supportsTrustedPublishing(versionText)) {
  console.error(
    `npm ${versionText} is too old for trusted publishing. Install npm 11.5.1 or newer.`,
  );
  process.exit(1);
}

const listed = await runNpm(["view", `${name}@${version}`, "version"]);
const alreadyListed = listed.status === 0 && listed.stdout.trim() === version;
if (alreadyListed) alreadyOnNpm();

// Trusted publishing from GitHub Actions attaches provenance for a public
// package built from a public repository. Do not pass --provenance.
const published = await runNpm(["publish", "--access", "public"], { stream: true });
if (published.status === 0) process.exit(0);

const outcome = publishOutcome(`${published.stdout}\n${published.stderr}`);
if (outcome === "published") alreadyOnNpm();
if (outcome === "staged") {
  console.error(
    `${name}@${version} is staged on npm and waiting for maintainer approval. Run \`npm stage list\`, then \`npm stage approve <id>\`, or use the Staged Packages tab on npmjs.com.`,
  );
}
process.exit(1);

function alreadyOnNpm() {
  console.log(`${name}@${version} is already on npm.`);
  process.exit(0);
}

function publishOutcome(output) {
  if (/previously staged version/i.test(output)) return "staged";
  if (/previously published|EPUBLISHCONFLICT/i.test(output)) return "published";
  return "failed";
}

function supportsTrustedPublishing(reported) {
  const [major = 0, minor = 0, patch = 0] = reported.split(".").map((part) => Number(part));
  return major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
}

function runNpm(args, { stream = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout, stderr });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stream) process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish(1);
    });
    child.on("close", (status) => {
      finish(status ?? 1);
    });
  });
}
