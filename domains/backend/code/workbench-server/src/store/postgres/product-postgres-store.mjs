import { Pool as PgPool } from "pg";

import { createPostgresCoreSemantics } from "../core-semantics/postgres-core-semantics.mjs";
import { PostgresAuthPersistence } from "../../auth/postgres-auth-persistence.mjs";
import { PostgresNativeClientSessionStore } from "../../auth/postgres-native-client-session-store.mjs";
import { PostgresWorkspaceReadModel } from "../../auth/postgres-workspace-read-model.mjs";
import { PostgresAgentPersistence } from "../../agents/postgres-agent-persistence.mjs";
import { PostgresAgentHandoffLifecycle } from "../../agents/postgres-agent-handoff-lifecycle.mjs";
import { PostgresAgentProposalReadModel } from "../../agents/postgres-agent-proposal-read-model.mjs";
import { PostgresAgentProposalLifecycle } from "../../agents/postgres-agent-proposal-lifecycle.mjs";
import { PostgresAgentToolApprovalLifecycle } from "../../agents/postgres-agent-tool-approval-lifecycle.mjs";
import { PostgresWorkItemPromotionLifecycle } from "../../work-items/postgres-work-item-promotion-lifecycle.mjs";
import { PostgresTeamWorkLifecycle } from "../../work-items/postgres-team-work-lifecycle.mjs";
import { PostgresMemoryPersistence } from "../../memory/postgres-memory-persistence.mjs";
import { PostgresCanonicalMemoryResolver } from "../../memory/postgres-canonical-memory-resolver.mjs";
import { PostgresArtifactMetadataRepository } from "../../artifacts/postgres-artifact-metadata-repository.mjs";
import { PostgresWorkerTranscriptArtifactRepository } from "../../artifacts/postgres-worker-transcript-artifact-repository.mjs";
import { PostgresInputAttachmentPersistence } from "../../attachments/postgres-input-attachment-persistence.mjs";
import { PostgresTextResourcePersistence } from "../../resources/postgres-text-resource-persistence.mjs";
import { createPostgresAgentObjectAuthorizer } from "../../authorization/postgres-agent-object-authorizer.mjs";
import { PostgresSkillDraftLifecycle } from "../../skills/postgres-skill-draft-lifecycle.mjs";
import { PostgresSkillReadModel } from "../../skills/postgres-skill-read-model.mjs";
import { PostgresLoopDraftLifecycle } from "../../loops/postgres-loop-draft-lifecycle.mjs";
import {
  PostgresBuilderProposalLifecycle,
  PostgresBuilderProposalReadModel,
} from "../../loops/postgres-builder-proposal-lifecycle.mjs";
import { PostgresWorkflowCompileLifecycle } from "../../loops/postgres-workflow-compile-lifecycle.mjs";
import { PostgresWorkflowReadModel } from "../../loops/postgres-workflow-read-model.mjs";
import { PostgresInboxReadModel } from "../../inbox/postgres-inbox-read-model.mjs";
import { PostgresProductObjectReadModel } from "./postgres-product-object-read-model.mjs";
import { PostgresCompatibilityCatalogReadModel } from "./postgres-compatibility-catalog-read-model.mjs";
import { PostgresTeamLibraryReadModel } from "./postgres-team-library-read-model.mjs";
import { PostgresTeamLibraryLifecycle } from "./postgres-team-library-lifecycle.mjs";
import { PostgresOperationalReadiness } from "./postgres-operational-readiness.mjs";
import { PostgresExternalMutationPort } from "./postgres-external-mutation-port.mjs";
import { PostgresAutomationSchedulerPersistence } from "./postgres-automation-scheduler-persistence.mjs";
import { PostgresAutomationLifecycle } from "../../automations/postgres-automation-lifecycle.mjs";
import { PostgresDeviceLifecycle } from "../../devices/postgres-device-lifecycle.mjs";
import { PostgresDeviceExecutionLeaseStore } from "../../devices/postgres-device-execution-lease-store.mjs";
import { PostgresSessionDomainReadModel } from "./postgres-session-domain-read-model.mjs";
import { PostgresSecretBindingPersistence } from "../../security/postgres-secret-binding-persistence.mjs";
import { PostgresMigrationRunner } from "./migration-runner.mjs";

