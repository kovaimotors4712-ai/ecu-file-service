create table if not exists public.forum_customer_request_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.forum_customer_requests(id) on delete cascade,
  sender_role text not null check (sender_role in ('customer','admin')),
  sender_id uuid not null,
  message text not null check (char_length(btrim(message)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists forum_customer_request_messages_request_created_idx
  on public.forum_customer_request_messages(request_id, created_at);
alter table public.forum_customer_request_messages enable row level security;
revoke all on table public.forum_customer_request_messages from anon, authenticated;
grant all on table public.forum_customer_request_messages to service_role;
