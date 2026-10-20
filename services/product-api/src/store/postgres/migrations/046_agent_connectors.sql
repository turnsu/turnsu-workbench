CREATE TABLE public.agent_connector_accounts (
  id text PRIMARY KEY, workspace_id text NOT NULL, user_id text NOT NULL,
  provider text NOT NULL CHECK(provider IN ('workbuddy','muse')), name text NOT NULL,
  credentials text, scopes jsonb NOT NULL DEFAULT '[]', native_account text,
  expires_at timestamptz, refresh_pending boolean NOT NULL DEFAULT false,
  connector_key_hash text UNIQUE, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,user_id,id)
);
CREATE INDEX agent_connector_accounts_owner ON public.agent_connector_accounts(workspace_id,user_id,created_at);
CREATE TABLE public.agent_connector_authorizations (
  state_hash text PRIMARY KEY, workspace_id text NOT NULL, user_id text NOT NULL,
  provider text NOT NULL, requested_scopes jsonb NOT NULL, expires_at timestamptz NOT NULL,
  consumed_at timestamptz, status text NOT NULL DEFAULT 'pending', connection_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.agent_connector_tasks (
  id text PRIMARY KEY, workspace_id text NOT NULL, user_id text NOT NULL, connection_id text NOT NULL,
  agent text NOT NULL, native_id text, state text NOT NULL, payload text NOT NULL,
  waiting text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  FOREIGN KEY(workspace_id,user_id,connection_id) REFERENCES public.agent_connector_accounts(workspace_id,user_id,id)
);
CREATE INDEX agent_connector_tasks_owner ON public.agent_connector_tasks(workspace_id,user_id,updated_at);
CREATE TABLE public.agent_connector_mutations (
  workspace_id text NOT NULL, user_id text NOT NULL, request_id text NOT NULL,
  request_hash text NOT NULL, task_id text, status text NOT NULL, receipt text,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id,request_id)
);
CREATE TABLE public.agent_connector_events (
  sequence bigserial PRIMARY KEY, task_id text NOT NULL REFERENCES public.agent_connector_tasks(id) ON DELETE CASCADE,
  event_key text NOT NULL, payload text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,event_key)
);
CREATE INDEX agent_connector_events_cursor ON public.agent_connector_events(task_id,sequence);
CREATE TABLE public.agent_connector_local_requests (
  id text PRIMARY KEY, task_id text NOT NULL REFERENCES public.agent_connector_tasks(id) ON DELETE CASCADE,
  input text NOT NULL, status text NOT NULL DEFAULT 'pending', result text, created_at timestamptz NOT NULL DEFAULT now()
);
