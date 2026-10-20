# Forum Core (Staged, Not Public)

This bundle adds the first forum layer: public category/topic/reply reading, signed-in topic/reply creation, public display names, private-to-reporter/moderator abuse reports, and database-side posting limits.

## Safety gates

- The new page assets are committed but deliberately **not** added to the server's public-file allowlist, homepage navigation, or sitemap. /forum.html must continue returning 404 until the real database migration has been reviewed and verified.
- The migration is additive and creates only forum_* tables, indexes, functions, triggers and RLS policies. It does not modify ECU orders, checkout intents, Razorpay, notification tables, storage buckets, or existing private-file delivery.
- No forum attachments/file uploads are implemented. Public posts must not contain ECU BIN/HEX files, private download URLs, credentials, customer names, phone numbers, VINs or registration details.
- Moderation authority uses trusted app_metadata.role (admin or moderator), not user-editable profile metadata.
- Rate limiting and self-report rejection are enforced in PostgreSQL triggers as well as the client.
- SQL has **not** been applied to any database. Before activation, inspect production project identity, migration history, existing RLS and backup/recovery state; then apply the migration once in the verified project and run supabase/verify_forum_core.sql.
- Only after database verification and authenticated tests pass should a separate change add the forum files to the public static allowlist, homepage navigation and sitemap.

## Checks

The repository CI should run the existing service suite plus JavaScript syntax validation. server.test.js also verifies the forum page remains hidden while the forum is staged.
