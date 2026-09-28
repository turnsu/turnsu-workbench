-- Actor-scoped discovery over existing immutable request records.
CREATE INDEX member_agent_requests_requester_page ON public.member_agent_requests
  (workspace_id,work_item_id,requester_user_id,created_at DESC,request_id DESC);
CREATE INDEX member_agent_requests_provider_page ON public.member_agent_requests
  (workspace_id,work_item_id,provider_user_id,created_at DESC,request_id DESC);
