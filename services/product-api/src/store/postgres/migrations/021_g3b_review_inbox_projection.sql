-- G3B: a ReviewGate must produce a durable, recipient-authorized Inbox item.
-- Inbox only projects a pending review; decision authority remains the canonical
-- Workflow Run review/cancellation command path.

ALTER TABLE public.inbox_items
  DROP CONSTRAINT IF EXISTS inbox_items_source_domain;

ALTER TABLE public.inbox_items
  ADD CONSTRAINT inbox_items_source_domain CHECK (
    source_domain IN (
      'authorization_decision',
      'workflow_run',
      'workflow_run_review',
      'automation_occurrence',
      'installation_update_draft'
    )
  );

CREATE OR REPLACE FUNCTION public.validate_inbox_item_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  recipient_active boolean;
  source_valid boolean;
BEGIN
  SELECT membership.status = 'active' AND principal.status = 'active'
  INTO recipient_active
  FROM public.workspace_memberships membership
  JOIN public.workspace_principals principal
    ON principal.workspace_id = membership.workspace_id
   AND principal.user_id = membership.user_id
   AND principal.membership_id = membership.membership_id
   AND principal.principal_id = membership.user_id
   AND principal.principal_kind = 'user'
  WHERE membership.workspace_id = NEW.workspace_id
    AND membership.user_id = NEW.recipient_user_id
  FOR SHARE OF membership, principal;
  IF recipient_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'inbox_recipient_inactive'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_domain = 'authorization_decision' THEN
    SELECT decision.disposition = 'approval_required'
      AND decision.expires_at > clock_timestamp()
      AND NEW.source_revision = 1
      AND NEW.source_cursor = decision.authorization_decision_id
      AND NEW.target_kind = 'authorization_decision'
      AND NEW.target_id = decision.authorization_decision_id
      AND EXISTS (
        SELECT 1
        FROM public.scope_principal_grants recipient_grant
        WHERE recipient_grant.workspace_id = decision.workspace_id
          AND recipient_grant.scope_id = decision.scope_id
          AND recipient_grant.principal_id = NEW.recipient_user_id
          AND recipient_grant.principal_kind = 'user'
          AND recipient_grant.access_kind = 'operation'
          AND recipient_grant.can_approve
          AND recipient_grant.status = 'active'
      )
    INTO source_valid
    FROM public.authorization_decisions decision
    WHERE decision.workspace_id = NEW.workspace_id
      AND decision.authorization_decision_id = NEW.source_id;
  ELSIF NEW.source_domain = 'workflow_run' THEN
    SELECT run.status IN (
        'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
      )
      AND command.quota_user_id = NEW.recipient_user_id
      AND NEW.source_revision = run.event_sequence
      AND NEW.source_cursor = run.run_id || ':' || run.event_sequence::text
      AND NEW.target_kind = 'workflow_run'
      AND NEW.target_id = run.run_id
    INTO source_valid
    FROM public.workflow_runs run
    JOIN public.product_commands command
      ON command.workspace_id = run.workspace_id
     AND command.command_id = run.product_command_id
    WHERE run.workspace_id = NEW.workspace_id
      AND run.run_id = NEW.source_id;
  ELSIF NEW.source_domain = 'workflow_run_review' THEN
    -- The current HTTP authorizer evaluates the personal-scope grant of the
    -- owner. Do not project an apparently actionable review to a broader team
    -- audience until that authority model is implemented end-to-end.
    SELECT review.status = 'pending'
      AND run.status = 'waiting_review'
      AND run.current_node_id = review.node_id
      AND scope.scope_kind = 'personal'
      AND scope.owner_user_id = NEW.recipient_user_id
      AND NEW.source_revision = review.revision
      AND NEW.source_cursor = review.review_id || ':' || review.revision::text
      AND NEW.target_kind = 'workflow_run_review'
      AND NEW.target_id = review.run_id
      AND EXISTS (
        SELECT 1
        FROM public.scope_principal_grants recipient_grant
        WHERE recipient_grant.workspace_id = scope.workspace_id
          AND recipient_grant.scope_id = scope.scope_id
          AND recipient_grant.principal_id = NEW.recipient_user_id
          AND recipient_grant.principal_kind = 'user'
          AND recipient_grant.access_kind = 'operation'
          AND recipient_grant.can_approve
          AND recipient_grant.status = 'active'
          AND recipient_grant.revoked_at IS NULL
      )
    INTO source_valid
    FROM public.workflow_run_reviews review
    JOIN public.workflow_runs run
      ON run.workspace_id = review.workspace_id
     AND run.run_id = review.run_id
    JOIN public.product_scopes scope
      ON scope.workspace_id = run.workspace_id
     AND scope.scope_id = run.scope_id
    WHERE review.workspace_id = NEW.workspace_id
      AND review.review_id = NEW.source_id;
  ELSIF NEW.source_domain = 'automation_occurrence' THEN
    SELECT occurrence.status IN ('misfired', 'skipped', 'blocked')
      AND root.owner_user_id = NEW.recipient_user_id
      AND NEW.source_revision = occurrence.trigger_revision
      AND NEW.source_cursor = occurrence.occurrence_id
      AND NEW.target_kind = 'automation_occurrence'
      AND NEW.target_id = occurrence.occurrence_id
    INTO source_valid
    FROM public.automation_occurrences occurrence
    JOIN public.automations root
      ON root.workspace_id = occurrence.workspace_id
     AND root.automation_id = occurrence.automation_id
    WHERE occurrence.workspace_id = NEW.workspace_id
      AND occurrence.occurrence_id = NEW.source_id;
  ELSIF NEW.source_domain = 'installation_update_draft' THEN
    SELECT draft.created_by = NEW.recipient_user_id
      AND draft.status IN ('pending_review', 'conflicted')
      AND NEW.source_revision = draft.revision
      AND NEW.source_cursor
        = draft.update_draft_id || ':' || draft.revision::text
      AND NEW.target_kind = 'installation_update_draft'
      AND NEW.target_id = draft.update_draft_id
    INTO source_valid
    FROM public.installation_update_drafts draft
    WHERE draft.workspace_id = NEW.workspace_id
      AND draft.update_draft_id = NEW.source_id;
  ELSE
    RAISE EXCEPTION 'inbox_source_authority_unavailable: %', NEW.source_domain
      USING ERRCODE = '0A000';
  END IF;
  IF source_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'inbox_source_or_recipient_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
