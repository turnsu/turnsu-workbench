-- A Work Item continuation is a user-owned personal branch. It is distinct
-- from legacy agent_branches and can only carry a server-derived, safe Handoff
-- context. The source private Agent Session remains solely in
-- work_item_promotions.

ALTER TABLE public.work_item_handoff_capsules
  ADD CONSTRAINT work_item_handoff_capsules_branch_reference_uq
  UNIQUE (workspace_id, work_item_id, handoff_id);

ALTER TABLE public.work_item_access_grants
  ADD CONSTRAINT work_item_access_grants_continuation_reference_uq
  UNIQUE (workspace_id, work_item_id, user_id, grant_id);

CREATE TABLE public.work_item_continuations (
  continuation_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  agent_session_id public.product_identifier NOT NULL,
  handoff_id public.product_identifier NOT NULL,
  access_grant_id public.product_identifier NOT NULL,
  continuation_context text NOT NULL,
  context_hash text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT work_item_continuations_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_continuations_handoff_fk
    FOREIGN KEY (workspace_id, work_item_id, handoff_id)
    REFERENCES public.work_item_handoff_capsules (workspace_id, work_item_id, handoff_id),
  CONSTRAINT work_item_continuations_grant_fk
    FOREIGN KEY (workspace_id, work_item_id, user_id, access_grant_id)
    REFERENCES public.work_item_access_grants (workspace_id, work_item_id, user_id, grant_id),
  CONSTRAINT work_item_continuations_session_fk
    FOREIGN KEY (agent_session_id, user_id, workspace_id)
    REFERENCES public.agent_sessions (session_id, user_id, workspace_id),
  CONSTRAINT work_item_continuations_identity_uq UNIQUE (workspace_id, continuation_id),
  CONSTRAINT work_item_continuations_user_branch_uq UNIQUE (workspace_id, work_item_id, user_id),
  CONSTRAINT work_item_continuations_session_uq UNIQUE (agent_session_id),
  CONSTRAINT work_item_continuations_context CHECK (
    length(btrim(continuation_context)) BETWEEN 1 AND 16000
  ),
  CONSTRAINT work_item_continuations_context_hash CHECK (
    context_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT work_item_continuations_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT work_item_continuations_private_payload_forbidden CHECK (
    NOT (payload ?| ARRAY[
      'sourceSessionId', 'source_session_id', 'transcript', 'rawTranscript',
      'workerLog', 'worker_log', 'providerPayload', 'provider_payload', 'secret'
    ])
  )
);

CREATE INDEX work_item_continuations_session_lookup_idx
  ON public.work_item_continuations (workspace_id, agent_session_id, user_id);
