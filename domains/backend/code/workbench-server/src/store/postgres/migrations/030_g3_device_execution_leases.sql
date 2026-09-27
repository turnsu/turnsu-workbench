-- G3: A live Desktop connection is not execution authority by itself. Every
-- device dispatch receives a durable lease tied to the existing Invocation,
-- Attempt, Capacity Lease, Capability Lease, authenticated native session,
-- and current socket binding fence.

CREATE TABLE public.device_execution_leases (
  device_execution_lease_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  device_id public.product_identifier NOT NULL,
  native_client_session_id public.product_identifier NOT NULL,
  invocation_id public.product_identifier NOT NULL,
  attempt_id public.product_identifier NOT NULL,
  capability_lease_id public.product_identifier NOT NULL,
  capacity_lease_id public.product_identifier NOT NULL,
  fence integer NOT NULL,
  connection_id public.product_identifier NOT NULL,
  connection_fence integer NOT NULL DEFAULT 1,
  status text COLLATE "C" NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT device_execution_leases_workspace_device_fk
    FOREIGN KEY (workspace_id, device_id)
    REFERENCES public.devices (workspace_id, device_id),
  CONSTRAINT device_execution_leases_native_session_fk
    FOREIGN KEY (native_client_session_id)
    REFERENCES public.native_client_sessions (client_session_id),
  CONSTRAINT device_execution_leases_invocation_workspace_fk
    FOREIGN KEY (workspace_id, invocation_id)
    REFERENCES public.execution_invocations (workspace_id, invocation_id),
  CONSTRAINT device_execution_leases_attempt_fk
    FOREIGN KEY (invocation_id, attempt_id)
    REFERENCES public.execution_attempts (invocation_id, attempt_id),
  CONSTRAINT device_execution_leases_capability_fk
    FOREIGN KEY (invocation_id, attempt_id, capability_lease_id)
    REFERENCES public.capability_leases (invocation_id, attempt_id, capability_lease_id),
  CONSTRAINT device_execution_leases_capacity_fk
    FOREIGN KEY (capacity_lease_id)
    REFERENCES public.capacity_leases (capacity_lease_id),
  CONSTRAINT device_execution_leases_invocation_attempt_uq
    UNIQUE (invocation_id, attempt_id),
  CONSTRAINT device_execution_leases_schema CHECK (
    jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT device_execution_leases_fence_positive CHECK (
    fence >= 1 AND connection_fence >= 1
  ),
  CONSTRAINT device_execution_leases_status CHECK (
    status IN ('active', 'revoked')
  ),
  CONSTRAINT device_execution_leases_time_order CHECK (
    expires_at > issued_at AND updated_at >= issued_at
  ),
  CONSTRAINT device_execution_leases_revocation_state CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  )
);

CREATE INDEX device_execution_leases_active_device_idx
  ON public.device_execution_leases (workspace_id, device_id, expires_at)
  WHERE status = 'active';
CREATE INDEX device_execution_leases_active_connection_idx
  ON public.device_execution_leases (
    device_id, native_client_session_id, connection_id, connection_fence, expires_at
  ) WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.enforce_device_execution_lease_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'device_execution_lease_immutable';
  END IF;
  IF ROW(
    NEW.device_execution_lease_id, NEW.workspace_id, NEW.device_id,
    NEW.native_client_session_id, NEW.invocation_id, NEW.attempt_id,
    NEW.capability_lease_id, NEW.capacity_lease_id, NEW.fence,
    NEW.issued_at, NEW.expires_at, NEW.payload
  ) IS DISTINCT FROM ROW(
    OLD.device_execution_lease_id, OLD.workspace_id, OLD.device_id,
    OLD.native_client_session_id, OLD.invocation_id, OLD.attempt_id,
    OLD.capability_lease_id, OLD.capacity_lease_id, OLD.fence,
    OLD.issued_at, OLD.expires_at, OLD.payload
  ) THEN
    RAISE EXCEPTION 'device_execution_lease_identity_immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'device_execution_lease_time_invalid';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'device_execution_lease_terminal';
  END IF;
  IF NEW.status = 'revoked' THEN
    IF NEW.revoked_at IS NULL
      OR NEW.connection_id <> OLD.connection_id
      OR NEW.connection_fence <> OLD.connection_fence THEN
      RAISE EXCEPTION 'device_execution_lease_revocation_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'device_execution_lease_status_invalid';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER device_execution_leases_transition_guard
  BEFORE UPDATE OR DELETE ON public.device_execution_leases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_device_execution_lease_transition();

CREATE OR REPLACE FUNCTION public.validate_device_execution_lease_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  device_row public.devices%ROWTYPE;
  native_session public.native_client_sessions%ROWTYPE;
  membership_row public.workspace_memberships%ROWTYPE;
  invocation_row public.execution_invocations%ROWTYPE;
  attempt_row public.execution_attempts%ROWTYPE;
  capability_row public.capability_leases%ROWTYPE;
  capacity_row public.capacity_leases%ROWTYPE;
