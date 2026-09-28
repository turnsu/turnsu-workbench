-- Fixed result review reuses immutable lifecycle events, existing commands and shared entries.
CREATE UNIQUE INDEX work_item_result_review_once ON public.work_item_lifecycle_events
  (workspace_id,work_item_id,(payload->'resultReview'->>'submissionId'))
  WHERE payload->'resultReview'->>'action'='review';
CREATE FUNCTION public.validate_work_item_result_event() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE action jsonb; entry public.work_thread_entries%ROWTYPE; submission public.work_item_lifecycle_events%ROWTYPE;
BEGIN
 action:=NEW.payload->'resultReview';
 IF action IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO entry FROM public.work_thread_entries WHERE workspace_id=NEW.workspace_id AND work_item_id=NEW.work_item_id AND entry_id=action->>'entryId';
 IF NEW.kind<>'work_item_update' OR entry.entry_id IS NULL OR entry.entry_kind<>'comment' OR entry.content_hash IS DISTINCT FROM action->>'contentHash' OR action->'confirm' IS DISTINCT FROM 'true'::jsonb THEN
   RAISE EXCEPTION 'work_item_result_event_invalid';
 END IF;
 IF action->>'action'='submit' THEN
   IF entry.created_by_user_id<>NEW.actor_user_id OR NEW.status_after<>'waiting_review' THEN RAISE EXCEPTION 'work_item_result_event_invalid'; END IF;
 ELSIF action->>'action'='review' THEN
   SELECT * INTO submission FROM public.work_item_lifecycle_events WHERE workspace_id=NEW.workspace_id AND work_item_id=NEW.work_item_id AND payload->'resultReview'->>'action'='submit' AND target_revision<NEW.target_revision ORDER BY target_revision DESC LIMIT 1;
   IF submission.event_id IS NULL OR submission.event_id IS DISTINCT FROM action->>'submissionId'
     OR submission.payload->'resultReview'->>'entryId' IS DISTINCT FROM action->>'entryId'
     OR submission.payload->'resultReview'->>'contentHash' IS DISTINCT FROM action->>'contentHash'
     OR NEW.actor_user_id<>NEW.accountable_owner_user_id
     OR ((action->>'decision'='accept' AND NEW.status_after='completed') OR (action->>'decision'='request_changes' AND NEW.status_after='active' AND length(btrim(action->>'feedback'))>0)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'work_item_result_event_invalid'; END IF;
 ELSE RAISE EXCEPTION 'work_item_result_event_invalid';
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER work_item_result_event_guard BEFORE INSERT ON public.work_item_lifecycle_events
 FOR EACH ROW EXECUTE FUNCTION public.validate_work_item_result_event();
