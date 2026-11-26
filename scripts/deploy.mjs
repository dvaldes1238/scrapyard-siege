// Deploys dist/ as a Cloudflare Worker.
// Generic settings come from wrangler.jsonc (committed); account-specific ones from .env
// (git-ignored, template in .env.example). Extra arguments pass through to `wrangler deploy`,
// e.g. `npm run deploy -- --dry-run`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, ".env");
// Variables already set in the shell (e.g. in CI) win over .env.
if (existsSync(envFile)) process.loadEnvFile(envFile);
// An empty `KEY=` line in .env means "not set"; Wrangler would treat "" as a value.
for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
  if (process.env[key] === "") delete process.env[key];
}

// wrangler.jsonc may only use full-line // comments (keeps this parser trivial).
const base = JSON.parse(
  readFileSync(resolve(root, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n"),
);

const name = process.env.WORKER_NAME?.trim() || base.name;
const domain = process.env.DEPLOY_DOMAIN?.trim() || "";

const config = {
  ...base,
  name,
  // The generated file lives in .wrangler/deploy/, so make the assets path absolute.
  assets: { ...base.assets, directory: resolve(root, base.assets.directory) },
  // With a domain: served only there (Cloudflare creates the DNS record and certificate, and refuses
  // if the hostname already has a record). Without one: https://<name>.<account>.workers.dev.
  routes: domain ? [{ pattern: domain, custom_domain: true }] : undefined,
  workers_dev: !domain,
};
delete config.$schema;

const outDir = resolve(root, ".wrangler/deploy");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, "wrangler.json");
writeFileSync(outFile, JSON.stringify(config, null, 2) + "\n");

console.log(`Deploying Worker "${name}" to ${domain || "its workers.dev URL"}`);
const result = spawnSync("npx", ["wrangler", "deploy", "--config", outFile, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
