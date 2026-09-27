import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(webRoot, "../../../../..");
const node = path.join(repositoryRoot, ".tooling/node/bin/node");
const npm = path.join(repositoryRoot, ".tooling/node/lib/node_modules/npm/bin/npm-cli.js");
const packages = [
  {
    root: path.join(repositoryRoot, "domains/backend/code/workbench-contracts"),
    required: ["node_modules/typescript/bin/tsc", "node_modules/typebox/package.json"],
  },
  {
    root: path.join(repositoryRoot, "domains/frontend/shared/code/product-client"),
    required: ["node_modules/typescript/bin/tsc", "node_modules/typebox/package.json"],
  },
];

function run(args, cwd) {
  const result = spawnSync(node, [npm, ...args], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const packageInfo of packages) {
  const dependenciesReady = packageInfo.required.every((relativePath) => (
    existsSync(path.resolve(packageInfo.root, relativePath))
  ));
  if (!dependenciesReady) {
    run(["ci", "--ignore-scripts", "--prefer-offline"], packageInfo.root);
  }
  run(["run", "build", "--silent"], packageInfo.root);
}