const RETRYABLE_TRANSACTION_SQLSTATES = new Set(["40001", "40P01"]);
const activeUnitsOfWork = new WeakMap();

export class ProductPostgresStore {
  #pool;
  #ownsPool;
  #maxTransactionRetries;
  #retryDelay;
  #closed = false;
  #closePromise = null;

  constructor({
    pool,
    poolOptions = {},
    maxTransactionRetries = 2,
    retryDelay = defaultRetryDelay,
  } = {}) {
    if (pool !== undefined && Object.keys(poolOptions).length > 0) {
      throw new TypeError("postgres_pool_and_options_are_mutually_exclusive");
    }
    this.#ownsPool = pool === undefined;
    this.#pool = pool ?? new PgPool(poolOptions);
    if (typeof this.#pool.connect !== "function" || typeof this.#pool.end !== "function") {
      throw new TypeError("postgres_pool_required");
    }
    if (!Number.isInteger(maxTransactionRetries)
      || maxTransactionRetries < 0
      || maxTransactionRetries > 10) {
      throw new TypeError("postgres_transaction_retries_invalid");
    }
    if (typeof retryDelay !== "function") {
      throw new TypeError("postgres_transaction_retry_delay_invalid");
    }
    this.#maxTransactionRetries = maxTransactionRetries;
    this.#retryDelay = retryDelay;
  }

  get persistenceDriver() { return "postgres"; }

  async connect() {
    this.#assertOpen();
    const client = await this.#pool.connect();
    let operationError = null;
    try {
      const health = await client.query("SELECT 1 AS ok");
      if (health.rows?.[0]?.ok !== 1) {
        throw new TypeError("postgres_health_result_invalid");
      }
    } catch (error) {
      operationError = asError(error, "postgres_health_state_unknown");
      throw error;
    } finally {
      try {
        client.release(operationError ?? undefined);
      } catch (releaseError) {
        if (!operationError) throw releaseError;
      }
    }
    return this;
  }

  bindAdapter(factory) {
    this.#assertOpen();
    if (typeof factory !== "function") throw new TypeError("postgres_adapter_factory_required");
    const execute = (uow, queryConfig, values) => {
      this.#assertOpen();
      const state = this.#assertOwnedActiveUnitOfWork(uow);
      return state.client.query(queryConfig, values);
    };
    const adapter = factory(Object.freeze({ execute }));
    if ((typeof adapter !== "object" || adapter === null) && typeof adapter !== "function") {
      throw new TypeError("postgres_adapter_required");
    }
    return adapter;
  }

  // Product composition obtains its narrow semantic ports from the Store;
  // callers never receive a Pool, client, or raw SQL execute handle.
  createCoreSemantics({ principal, scopeId, clock } = {}) {
    this.#assertOpen();
    return createPostgresCoreSemantics({ store: this, principal, scopeId, clock });
  }

  createMemoryPersistence() {
    this.#assertOpen();
    return new PostgresMemoryPersistence({ store: this });
  }

  createCanonicalMemoryResolver() {
    this.#assertOpen();
    return new PostgresCanonicalMemoryResolver({ store: this });
  }

  createAuthPersistence(options = {}) {
    this.#assertOpen();
    return new PostgresAuthPersistence({ store: this, ...options });
  }

  createNativeClientSessionStore(options = {}) {
    this.#assertOpen();
    return new PostgresNativeClientSessionStore({ store: this, ...options });
  }

