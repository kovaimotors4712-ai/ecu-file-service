-- Records the production permission hardening for unused legacy request RPCs.
revoke execute on function public.forum_cancel_own_customer_request(uuid) from authenticated;
revoke execute on function public.forum_delete_own_customer_request(uuid) from authenticated;
revoke execute on function public.forum_hide_customer_request(uuid, boolean) from authenticated;
