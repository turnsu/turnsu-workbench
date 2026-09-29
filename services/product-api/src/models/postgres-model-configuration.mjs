import { randomUUID } from "node:crypto";
import { canonicalRequestHash } from "../store/serialization.mjs";
import { ProductStoreError } from "../store/errors.mjs";

const ENDPOINTS = Object.freeze({ deepseek: "https://api.deepseek.com", openai: "https://api.openai.com/v1" });
const CAPABILITIES = ["chat", "tool_calling"];

/** Administrator-owned setup command. The resulting model belongs only to the
 * selected member's personal scope; administration grants no private-task access. */
export class PostgresModelConfiguration {
  #store; #sql; #authorizer; #secretStore; #fetch;
  constructor({ store, authorizer, secretStore, fetchImpl = fetch } = {}) {
    if (!store?.bindAdapter || !authorizer?.authorizeModelProfileCreation || !secretStore?.forWorkspace) {
      throw new TypeError("model_configuration_dependencies_required");
    }
    this.#store = store; this.#authorizer = authorizer; this.#secretStore = secretStore; this.#fetch = fetchImpl;
    this.#sql = store.bindAdapter(({ execute }) => ({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }

  async create({ context, request, transactionSession } = {}) {
    const { workspaceId, userId } = context;
    const input = request.data;
    const forUserId = input.forUserId ?? userId;
    const endpoint = ENDPOINTS[input.provider];
    if (!endpoint) throw failure("model_provider_unsupported", "Choose a supported provider.");
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      // Serializes default-policy revision allocation and rechecks membership
      // within the same transaction as authority and model persistence.
      const scope = (await query(`SELECT scope.scope_id AS authority_scope_id, recipient_scope.scope_id
        FROM public.product_scopes scope
        JOIN public.workspace_memberships membership ON membership.workspace_id = scope.workspace_id
          AND membership.user_id = $2 AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
        JOIN public.product_users administrator ON administrator.user_id = $2 AND administrator.disabled = false
        JOIN public.product_scopes recipient_scope ON recipient_scope.workspace_id = scope.workspace_id
          AND recipient_scope.owner_user_id = $3 AND recipient_scope.scope_kind = 'personal' AND recipient_scope.status = 'active'
        JOIN public.workspace_memberships recipient_membership ON recipient_membership.workspace_id = scope.workspace_id
          AND recipient_membership.user_id = $3 AND recipient_membership.status = 'active'
          AND recipient_membership.role IN ('owner', 'admin', 'member')
        JOIN public.product_users recipient ON recipient.user_id = $3 AND recipient.disabled = false
        WHERE scope.workspace_id = $1 AND scope.owner_user_id = $2
          AND scope.scope_kind = 'personal' AND scope.status = 'active'
        FOR UPDATE OF recipient_scope FOR SHARE OF scope, membership, recipient_membership, administrator, recipient`,
      [workspaceId, userId, forUserId])).rows[0];
      if (!scope) throw failure("model_configuration_forbidden", "An active administrator and an active workspace member are required.");
      const scopeId = scope.scope_id;
      const authorityScopeId = scope.authority_scope_id;
      const profileId = `model-${randomUUID()}`;
      const revisionId = `model-revision-${randomUUID()}`;
      const secretBindingId = `model-secret-${randomUUID()}`;
      const commandId = `model-command-${randomUUID()}`;
      const secretStore = this.#secretStore.forWorkspace(workspaceId);
      let binding;
      try { binding = await secretStore.bind(input.secretRef); }
      catch { throw failure("model_secret_unavailable", "The credential reference is unavailable in this workspace's Secret Store."); }
      const configuration = {
        profileId, revisionId, scopeId, forUserId, displayName: input.displayName.trim(),
        provider: input.provider, providerModelId: input.providerModelId,
        protocol: "openai_compatible_chat", endpoint, capabilities: CAPABILITIES,
        parameterSupport: { kind: "chat", temperature: true, maxOutputTokens: true, tools: true, responseSchema: false },
        // Conservative Product execution budgets, not advertised provider limits.
        limits: { kind: "chat", maxInputTokens: 32768, maxOutputTokens: 4096 },
        binding, makeDefault: input.makeDefault,
      };
      const configHash = canonicalRequestHash(configuration);
      const authority = await this.#authorizer.authorizeModelProfileCreation({ workspaceId, userId, scopeId: authorityScopeId, configHash, uow });
      let credential;
      try { credential = await secretStore.resolve({ ...binding, expectedCredentialBindingFingerprint: binding.credentialBindingFingerprint }); }
      catch { throw failure("model_secret_unavailable", "The credential reference changed. Retry with the mounted revision."); }
      await probeModel(this.#fetch, { endpoint, credential, modelId: input.providerModelId });
      const at = (await query("SELECT clock_timestamp() AS now")).rows[0].now;
      await query(`INSERT INTO public.model_profiles (
        profile_id, workspace_id, scope_id, schema_version, profile_scope, display_name, enabled,
        current_revision_id, current_revision_number, created_by_principal_id, created_by_principal_kind,
        write_version, created_at, updated_at, payload)
        VALUES ($1,$2,$3,'workbench-model-catalog-v1','workspace',$4,true,$5,1,$6,'user',1,$7,$7,'{}')`,
      [profileId, workspaceId, scopeId, configuration.displayName, revisionId, userId, at]);
      await query(`INSERT INTO public.model_profile_revisions (
        revision_id, workspace_id, profile_id, revision_number, schema_version, provider, protocol, provider_model_ref,
        capabilities, parameter_support, limits, data_policy, cost_policy, parameter_schema_version, policy_version,
        config_hash, deployment_key, secret_binding_id, created_by_principal_id, created_by_principal_kind, created_at, payload)
        VALUES ($1,$2,$3,1,'workbench-model-catalog-v1',$4,'openai_compatible_chat',$5,$6::text[],$7::jsonb,$8::jsonb,
          '{}'::jsonb,'{}'::jsonb,'chat-v1','model-setup-v1',$9,$3,$10,$11,'user',$12,$13::jsonb)`,
      [revisionId, workspaceId, profileId, input.provider, input.providerModelId, CAPABILITIES,
        JSON.stringify(configuration.parameterSupport), JSON.stringify(configuration.limits), configHash,
        secretBindingId, userId, at, JSON.stringify({ endpoint, configurationCommandId: commandId, configuredForUserId: forUserId })]);
      await query(`INSERT INTO public.secret_bindings (
        workspace_id, secret_binding_id, scope_id, schema_version, owner_kind, owner_id, secret_source,
        store_binding_ref, store_binding_revision, credential_fingerprint, status, status_revision,
        created_by_principal_id, created_by_principal_kind, probed_at, created_at, updated_at, payload)
        VALUES ($1,$2,$3,'workbench-secret-binding-v1','model_profile_revision',$4,'cloud_secret_store',
          $5,$6,$7,'active',1,$8,'user',$9,$9,$9,'{"namespace":"workspace"}'::jsonb)`,
      [workspaceId, secretBindingId, scopeId, revisionId, binding.storeBindingRef, binding.storeBindingRevision,
        binding.credentialBindingFingerprint, userId, at]);
      if (input.makeDefault) {
        const previous = (await query(`SELECT * FROM public.workspace_model_policy_revisions
          WHERE workspace_id = $1 AND scope_id = $2 ORDER BY revision DESC LIMIT 1`, [workspaceId, scopeId])).rows[0];
        const defaults = { ...(previous?.capability_model_revision_ids ?? {}), chat: revisionId, tool_calling: revisionId };
        await query(`INSERT INTO public.workspace_model_policy_revisions (
          workspace_id, scope_id, policy_revision_id, revision, base_policy_revision_id, base_revision, schema_version,
          capability_model_revision_ids, workflow_fallback_allowed, policy_version, content_hash, created_by, created_at, payload)
          VALUES ($1,$2,$3,$4,$5,$6,'workbench-model-policy-v1',$7::jsonb,false,'model-setup-v1',$8,$9,$10,$11::jsonb)`,
        [workspaceId, scopeId, `model-policy-${randomUUID()}`, Number(previous?.revision ?? 0) + 1,
          previous?.policy_revision_id ?? null, previous?.revision ?? null, JSON.stringify(defaults),
          canonicalRequestHash(defaults), userId, at, JSON.stringify({ configurationCommandId: commandId })]);
      }
      await query(`INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind, effective_principal_id,
        effective_principal_kind, authorization_decision_id, policy_revision_id, effect_class, argument_digest,
        quota_user_id, schema_version, kind, target_kind, target_id, target_revision, status, created_at, updated_at, finished_at, payload)
        VALUES ($1,$2,$3,$4,'user',$4,'user',$5,$6,'administrative',$7,$4,'workbench-v1',
          'model_profile_create','model_profile_revision',$8,1,'completed',$9,$9,$9,$10::jsonb)`,
      [commandId, workspaceId, authorityScopeId, userId, authority.authorizationDecisionId, authority.policyRevisionId,
        configHash, revisionId, at, JSON.stringify({ configuredForUserId: forUserId })]);
      return { data: { profileId, revisionId } };
    }, transactionSession ? { uow: transactionSession } : {}).catch((error) => {
      if (error?.code === "23505" && error.constraint === "secret_bindings_store_revision_uq") {
        throw failure("model_secret_already_bound", "This credential revision is already bound. Use the existing model or provision a new credential revision.");
      }
      throw error;
    });
  }
}

async function probeModel(fetchImpl, { endpoint, credential, modelId }) {
  try {
    const response = await fetchImpl(`${endpoint}/models`, {
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure(response.status === 401 || response.status === 403 ? "model_provider_auth_failed" : "model_provider_unavailable",
        "The provider could not verify this credential. Check its access and retry.");
    }
    // A provider response never becomes a Product error body or persisted payload.
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 524288) throw new Error("provider_response_too_large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(value?.data) || !value.data.some((model) => model?.id === modelId)) {
      // Remap only bounded identifiers into a Product recovery hint. Never
      // forward the provider response, account metadata or diagnostic body.
      const availableModelIds = Array.isArray(value?.data) ? [...new Set(value.data
        .map((model) => model?.id).filter((id) => typeof id === "string"
          && id.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)))].slice(0, 50) : [];
      throw new ProductStoreError("model_provider_model_unavailable", "The selected model is not available to this credential.", { availableModelIds });
    }
  } catch (error) {
    if (error instanceof ProductStoreError) throw error;
    throw failure("model_provider_unavailable", "The provider did not return a usable model list. Check the connection and retry.");
  }
}
function failure(code, message) { return new ProductStoreError(code, message); }
