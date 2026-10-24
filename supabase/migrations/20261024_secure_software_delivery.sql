-- Store only the private Storage object path and display filename; never a public URL.
alter table public.forum_customer_requests
  add column if not exists software_delivery_path text,
  add column if not exists software_delivery_name text;

alter table public.forum_customer_requests
  drop constraint if exists forum_customer_requests_software_delivery_path_check;
alter table public.forum_customer_requests
  add constraint forum_customer_requests_software_delivery_path_check
  check (
    software_delivery_path is null
    or (
      software_delivery_path like 'software-deliveries/%'
      and position('..' in software_delivery_path)=0
      and position(chr(92) in software_delivery_path)=0
    )
  );
