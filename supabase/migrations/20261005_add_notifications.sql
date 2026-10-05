create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references auth.users(id) on delete cascade not null,
  order_id uuid references public.checkout_intents(id) on delete cascade not null,
  message text not null,
  is_read boolean default false,
  created_at timestamptz default now()
);

create index if not exists notifications_customer_id_idx on public.notifications(customer_id, created_at desc);

alter table public.notifications enable row level security;

create policy "Customers read own notifications" on public.notifications for select to authenticated using (auth.uid() = customer_id);

create policy "Customers mark own notifications as read" on public.notifications for update to authenticated using (auth.uid() = customer_id);