  createWorkspaceReadModel() { this.#assertOpen(); return new PostgresWorkspaceReadModel({ store: this }); }

  createAgentPersistence({ commandIntake, clock } = {}) {
    this.#assertOpen();
    return new PostgresAgentPersistence({ store: this, commandIntake, clock });
  }

  createAgentHandoffLifecycle(options = {}) {
    this.#assertOpen();
    return new PostgresAgentHandoffLifecycle({ store: this, ...options });
  }

  createAgentProposalReadModel() { this.#assertOpen(); return new PostgresAgentProposalReadModel({ store: this }); }

  createAgentProposalLifecycle(options = {}) { this.#assertOpen(); return new PostgresAgentProposalLifecycle({ store: this, ...options }); }

  createAgentToolApprovalLifecycle(options = {}) {
    this.#assertOpen();
    return new PostgresAgentToolApprovalLifecycle({ store: this, ...options });
  }

  createWorkItemPromotionLifecycle(options = {}) {
    this.#assertOpen();
    return new PostgresWorkItemPromotionLifecycle({ store: this, ...options });
  }

  createTeamWorkLifecycle({ promotionLifecycle, ...options } = {}) {
    this.#assertOpen();
    return new PostgresTeamWorkLifecycle({
      store: this,
      promotionLifecycle,
      ...options,
    });
  }

  createArtifactMetadataRepository() {
    this.#assertOpen();
    return new PostgresArtifactMetadataRepository({ store: this });
  }

  createWorkerTranscriptArtifactRepository() {
    this.#assertOpen();
    return new PostgresWorkerTranscriptArtifactRepository({ store: this });
  }

  createInputAttachmentPersistence({ clock } = {}) {
    this.#assertOpen();
    return new PostgresInputAttachmentPersistence({ store: this, clock });
  }

  createTextResourcePersistence({ clock } = {}) {
    this.#assertOpen();
    return new PostgresTextResourcePersistence({ store: this, clock });
  }

  createAgentObjectAuthorizer({ objectAccessPolicy } = {}) {
    this.#assertOpen();
    return createPostgresAgentObjectAuthorizer({ store: this, objectAccessPolicy });
  }

  createSkillDraftLifecycle(options = {}) {
    this.#assertOpen();
    return new PostgresSkillDraftLifecycle({ store: this, ...options });
  }

  createSkillReadModel() { this.#assertOpen(); return new PostgresSkillReadModel({ store: this }); }

  createLoopDraftLifecycle(options = {}) { this.#assertOpen(); return new PostgresLoopDraftLifecycle({ store: this, ...options }); }

  createBuilderProposalReadModel() { this.#assertOpen(); return new PostgresBuilderProposalReadModel({ store: this }); }

  createBuilderProposalLifecycle(options = {}) {
    this.#assertOpen();
    return new PostgresBuilderProposalLifecycle({ store: this, ...options });
  }

  createWorkflowCompileLifecycle(options = {}) { this.#assertOpen(); return new PostgresWorkflowCompileLifecycle({ store: this, ...options }); }

  createWorkflowReadModel() { this.#assertOpen(); return new PostgresWorkflowReadModel({ store: this }); }

  createInboxReadModel() { this.#assertOpen(); return new PostgresInboxReadModel({ store: this }); }

  createProductObjectReadModel() { this.#assertOpen(); return new PostgresProductObjectReadModel({ store: this }); }

  createCompatibilityCatalogReadModel() { this.#assertOpen(); return new PostgresCompatibilityCatalogReadModel({ store: this }); }

  createTeamLibraryReadModel() { this.#assertOpen(); return new PostgresTeamLibraryReadModel({ store: this }); }

  createTeamLibraryLifecycle(options = {}) { this.#assertOpen(); return new PostgresTeamLibraryLifecycle({ store: this, ...options }); }

  createOperationalReadiness() { this.#assertOpen(); return new PostgresOperationalReadiness({ store: this }); }

  createExternalMutationPort(options = {}) {
    this.#assertOpen();
    return new PostgresExternalMutationPort({ store: this, ...options });
  }

  createAutomationSchedulerPersistence() {
    this.#assertOpen();
    return new PostgresAutomationSchedulerPersistence({ store: this });
  }

  createAutomationLifecycle(options = {}) {
    this.#assertOpen();
    return new PostgresAutomationLifecycle({ store: this, ...options });
  }

  createDeviceLifecycle(options = {}) {
    this.#assertOpen();
    return new PostgresDeviceLifecycle({ store: this, ...options });
  }

  createDeviceExecutionLeaseStore(options = {}) {
    this.#assertOpen();
    return new PostgresDeviceExecutionLeaseStore({ store: this, ...options });
  }

  createSessionDomainReadModel() {
    this.#assertOpen();
    return new PostgresSessionDomainReadModel({ store: this });
  }

  createSecretBindingPersistence() {
    this.#assertOpen();
    return new PostgresSecretBindingPersistence({ store: this });
  }

  async withTransaction(work, options = {}) {
    this.#assertOpen();
    if (typeof work !== "function") throw new TypeError("postgres_transaction_work_required");
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("postgres_transaction_options_invalid");
    }
    if (Object.hasOwn(options, "unitOfWork")) {
      throw new TypeError("postgres_transaction_unit_of_work_option_unsupported_use_uow");
    }
    const unknownOptions = Object.keys(options).filter((key) => key !== "uow");
    if (unknownOptions.length > 0) throw new TypeError("postgres_transaction_options_invalid");
    const { uow } = options;

    if (uow !== undefined) {
      this.#assertOwnedActiveUnitOfWork(uow);
      return work(uow);
    }

    const maximumAttempts = this.#maxTransactionRetries + 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.#runTransactionAttempt(work);
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt === maximumAttempts) throw error;
        await this.#retryDelay(attempt, error);
      }
    }
    throw new TypeError("postgres_transaction_attempts_exhausted");
  }

  async runMigrations(options = {}) {
    this.#assertOpen();
    return new PostgresMigrationRunner({ ...options, pool: this.#pool }).run();
  }

  async close({ closeInjectedPool = false } = {}) {
    if (this.#closePromise) return this.#closePromise;
    if (typeof closeInjectedPool !== "boolean") {
      throw new TypeError("postgres_close_injected_pool_invalid");
    }
    this.#closed = true;
    this.#closePromise = this.#ownsPool || closeInjectedPool
      ? Promise.resolve().then(() => this.#pool.end())
      : Promise.resolve();
    return this.#closePromise;
  }

  async #runTransactionAttempt(work) {
    const client = await this.#pool.connect();
    const unitOfWork = Object.freeze({ kind: "postgres_unit_of_work" });
    const state = { owner: this, client, active: false };
    activeUnitsOfWork.set(unitOfWork, state);
    let transactionStarted = false;
    let operationError = null;
    let releaseError = null;

    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      transactionStarted = true;
      state.active = true;
      const result = await work(unitOfWork);
      state.active = false;
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      state.active = false;
      operationError = error;
      if (!transactionStarted) {
        releaseError = asError(error, "postgres_transaction_begin_state_unknown");
      }
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          operationError = new PostgresTransactionError(
            "postgres_transaction_rollback_failed",
            "The PostgreSQL transaction failed and could not be rolled back.",
            { cause: new AggregateError([error, rollbackError]) },
          );
          releaseError = operationError;
          throw operationError;
        }
      }
      throw error;
    } finally {
      state.active = false;
      try {
        client.release(releaseError ?? false);
      } catch (clientReleaseError) {
        if (!operationError) throw clientReleaseError;
      }
    }
  }

  #assertOwnedActiveUnitOfWork(unitOfWork) {
    const state = activeUnitsOfWork.get(unitOfWork);
    if (!state || state.owner !== this) {
      throw new TypeError("postgres_unit_of_work_not_owned");
    }
    if (!state.active) throw new TypeError("postgres_unit_of_work_inactive");
    return state;
  }

  #assertOpen() {
    if (this.#closed) throw new TypeError("postgres_store_closed");
  }
}

export class PostgresTransactionError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PostgresTransactionError";
    this.code = code;
  }
}

export function isRetryableTransactionError(error) {
  return RETRYABLE_TRANSACTION_SQLSTATES.has(error?.code);
}

function defaultRetryDelay(retryNumber) {
  const milliseconds = Math.min(25 * (2 ** (retryNumber - 1)), 100);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asError(value, fallbackCode) {
  if (value instanceof Error) return value;
  return new PostgresTransactionError(
    fallbackCode,
    "The PostgreSQL connection state is unknown.",
  );
}
