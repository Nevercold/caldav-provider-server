# CalDAV client request fixtures: sources

Each fixture file holds only the request body. Headers listed below are the ones the
client sets for that request (besides Authorization/User-Agent/Host).

Pinned source revisions:

| Short name | Repository | Revision |
|---|---|---|
| CCS | https://github.com/apple/ccs-calendarserver | `13c706b985fb728b9aab42dc0fef85aae21921c3` |
| TB | https://github.com/mozilla/releases-comm-central (branch `master`, Thunderbird 162.0a1) | `855768e06723f641b5a4178639ff96ce19e44c6b` |
| D4J | https://github.com/bitfireAT/dav4jvm (tag `5.0.0`, the version pinned by DAVx⁵ in `gradle/libs.versions.toml`) | `065bda433e0abe05215287d4cc322bbbabc4fd14` |
| DX | https://github.com/bitfireAT/davx5-ose | `4557610e89152a674913b720dc42d7cdbe9da983` |

URL prefixes used below:

- `CCS/` = `https://github.com/apple/ccs-calendarserver/blob/13c706b985fb728b9aab42dc0fef85aae21921c3/contrib/performance/loadtest/`
- `TB/` = `https://github.com/mozilla/releases-comm-central/blob/855768e06723f641b5a4178639ff96ce19e44c6b/calendar/providers/caldav/`
- `D4J/` = `https://github.com/bitfireAT/dav4jvm/blob/065bda433e0abe05215287d4cc322bbbabc4fd14/src/main/kotlin/at/bitfire/dav4jvm/ktor/`
- `DX/` = `https://github.com/bitfireAT/davx5-ose/blob/4557610e89152a674913b720dc42d7cdbe9da983/core/src/main/kotlin/at/bitfire/davdroid/`

## How the bodies were obtained

- **Apple (apple-calendar, apple-reminders)**: the `request-data/*.request` files of the
  CalendarServer load-test simulator. They are bodies recorded from the real clients
  (`OS_X_10_11` = OS X 10.11 Calendar / CalendarAgent, `OS_X_10_7` = iCal 5 on OS X 10.7,
  `iOS_5` = iOS 5.1 dataaccessd, which syncs both Calendar and Reminders). The recorded request
  sequences are documented in `CCS/request-data/OS_X_10_11/Profile`,
  `CCS/request-data/OS_X_10_11/StartupProfile` and `CCS/request-data/iOS_5/Profile`. Files are copied
  byte-for-byte. Where a template contains Python `%(name)s` placeholders, they were filled
  exactly as the simulator (`CCS/ical.py`) fills them, with neutral values: sync token
  `http://example.com/ns/sync/1234`, hrefs `/calendars/user/...`, addresses `user01@example.com` /
  `user02@example.com`. Depth values are the ones `CCS/ical.py` sends (`_propfind` defaults to
  `Depth: 0`, `_report` defaults to `Depth: 0`, `depth=None` means no Depth header). All Apple
  XML requests use `Content-Type: text/xml` (`CCS/ical.py#L683`, `#L737`).
- **Thunderbird**: bodies are assembled from string literals in the provider source. Each body
  was produced by evaluating the exact source lines (linked below) with Node.js, using the
  real `CalDavUtils.sys.mjs` namespace helpers; only the inputs (property list, href list,
  sync token) were supplied, taken from the call sites linked below. Content-Type is
  `text/xml; charset=utf-8` (`TB/modules/CalDavRequest.sys.mjs#L22`).
- **DAVx⁵**: bodies are the output of dav4jvm 5.0.0 (the request builder DAVx⁵ uses), captured
  from a Ktor `MockEngine` while calling `propfind` / `reportChanges` / `calendarQuery` /
  `multiget` with exactly the property lists and arguments of the DAVx⁵ call sites linked
  below. The serializer output matches the byte-exact assertion in dav4jvm's own test
  (`https://github.com/bitfireAT/dav4jvm/blob/065bda433e0abe05215287d4cc322bbbabc4fd14/src/test/kotlin/at/bitfire/dav4jvm/ktor/DavCalendarTest.kt#L52-L76`).
  All DAVx⁵ XML requests send `Content-Type: application/xml; charset=UTF-8` and
  `Accept: application/xml, text/xml`.

## apple-calendar

