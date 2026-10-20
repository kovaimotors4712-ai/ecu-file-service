# Automotive Forum Beta — Database Verified

The Forum beta is now enabled after applying the additive migration to the verified production project and verifying the core RLS policies and trigger-backed rate limits.

## Live scope
- Public reading for active categories, visible topics and replies.
- Existing customer account sign-in/sign-up, profile creation, topic creation and replies.
- Reports are visible only to their reporter and a trusted moderator; report targets are validated in the database.
- Moderator authority uses trusted `app_metadata.role`, not user-editable profile fields.
- Database rate limits serialize concurrent topic/reply/report submissions.
- Forum UI renders user-generated values through escaping; no binary attachments or file uploads are implemented.

## Safety boundaries
- The forum migration creates only `forum_*` tables/functions/triggers/policies and does not alter orders, checkout intents, Razorpay, notification tables, buckets, or secure ECU file delivery.
- The `private-ecu-files` bucket remains private.
- Do not publish BIN/HEX files, customer data, credentials, VINs, or private download links in discussion posts.
- The licensed store and memberships remain separate, gated work.
- Policy drafts still require business/legal review before publication.

## Verification evidence
- Core forum tables have RLS enabled.
- 13 forum RLS policies, six active categories, and four rate/report triggers were verified.
- A rollback-only integration probe passed for profile/topic/reply creation, visible public reads, and private report access. Probe rows were rolled back; no test records remain.
- CI runs `npm audit`, `npm test`, and JavaScript syntax checks.
- Forum SQL and verification SQL remain blocked from static public serving.
