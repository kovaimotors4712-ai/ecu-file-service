-- Create order messages table
create table if not exists public.order_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  order_id uuid not null,
  customer_id uuid not null,
  sender_type text not null check (sender_type in ('customer', 'admin')),
  message text not null check (length(trim(message)) between 1 and 2000),
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  constraint order_messages_order_owner_fk foreign key (order_id, customer_id)
    references public.orders(id, customer_id) on delete cascade
);

create index if not exists order_messages_order_created_idx on public.order_messages(order_id, created_at asc);
create index if not exists order_messages_customer_unread_idx on public.order_messages(customer_id, is_read) 
  where sender_type = 'admin' and is_read = false;

alter table public.order_messages enable row level security;

create policy "Customers manage own order messages" on public.order_messages
  for all to authenticated
  using (auth.uid() = customer_id)
  with check (auth.uid() = customer_id);

create policy "Admins manage order messages" on public.order_messages
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