| File | Client | Method / headers | Source |
|---|---|---|---|
| `apple-calendar/01-propfind-well-known.xml` | OS X 10.11 Calendar (CalendarAgent) | PROPFIND `/.well-known/caldav/`, `Depth: 0` | `CCS/request-data/OS_X_10_11/startup_well_known_propfind.request`; sent by `CCS/ical.py#L754-L778` |
| `apple-calendar/02-propfind-principal-initial.xml` | OS X 10.11 Calendar | PROPFIND `/principals/`, `Depth: 0` | `CCS/request-data/OS_X_10_11/startup_principal_initial_propfind.request`; `CCS/ical.py#L781-L792` |
| `apple-calendar/03-propfind-principal.xml` | OS X 10.11 Calendar | PROPFIND principal URL, `Depth: 0` | `CCS/request-data/OS_X_10_11/startup_principal_propfind.request`; `CCS/ical.py#L795-L806` |
| `apple-calendar/04-report-principal-search-property-set.xml` | OS X 10.11 Calendar | REPORT `/principals/`, `Depth: 0` | `CCS/request-data/OS_X_10_11/startup_principals_report.request`; `CCS/ical.py#L808-L817` |
| `apple-calendar/05-report-expand-property-proxy.xml` | OS X 10.11 Calendar | REPORT principal URL, no Depth header | `CCS/request-data/OS_X_10_11/startup_principal_expand.request`; `CCS/ical.py#L1605-L1613` |
| `apple-calendar/06-propfind-calendar-home-depth1.xml` | OS X 10.11 Calendar | PROPFIND calendar home, `Depth: 1` | `CCS/request-data/OS_X_10_11/poll_calendarhome_depth1_propfind.request`; `CCS/ical.py#L820-L835` |
| `apple-calendar/07-report-sync-collection-calendar-home.xml` | OS X 10.11 Calendar | REPORT calendar home, `Depth: 1` (token placeholder filled) | `CCS/request-data/OS_X_10_11/poll_calendarhome_sync.request`; `CCS/ical.py#L838-L850` |
| `apple-calendar/08-propfind-calendar-ctag.xml` | OS X 10.11 Calendar | PROPFIND calendar collection, `Depth: 0` | `CCS/request-data/OS_X_10_11/poll_calendar_propfind.request` |
| `apple-calendar/09-report-calendar-query-vevent.xml` | OS X 10.11 Calendar | REPORT calendar collection, `Depth: 1` (per file name and `StartupProfile`) | `CCS/request-data/OS_X_10_11/startup_query_events_depth1_report.request` (concrete recording, no placeholders); listed in `CCS/request-data/OS_X_10_11/StartupProfile` |
| `apple-calendar/10-propfind-calendar-depth1.xml` | OS X 10.11 Calendar | PROPFIND calendar collection, `Depth: 1` | `CCS/request-data/OS_X_10_11/poll_calendar_depth1_propfind.request`; `CCS/ical.py#L1129-L1149` |
| `apple-calendar/11-report-sync-collection-calendar-initial.xml` | iCal 5 / OS X 10.7 (also used by the 10.11 profile) | REPORT calendar collection, `Depth: 1`, empty token = initial sync | `CCS/request-data/OS_X_10_7/poll_calendar_sync.request`; `CCS/ical.py#L1152-L1185` (fallback with `'sync-token': ''`) |
| `apple-calendar/12-report-sync-collection-calendar.xml` | iCal 5 / OS X 10.7 (also used by the 10.11 profile) | REPORT calendar collection, `Depth: 1` | same template as 11, with a token |
| `apple-calendar/13-report-calendar-multiget.xml` | iCal 5 / OS X 10.7 (also used by the 10.11 profile) | REPORT calendar collection, no Depth header | `CCS/request-data/OS_X_10_7/poll_calendar_multiget.request` + `CCS/request-data/OS_X_10_7/poll_calendar_multiget_hrefs.request`; `CCS/ical.py#L1300-L1317`. Note the blank line before the closing tag (the template ends the `%(hrefs)s` line with a newline and each href line also ends with one). |
| `apple-calendar/14-propfind-inbox-depth1.xml` | OS X 10.11 Calendar | PROPFIND schedule inbox, `Depth: 1` | `CCS/request-data/OS_X_10_11/poll_inbox_propfind.request`; `CCS/ical.py#L1592-L1602` |
| `apple-calendar/16-proppatch-calendar-color.xml` | OS X 10.11 Calendar | PROPPATCH calendar collection, `Content-Type: text/xml`, no Depth header | `CCS/request-data/OS_X_10_11/startup_calendar_color_proppatch.request`; sent by `CCS/ical.py#L699-L715` for every calendar from the startup loop `#L1552-L1567` |
| `apple-calendar/17-proppatch-calendar-order.xml` | OS X 10.11 Calendar | PROPPATCH calendar collection | `CCS/request-data/OS_X_10_11/startup_calendar_order_proppatch.request`; same |
| `apple-calendar/18-proppatch-calendar-timezone.xml` | OS X 10.11 Calendar | PROPPATCH calendar collection | `CCS/request-data/OS_X_10_11/startup_calendar_timezone_proppatch.request`; same |
| `apple-calendar/19-proppatch-calendar-displayname.xml` | OS X 10.11 Calendar | PROPPATCH calendar collection | `CCS/request-data/OS_X_10_11/startup_calendar_displayname_proppatch.request` (loaded but commented out in `CCS/ical.py#L2450`) |
| `apple-calendar/20-proppatch-calendar-description.xml` | OS X 10.11 Calendar | PROPPATCH calendar collection | `CCS/request-data/OS_X_10_11/startup_calendar_description_proppatch.request.xml` (recording, not used by the simulator) |
| `apple-calendar/21-proppatch-calendar-transparent.xml` | OS X 10.11 Calendar | PROPPATCH calendar collection | first of the two documents in `CCS/request-data/OS_X_10_11/startup_calendar_transparent_proppatch.request` (the file holds the `transparent` and the `opaque` variant, separated by a blank line; recording, not used by the simulator) |
| `apple-calendar/22-mkcalendar.xml` | OS X 10.11 Calendar | MKCALENDAR new collection (a UUID below the calendar home) | `CCS/request-data/OS_X_10_11/startup_create_calendar.request`, loaded at `CCS/ical.py#L2448` but never sent by the simulator. Its `{name}` placeholders (Python `str.format`) are filled with `order` `2`, `component_type` `VEVENT`, `color` `1BADF8FF`, `name` `Work`; everything else byte-for-byte |
| `apple-calendar/23-propfind-notifications-depth1.xml` | OS X 10.11 Calendar | PROPFIND notification collection, `Depth: 1` | `CCS/request-data/OS_X_10_11/poll_notification_depth1_propfind.request` |
| `apple-calendar/24-post-invite-reply.xml` | OS X 10.11 Calendar (as recorded in the simulator) | POST calendar home, `Content-Type: text/xml` | the recorded example in the docstring at `CCS/ical.py#L1409-L1418`, with the 12 spaces of docstring indentation removed; the simulator builds the same element tree at `#L1419-L1440` and posts it to the calendar home. The tests put the real invitation id into `in-reply-to` |
| `apple-calendar/15-post-outbox-freebusy.ics` | iCal 4/5 (OS X 10.6/10.7, also used by the 10.11 profile) | POST schedule outbox, `Content-Type: text/calendar`, `Originator: mailto:user01@example.com`, `Recipient: mailto:user01@example.com, mailto:user02@example.com` | `CCS/request-data/OS_X_10_7/post_availability.request`; filled per `CCS/ical.py#L2129-L2201`. Not XML: iCalendar body. Line endings are mixed exactly as the simulator sends them (template lines LF, the substituted `ATTENDEE` and `X-CALENDARSERVER-MASK-UID` lines CRLF). |