BEGIN
  SELECT * INTO device_row
    FROM public.devices
   WHERE workspace_id = NEW.workspace_id AND device_id = NEW.device_id
   FOR SHARE;
  SELECT * INTO native_session
    FROM public.native_client_sessions
   WHERE client_session_id = NEW.native_client_session_id
   FOR SHARE;
  SELECT * INTO membership_row
    FROM public.workspace_memberships
   WHERE workspace_id = NEW.workspace_id AND user_id = device_row.owner_user_id
   FOR SHARE;
  SELECT * INTO invocation_row
    FROM public.execution_invocations
   WHERE workspace_id = NEW.workspace_id AND invocation_id = NEW.invocation_id
   FOR SHARE;
  SELECT * INTO attempt_row
    FROM public.execution_attempts
   WHERE invocation_id = NEW.invocation_id AND attempt_id = NEW.attempt_id
   FOR SHARE;
  SELECT * INTO capability_row
    FROM public.capability_leases
   WHERE invocation_id = NEW.invocation_id
     AND attempt_id = NEW.attempt_id
     AND capability_lease_id = NEW.capability_lease_id
   FOR SHARE;
  SELECT * INTO capacity_row
    FROM public.capacity_leases
   WHERE capacity_lease_id = NEW.capacity_lease_id
   FOR SHARE;
  IF device_row.device_id IS NULL
    OR native_session.client_session_id IS NULL
    OR membership_row.workspace_id IS NULL
    OR invocation_row.invocation_id IS NULL
    OR attempt_row.attempt_id IS NULL
    OR capability_row.capability_lease_id IS NULL
    OR capacity_row.capacity_lease_id IS NULL
    OR device_row.native_client_session_id <> NEW.native_client_session_id
    OR device_row.registration_status <> 'active'
    OR device_row.worker_protocol_version <> 'workbench-device-worker-v1'
    OR NOT (device_row.capability_inventory @> '["local_deterministic_skill"]'::jsonb)
    OR native_session.client_kind <> 'desktop'
    OR native_session.status <> 'active'
    OR native_session.workspace_id <> NEW.workspace_id
    OR native_session.user_id <> device_row.owner_user_id
    OR membership_row.status <> 'active'
    OR invocation_row.attempt_id <> NEW.attempt_id
    OR invocation_row.isolation <> 'remote'
    OR invocation_row.mode <> 'deterministic_skill'
    OR invocation_row.status <> 'running'
    OR invocation_row.execution_fence <> NEW.fence
    OR invocation_row.capacity_lease_id <> NEW.capacity_lease_id
    OR attempt_row.status <> 'running'
    OR attempt_row.fence <> NEW.fence
    OR capability_row.workspace_id <> NEW.workspace_id
    OR capability_row.status <> 'active'
    OR capability_row.fence <> NEW.fence
    OR capability_row.expires_at < NEW.expires_at
    OR capacity_row.workspace_id <> NEW.workspace_id
    OR capacity_row.status <> 'active'
    OR capacity_row.expires_at < NEW.expires_at
    OR invocation_row.payload #>> '{request,actor,userId}' <> device_row.owner_user_id
    OR invocation_row.payload #>> '{request,metadata,executionRef,capabilityId}'
      <> 'local_deterministic_skill' THEN
    RAISE EXCEPTION 'device_execution_lease_authority_invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER device_execution_leases_authority_guard
  AFTER INSERT ON public.device_execution_leases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_device_execution_lease_authority();

CREATE OR REPLACE FUNCTION public.revoke_device_execution_leases_for_capability_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    UPDATE public.device_execution_leases
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, NEW.updated_at),
           updated_at = NEW.updated_at
     WHERE invocation_id = NEW.invocation_id
       AND attempt_id = NEW.attempt_id
       AND capability_lease_id = NEW.capability_lease_id
       AND status = 'active';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER capability_leases_device_execution_revoke
  AFTER UPDATE OF status ON public.capability_leases
  FOR EACH ROW EXECUTE FUNCTION public.revoke_device_execution_leases_for_capability_lease();

CREATE OR REPLACE FUNCTION public.revoke_device_execution_leases_for_device_state()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.registration_status = 'active' AND NEW.registration_status <> 'active' THEN
    UPDATE public.device_execution_leases
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, NEW.updated_at),
           updated_at = NEW.updated_at
     WHERE workspace_id = NEW.workspace_id
       AND device_id = NEW.device_id
       AND status = 'active';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER devices_device_execution_revoke
  AFTER UPDATE OF registration_status ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.revoke_device_execution_leases_for_device_state();

CREATE OR REPLACE FUNCTION public.revoke_device_execution_leases_for_native_session_state()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revoked_at_value timestamptz;
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    revoked_at_value := COALESCE(NEW.revoked_at, clock_timestamp());
    UPDATE public.device_execution_leases
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, revoked_at_value),
           updated_at = revoked_at_value
     WHERE native_client_session_id = NEW.client_session_id
       AND status = 'active';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER native_client_sessions_device_execution_revoke
  AFTER UPDATE OF status ON public.native_client_sessions
  FOR EACH ROW EXECUTE FUNCTION public.revoke_device_execution_leases_for_native_session_state();

CREATE OR REPLACE FUNCTION public.revoke_device_execution_leases_for_membership_state()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revoked_at_value timestamptz;
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    revoked_at_value := clock_timestamp();
    UPDATE public.device_execution_leases lease
       SET status = 'revoked', revoked_at = COALESCE(lease.revoked_at, revoked_at_value),
           updated_at = revoked_at_value
      FROM public.devices device
     WHERE device.workspace_id = NEW.workspace_id
       AND device.owner_user_id = NEW.user_id
       AND lease.workspace_id = device.workspace_id
       AND lease.device_id = device.device_id
       AND lease.status = 'active';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_memberships_device_execution_revoke
  AFTER UPDATE OF status ON public.workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION public.revoke_device_execution_leases_for_membership_state();
