# Forum stage: integration and production gates

## Implemented in this branch
- Responsive forum page with categories, search, topic list, replies, account sign-in/sign-up, profile setup, topic creation and content reporting.
- Admin-only moderation controls to lock/hide topics and review/resolve reports. User content is rendered with DOM text nodes, not interpolated into HTML.
- Static asset allowlist and regression tests for the page, CSS, JavaScript and navigation.
- Additive migration covering public categories, profiles, topics, posts, private reports, moderator audit events, RLS, ownership guards and insert rate limits.

## Mandatory before merge/deploy
1. Verify the production Supabase project and existing migration history.
2. Take/verify a recoverable backup.
3. Review and apply `20261020_forum_core.sql` only to the confirmed production project.
4. Verify table grants, RLS policies, service roles, profile creation, topic/reply ownership, report privacy, moderator actions and rate limits with at least two non-admin test accounts and an admin test account.
5. Run `npm test`, review the full PR diff, and verify existing Razorpay checkout/private downloads on staging.
6. Deploy only when the DB checks pass; otherwise keep the PR open and do not publish the page in production.

## Scope exclusions
- This migration does not change orders, checkout intents, payment providers or the private ECU file bucket.
- Store/membership sales and licensed binary downloads remain disabled.
- Policy drafts are not part of this PR and must be legally reviewed before publication.