## apple-reminders

iOS 5 dataaccessd syncs Reminders lists as CalDAV calendars whose
`supported-calendar-component-set` is VTODO; the sim polls those with a VTODO-only
calendar-query (`CCS/ical.py#L2626-L2645`, dispatch in `_updateCalendar` of class `iOS_5`). The
`iOS_5/Profile` shows the requests against `/calendars/__uids__/user01/tasks/`.

| File | Client | Method / headers | Source |
|---|---|---|---|
| `apple-reminders/01-propfind-well-known.xml` | iOS 5.1 dataaccessd | PROPFIND `/.well-known/caldav/`, `Depth: 0` | `CCS/request-data/iOS_5/startup_well_known.request` |
| `apple-reminders/02-propfind-principal-initial.xml` | iOS 5.1 dataaccessd | PROPFIND `/principals/`, `Depth: 0` | `CCS/request-data/iOS_5/startup_principal_propfind_initial.request` |
| `apple-reminders/03-propfind-principal.xml` | iOS 5.1 dataaccessd | PROPFIND principal URL, `Depth: 0` | `CCS/request-data/iOS_5/startup_principal_propfind.request` |
| `apple-reminders/04-report-principal-search-property-set.xml` | iOS 5.1 dataaccessd | REPORT `/principals/`, `Depth: 0` | `CCS/request-data/iOS_5/startup_principals_report.request` |
| `apple-reminders/05-propfind-calendar-home-depth1.xml` | iOS 5.1 dataaccessd | PROPFIND calendar home, `Depth: 1` | `CCS/request-data/iOS_5/poll_calendarhome_propfind.request` |
| `apple-reminders/06-propfind-tasks-ctag.xml` | iOS 5.1 dataaccessd | PROPFIND tasks collection, `Depth: 0` | `CCS/request-data/iOS_5/poll_calendar_propfind.request` |
| `apple-reminders/07-report-calendar-query-vtodo.xml` | iOS 5.1 dataaccessd | REPORT tasks collection, `Depth: 1` | `CCS/request-data/iOS_5/poll_calendar_vtodo_query.request`; `CCS/ical.py#L2626-L2645` |
| `apple-reminders/08-report-calendar-query-vevent-time-range.xml` | iOS 5.1 dataaccessd | REPORT calendar collection, `Depth: 1` (start-only time-range, `%(start-date)s` filled with `20241210`) | `CCS/request-data/iOS_5/poll_calendar_vevent_tr_query.request`; `CCS/ical.py#L2601-L2623` |
| `apple-reminders/09-report-calendar-multiget-vtodo.xml` | iOS 5.1 dataaccessd | REPORT tasks collection, no Depth header | `CCS/request-data/iOS_5/poll_calendar_multiget.request` + `poll_calendar_multiget_hrefs.request`; `CCS/ical.py#L1300-L1317` |
| `apple-reminders/10-propfind-inbox-depth1.xml` | iOS 5.1 dataaccessd | PROPFIND schedule inbox, `Depth: 1` | `CCS/request-data/iOS_5/poll_calendar_propfind_d1.request` |
| `apple-reminders/11-proppatch-calendar-color.xml` | iOS 5.1 dataaccessd | PROPPATCH tasks collection, `Content-Type: text/xml` | `CCS/request-data/iOS_5/startup_calendar_color_proppatch.request`; sent by `CCS/ical.py#L699-L715` from the startup loop `#L1552-L1567` |
| `apple-reminders/12-proppatch-calendar-order.xml` | iOS 5.1 dataaccessd | PROPPATCH tasks collection | `CCS/request-data/iOS_5/startup_calendar_order_proppatch.request`; same |
| `apple-reminders/13-mkcalendar-vtodo.xml` | OS X 10.11 CalendarAgent (which also syncs the Reminders app) | MKCALENDAR new collection | the template of `apple-calendar/22` with `component_type` `VTODO`, `order` `3`, `color` `63DA38FF`, `name` `Groceries` |

