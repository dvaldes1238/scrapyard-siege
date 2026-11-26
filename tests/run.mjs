// Runs every tests/*.test.ts in its own Node process, using Node's built-in TypeScript
// support (no bundler). `npm test` runs all; `npm test -- enemies` runs files matching "enemies".
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testsDir);
const register = new URL("./support/register.mjs", import.meta.url).href;
const filters = process.argv.slice(2);

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => filters.length === 0 || filters.some((p) => f.includes(p)))
  .sort();

if (files.length === 0) {
  console.error(`No test files match: ${filters.join(" ")}`);
  process.exit(1);
}

const results = [];
for (const file of files) {
  console.log(`\n=== ${file}`);
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", register, path.join(testsDir, file)],
    { cwd: root, stdio: "inherit" },
  );
  results.push({ file, ok: run.status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

console.log("\n=== Summary");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.file} (${r.seconds} s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
