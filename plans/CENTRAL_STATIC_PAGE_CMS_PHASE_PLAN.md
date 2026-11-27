# Central Static Page Content Management — Safe Implementation Plan

Status: design/audit only. No application code, database, production data, or deployment changed by this document.

## 1. What the repository currently does

- Public HTML pages are served directly from files in the repository.
- `server.js` maintains a hard-coded `publicFiles` allowlist and reads each approved file from disk.
- The homepage and informational pages contain their own SEO metadata, canonical URLs, structured data, navigation, layout, and page-specific markup.
- `/api/admin/site-content` and the Admin "Website Content" section manage rows in `site_announcements` (announcements, offers, and ads). They do not edit static HTML pages.
- Existing software, forum, workshop, announcement, and moderation features already have their own data models and should continue to use them.

## 2. Static page inventory found

Public-facing HTML files currently include:

- Homepage: `index.html`
- Service and technical information: `ecu-file-services.html`, `airbag-crash-clear.html`, `car-electrical-diagnostics.html`, `ecu-fault-code-diagnosis.html`, `ecu-file-identification-original-backup.html`, `international-ecu-file-support.html`
- Guides and diagnostic help: `car-diagnostic-help.html`, `dtc-search.html`, `guides.html`, `vehicle-ecu-wiring-diagnostic-guide.html`
- Community and account information: `membership.html`, `about.html`, `contact.html`, `privacy.html`, `terms.html`
- Existing dynamic feature pages: `forum.html`, `workshops.html`, `store.html`, `announcements.html`, `advertise.html`

Admin-only or special-purpose files such as `admin.html`, `moderation.html`, and verification files must not become public CMS content.

## 3. Recommended architecture

Do not store arbitrary full-page HTML and do not let Admin enter scripts, event handlers, CSS, iframe embeds, or executable markup.

Use a new, separate page-content data model in a future migration, with:
- A stable page key mapped to a fixed allowlist of existing public pages.
- Page title and meta description fields with strict length limits.
- Ordered content sections represented as structured JSON blocks (for example: heading, paragraph, bullet list, safe internal link, and image URL).
- Per-page publish/hidden status, updated timestamp, and editor identity.
- Optional revision history or reversible archive before any permanent deletion.

The server should render only known block types, HTML-escape all text, validate internal links, and reject unsafe URL schemes. Public pages should retain their current repository HTML as the fallback if the CMS row is missing or unavailable.

## 4. Safe first phase

Start with low-risk informational pages only:
- About
- Guides
- Vehicle ECU wiring diagnostic guide
- International ECU file support
- ECU fault-code diagnosis
- ECU identification / original backup information

Initially allow Admin to edit only the main content sections and page-level title/description. Keep navigation, footer, authentication, forms, scripts, CSS, canonical URL, structured data, and payment/order journeys source-controlled and unchanged.

Do not initially allow hide/delete of the homepage, membership, service-request pages, account pages, forum, store, workshop, terms, or privacy pages. These need separate impact checks because they contain critical navigation, user journeys, legal information, or dynamic features.

## 5. Admin permissions and safety

- Admin only for page creation, editing, publishing, hiding, restoring, and deletion.
- Moderators may continue using the existing moderation scope; do not grant them CMS or site-settings access.
- Hide/restore should be the normal removal workflow.
- Permanent deletion must require a second explicit confirmation and retain an audit record.
- Audit every successful create, edit, publish, hide, restore, and delete without storing unnecessary private data.
- Validate page keys against a fixed allowlist; never accept arbitrary file paths from a request.
- Do not expose private contact fields or add phone, WhatsApp, or email contact details to public page content.

## 6. SEO and rendering safeguards

- Preserve each page's current canonical URL and stable URL path.
- Keep title and description unique, escaped, and length-limited.
- Preserve existing JSON-LD and social metadata unless separately reviewed.
- Hidden pages must be removed from sitemap output and return a deliberate not-found response (not a blank page); restore must reinstate the page and sitemap entry.
- Do not change robots.txt, sitemap generation, redirects, or indexing behavior as part of the initial CMS rollout without dedicated tests.
- Verify rendered HTML, page source, mobile layout, internal links, and structured data for every enabled page.

## 7. Required tests before any rollout

1. Unauthenticated users cannot read or mutate Admin CMS endpoints.
2. Moderators cannot create, edit, publish, hide, restore, or delete static pages.
3. Admin can create/edit/publish/hide/restore only allowlisted page keys.
4. Arbitrary paths, scripts, event handlers, unsafe URLs, and malformed block JSON are rejected or safely escaped.
5. Existing HTML fallback works when the database is unavailable or no CMS record exists.
6. Existing title, description, canonical URL, JSON-LD, navigation, and page-specific scripts remain intact.
7. Hidden pages are not publicly served and are excluded from the sitemap; restored pages work again.
8. Existing checkout, Razorpay, authentication, orders, file delivery, forum, store, and workshop tests remain green.

## 8. Explicit rollout boundary

This plan does not authorize a production migration, production data change, merge to `main`, or live deployment. Implementation should remain on `feature/central-admin-content-moderation`; migration and deployment require separate approval after review and tests.
