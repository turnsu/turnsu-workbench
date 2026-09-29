import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("Project Team Work migration keeps Project Scope, direct Work Item commands, and lifecycle audit coupled", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "026_g2_project_team_work");
  assert.ok(migration);
  const sql = await migration.loadSql();

  assert.match(sql, /CREATE TABLE public\.projects/);
  assert.match(sql, /CREATE TABLE public\.project_memberships/);
  assert.match(sql, /CREATE TABLE public\.project_lifecycle_events/);
  assert.match(sql, /CREATE TABLE public\.work_item_lifecycle_events/);
  assert.match(sql, /scope\.scope_kind = 'project'[\s\S]*scope\.project_id = NEW\.project_id/);
  assert.match(sql, /'project_create', 'project_members_revise',[\s\S]*'work_item_create', 'work_item_update'/);
  assert.match(sql, /kind = 'project_create'[\s\S]*target_kind = 'project'[\s\S]*target_revision = 1/);
  assert.match(sql, /kind = 'work_item_create'[\s\S]*target_kind = 'work_item'[\s\S]*target_revision = 1/);
  assert.match(sql, /kind = 'work_item_update'[\s\S]*target_kind = 'work_item'[\s\S]*target_revision >= 2/);
  assert.match(sql, /ALTER COLUMN promotion_id DROP NOT NULL/);
  assert.match(sql, /origin_kind = 'team_work_item' AND promotion_id IS NULL/);
  assert.match(sql, /work_item_access_grants_one_active_owner_uq/);
  assert.match(sql, /product_commands_team_work_target_guard/);
  assert.match(sql, /DROP TRIGGER product_commands_special_target_guard ON public\.product_commands/);
  assert.match(sql, /WHEN \(NEW\.kind NOT IN \([\s\S]*'project_create', 'project_members_revise',[\s\S]*'work_item_create', 'work_item_update'/);
  assert.doesNotMatch(sql, /source_session_id|raw_transcript|worker_log|provider_payload/i);
});

test("Team Work Agent entry migration binds one accepted Agent command to the new Work Item target", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "027_g2_team_work_agent_entry");
  assert.ok(migration);
  const sql = await migration.loadSql();

  assert.match(sql, /kind = 'agent_turn' AND effect_class = 'execute'[\s\S]*target_kind = 'work_item'/);
  assert.match(sql, /command_row\.kind = 'agent_turn'[\s\S]*NEW\.entry_kind = 'handoff'/);
  assert.match(sql, /NEW\.kind = 'agent_turn' AND NEW\.target_kind = 'work_item'/);
  assert.match(sql, /NEW\.kind <> 'agent_turn' AND NEW\.status <> 'completed'/);
  assert.match(sql, /NOT \(NEW\.kind = 'agent_turn' AND NEW\.target_kind = 'work_item'\)/);
  assert.doesNotMatch(sql, /raw_transcript|worker_log|provider_payload/i);
});

test("Work Item continuation Agent entry migration assigns each Turn its own constrained target", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "028_g2_work_item_continuation_agent_entry");
  assert.ok(migration);
  const sql = await migration.loadSql();

  assert.match(sql, /CREATE TABLE public\.work_item_continuation_turn_events/);
  assert.match(sql, /target_kind = 'work_item_continuation_turn'/);
  assert.match(sql, /event\.turn_id = NEW\.target_id/);
  assert.match(sql, /work_item_continuation_turn_events_guard/);
  assert.doesNotMatch(sql, /source_session_id|raw_transcript|worker_log|provider_payload/i);
});
