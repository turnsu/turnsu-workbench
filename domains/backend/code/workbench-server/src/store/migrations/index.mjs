import { backfillDefaultWorkspaceMigration } from "./001-backfill-default-workspace.mjs";
import { runnerTerminalTransitionsMigration } from "./002-runner-terminal-transitions.mjs";
import { agentExecutionFabricMigration } from "./003-agent-execution-fabric.mjs";
import { productMemoryMigration } from "./004-product-memory.mjs";
import { agentProposalsAndActiveBranchesMigration } from "./005-agent-proposals-and-active-branches.mjs";
import { modelRoutingMigration } from "./006-model-routing.mjs";

export { backfillDefaultWorkspaceMigration, LEGACY_PRODUCT_COLLECTIONS } from "./001-backfill-default-workspace.mjs";
export { runnerTerminalTransitionsMigration } from "./002-runner-terminal-transitions.mjs";
export { agentExecutionFabricMigration } from "./003-agent-execution-fabric.mjs";
export { productMemoryMigration } from "./004-product-memory.mjs";
export { agentProposalsAndActiveBranchesMigration } from "./005-agent-proposals-and-active-branches.mjs";
export { modelRoutingMigration, MODEL_ROUTING_COLLECTIONS } from "./006-model-routing.mjs";
export { collectionDigest, defineMigration, MigrationError, ProductMigrationRunner } from "./migration-runner.mjs";

export const PRODUCT_MIGRATIONS = Object.freeze([
  backfillDefaultWorkspaceMigration,
  runnerTerminalTransitionsMigration,
  agentExecutionFabricMigration,
  productMemoryMigration,
  agentProposalsAndActiveBranchesMigration,
  modelRoutingMigration,
]);