## thunderbird

Thunderbird 162.0a1 (comm-central). All XML requests: `Content-Type: text/xml; charset=utf-8`.
Item writes (not fixtures) use `If-None-Match: *` for creates and `If-Match: <etag>` for
updates/deletes (`TB/modules/CalDavRequest.sys.mjs#L660-L672`, `#L705-L713`).

| File | Method / headers | Body builder | Call site (inputs) |
|---|---|---|---|
| `thunderbird/01-propfind-detect-collection.xml` | PROPFIND (account setup, any URL incl. `/.well-known/caldav`), `Depth: 0` | `TB/modules/CalDavRequest.sys.mjs#L750-L760` | `TB/CalDavProvider.sys.mjs#L301-L313` |
| `thunderbird/02-propfind-principal-calendar-home-set.xml` | PROPFIND principal, `Depth: 0` | `TB/modules/CalDavRequest.sys.mjs#L750-L760` | `TB/CalDavProvider.sys.mjs#L361-L363` |
| `thunderbird/03-propfind-calendar-home-depth1.xml` | PROPFIND calendar home, `Depth: 1` | `TB/modules/CalDavRequest.sys.mjs#L750-L760` | `TB/CalDavProvider.sys.mjs#L399-L406` |
| `thunderbird/04-propfind-calendar-resource-type.xml` | PROPFIND calendar collection on startup, `Depth: 0` | `TB/modules/CalDavRequest.sys.mjs#L750-L760` | `TB/CalDavCalendar.sys.mjs#L1574-L1585` |
| `thunderbird/05-propfind-calendar-ctag.xml` | PROPFIND calendar collection (servers without sync-collection), `Depth: 0` | `TB/modules/CalDavRequest.sys.mjs#L750-L760` | `TB/CalDavCalendar.sys.mjs#L1371` |
| `thunderbird/06-propfind-calendar-depth1-etags.xml` | PROPFIND calendar collection (servers without sync-collection), `Depth: 1` | `TB/CalDavCalendar.sys.mjs#L1479-L1495` | same |
| `thunderbird/07-report-sync-collection-initial.xml` | REPORT calendar collection, `Depth: 1` (sent together with `<sync-level>1</sync-level>`, see source comment) | `TB/modules/CalDavRequestHandlers.sys.mjs#L442-L469` | no stored token: `<sync-token/>` |
| `thunderbird/08-report-sync-collection.xml` | REPORT calendar collection, `Depth: 1` | `TB/modules/CalDavRequestHandlers.sys.mjs#L442-L469` | stored token (neutral value) |
| `thunderbird/09-report-calendar-multiget.xml` | REPORT calendar collection, `Depth: 1` | `TB/modules/CalDavRequestHandlers.sys.mjs#L871-L895` | two hrefs (neutral paths) |
| `thunderbird/10-propfind-calendar-home-principal-collection-set.xml` | PROPFIND calendar home, `Depth: 0` (scheduling discovery) | `TB/modules/CalDavRequest.sys.mjs#L750-L760` | `TB/CalDavCalendar.sys.mjs#L1841-L1844` |
| `thunderbird/11-propfind-principal-scheduling.xml` | PROPFIND principal, `Depth: 0` (when principal URL is known) | `TB/modules/CalDavRequest.sys.mjs#L750-L760` | `TB/CalDavCalendar.sys.mjs#L1912-L1921` |
| `thunderbird/12-report-principal-property-search.xml` | REPORT principal collection, `Depth: 1` (when principal URL is unknown; match = calendar home path) | `TB/modules/CalDavRequest.sys.mjs#L993-L1012` | `TB/CalDavCalendar.sys.mjs#L1922-L1931` |

