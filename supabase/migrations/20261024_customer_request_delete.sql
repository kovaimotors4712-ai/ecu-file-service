-- Let customers permanently remove only their own unpaid, not-yet-delivered private requests.
create or replace function public.forum_delete_own_customer_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.forum_customer_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Please sign in to delete a request.' using errcode = '28000';
  end if;

  select * into r
  from public.forum_customer_requests
  where id = p_request_id and user_id = auth.uid()
  for update;

  if not found then
    raise exception 'Request not found in your account.' using errcode = 'P0002';
  end if;

  if coalesce(r.software_status, '') in ('awaiting_payment','paid','delivered')
     or r.software_payment_link_id is not null
     or r.software_payment_link is not null
     or r.software_delivery_path is not null
     or r.software_delivery_url is not null then
    raise exception 'This request has entered payment or delivery. Use Hide from history instead.' using errcode = '55000';
  end if;

  delete from public.forum_customer_requests
  where id = p_request_id and user_id = auth.uid();
end;
$$;

revoke all on function public.forum_delete_own_customer_request(uuid) from public;
grant execute on function public.forum_delete_own_customer_request(uuid) to authenticated;