## davx5

DAVx⁵ (davx5-ose at the revision above) with dav4jvm 5.0.0.
Item writes (not fixtures): `If-None-Match: *` on create, `If-Match` + `If-Schedule-Tag-Match`
on update/delete (`DX/resource/remote/BaseWebDavCollection.kt#L60`, `#L165-L169`, `#L189-L193`).

| File | Method / headers | Body builder | Call site (inputs) |
|---|---|---|---|
| `davx5/01-propfind-current-user-principal.xml` | PROPFIND, `Depth: 0` | `D4J/DavResource.kt#L489-L518` | `DX/servicedetection/DavResourceFinder.kt#L431` |
| `davx5/02-propfind-base-url-discovery.xml` | PROPFIND user-given URL, `Depth: 0` | `D4J/DavResource.kt#L489-L518` | `DX/servicedetection/DavResourceFinder.kt#L217-L228` |
| `davx5/03-propfind-principal-home-set.xml` | PROPFIND principal, `Depth: 0` | `D4J/DavResource.kt#L489-L518` | `DX/servicedetection/ServiceRefresher.kt#L66-L80`, `#L113` |
| `davx5/04-propfind-principal-calendar-user-address-set.xml` | PROPFIND principal, `Depth: 0` | `D4J/DavResource.kt#L489-L518` | `DX/servicedetection/DavResourceFinder.kt#L247` |
| `davx5/05-propfind-calendar-home-depth1.xml` | PROPFIND calendar home, `Depth: 1` | `D4J/DavResource.kt#L489-L518` | `DX/servicedetection/HomeSetRefresher.kt#L73-L74`, props from `DX/servicedetection/ServiceDetectionUtils.kt#L21-L44` |
| `davx5/06-propfind-principal-refresh.xml` | PROPFIND principal, `Depth: 0` | `D4J/DavResource.kt#L489-L518` | `DX/servicedetection/PrincipalsRefresher.kt#L41-L57` |
| `davx5/07-propfind-calendar-capabilities.xml` | PROPFIND calendar collection, `Depth: 0` | `D4J/DavResource.kt#L489-L518` | `DX/resource/remote/BaseWebDavCollection.kt#L69-L81` |
| `davx5/08-propfind-calendar-sync-state.xml` | PROPFIND calendar collection, `Depth: 0` | `D4J/DavResource.kt#L489-L518` | `DX/resource/remote/BaseWebDavCollection.kt#L98` |
| `davx5/09-report-sync-collection-initial.xml` | REPORT calendar collection, `Depth: 0` | `D4J/DavCollection.kt#L55-L108` | `DX/resource/remote/BaseWebDavCollection.kt#L100-L107` (no token) |
| `davx5/10-report-sync-collection.xml` | REPORT calendar collection, `Depth: 0` | `D4J/DavCollection.kt#L55-L108` | same, with a token (neutral value) |
| `davx5/11-report-calendar-query-vevent-time-range.xml` | REPORT calendar collection, `Depth: 1` | `D4J/DavCalendar.kt#L60-L124` | `DX/resource/remote/CalDavCollection.kt#L41-L53`, filter from `DX/sync/CalendarSyncer.kt#L94` (start = now minus "past days" setting; value here 2025-01-01T00:00:00Z) |
| `davx5/12-report-calendar-query-vevent.xml` | REPORT calendar collection, `Depth: 1` | `D4J/DavCalendar.kt#L60-L124` | same, "past days" setting unset (no time-range) |
| `davx5/13-report-calendar-query-vtodo.xml` | REPORT task list collection, `Depth: 1` | `D4J/DavCalendar.kt#L60-L124` | `DX/sync/TaskSyncer.kt#L91` |
| `davx5/14-report-calendar-multiget.xml` | REPORT calendar collection, no Depth header | `D4J/DavCalendar.kt#L143-L190` | `DX/resource/remote/CalDavCollection.kt#L56-L67` (two hrefs, neutral paths) |
| `davx5/15-mkcalendar.xml` | MKCALENDAR new collection (a random UUID below the home set) | `DX/repository/DavCollectionRepository.kt#L354-L462` (`generateMkColXml`), sent with `D4J/DavResource.kt#L278-L300` (`mkCol`) | `DX/repository/DavCollectionRepository.kt#L136-L168`; name `Work`, description, color `0xFF2196F3`, timezone id `Europe/Berlin`, VEVENT and VJOURNAL without VTODO. The `calendar-timezone` element (VTIMEZONE from ical4j's registry, `#L419-L432`) is left out because the builder was run without ical4j; the real app also sends it for zone ids ical4j knows. The server reads it like Apple's `calendar-timezone` in `apple-calendar/22` |
| `davx5/16-mkcalendar-all-components.xml` | MKCALENDAR new collection | same | name only, all component types (no `supported-calendar-component-set`) |

## Not found

- **Apple Calendar, macOS 11+ / iOS 13+ bodies**: no public byte-exact recording of current
  CalendarAgent/dataaccessd request bodies was found; the fixtures are from the recorded
  OS X 10.6–10.11 / iOS 5 data in CCS. Newer versions are known to add headers such as
  `Brief: t` / `Prefer: return=minimal`, but no verbatim body/header log was found to cite.
- **Apple Reminders (iOS 13+ / macOS 10.15+)**: the modern Reminders app does not sync over
  CalDAV for upgraded iCloud lists; no recorded CalDAV body from it was found. The
  apple-reminders fixtures are iOS 5 dataaccessd VTODO traffic.
- **Apple VEVENT calendar-query with start and end on iOS**: only the start-only variant
  exists in CCS (`apple-reminders/08`); OS X 10.11 start+end is `apple-calendar/09`.
- **Apple DELETE of a calendar, DAVx⁵ DELETE**: no body, so no fixture. DAVx⁵ sends a plain
  `DELETE` (`DX/repository/DavCollectionRepository.kt#L192-L205`).
- **Thunderbird MKCALENDAR / PROPPATCH**: the CalDAV provider in comm-central sends neither.
- **Thunderbird calendar-query (VEVENT time-range or VTODO)**: Thunderbird does not send
  calendar-query at all; it lists with PROPFIND Depth 1 (`thunderbird/06`) or sync-collection,
  then fetches with calendar-multiget.
- **Thunderbird free-busy POST**: the body is a VFREEBUSY serialized by libical at runtime
  (`TB/modules/CalDavRequest.sys.mjs#L1102-L1148`, headers `Originator`, `Recipient`, method
  `POST`, `Content-Type: text/calendar; charset=utf-8`); no literal or recorded body found.
- **DAVx⁵ free-busy POST / scheduling**: DAVx⁵ does not issue free-busy requests or
  `Schedule-Reply` headers; nothing to collect.
- **`Schedule-Reply` header**: not sent by any of the four clients in the sources examined.
