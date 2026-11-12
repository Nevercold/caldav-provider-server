# caldav-provider-server

A CalDAV server as a library, without storage of its own. The protocol lives here; your data stays where it is and
reaches the server through a small provider interface you implement.

- CalDAV ([RFC 4791](https://www.rfc-editor.org/rfc/rfc4791)) and WebDAV ([RFC 4918](https://www.rfc-editor.org/rfc/rfc4918))
  as far as Apple Calendar, Apple Reminders, Thunderbird and DAVx⁵ need it
- Events (`VEVENT`) and to-dos (`VTODO`), per calendar
- `calendar-query` with time ranges, recurrence expansion and all CalDAV filters, `calendar-multiget`,
  `free-busy-query`; partial `calendar-data` (`comp`/`prop` selection, `expand`, `limit-recurrence-set`)
- `sync-collection` ([RFC 6578](https://www.rfc-editor.org/rfc/rfc6578)) and CTags for cheap syncing
- ETags with `If-Match` / `If-None-Match`, read-only calendars per user
- Creating, renaming, recoloring and deleting calendars from the client (`MKCALENDAR`, extended `MKCOL`, `PROPPATCH`), if
  the provider allows it
- Scheduling ([RFC 6638](https://www.rfc-editor.org/rfc/rfc6638)): invitations, replies and cancellations, free-busy
- `/.well-known/caldav` ([RFC 6764](https://www.rfc-editor.org/rfc/rfc6764)), HTTP Basic auth
- Fastify plugin, and a framework-independent handler `(request) → response` for anything else
- Written in TypeScript

```sh
npm install caldav-provider-server
```

## Usage with Fastify

```ts
import Fastify from 'fastify';
import {caldav} from 'caldav-provider-server/fastify';
import type {CalDavProvider, Principal} from 'caldav-provider-server';

interface User extends Principal {
    teamIds: string[];
}

const provider: CalDavProvider<User> = {
    async authenticate(username, password) {
        const user = await checkAppPassword(username, password);
        return user ? {id: user.id, displayName: user.name, addresses: [user.email], teamIds: user.teamIds} : null;
    },
    async listCalendars(user) {
        return user.teamIds.map((teamId) => ({
            id: teamId,
            displayName: teamName(teamId),
            components: ['VEVENT'],
            syncToken: String(lastChange(teamId)),
            readOnly: !canEdit(user, teamId),
        }));
    },
    async listObjects(user, calendar, query) {
        return (await loadEvents(calendar.id, query.timeRange)).map(toObject);
    },
    async getObject(user, calendar, name) {
        const event = await loadEvent(calendar.id, name.replace(/\.ics$/, ''));
        return event ? toObject(event) : null;
    },
    // optional: changesSince, putObject, deleteObject, scheduling
};

const app = Fastify();
await app.register(caldav, {provider, basePath: '/dav'});
await app.listen({port: 3000});
```

`toObject` turns one of your records into `{name, etag, ics, lastModified?}`, for example with
[ical-generator](https://github.com/sebbo2002/ical-generator) for events and
[ical-vtodo-generator](https://github.com/Nevercold/ical-vtodo-generator) for to-dos. One object holds one event or
to-do (with all its overridden occurrences), so generate one VCALENDAR per record.

The plugin registers its routes below `basePath` and at `/.well-known/caldav`. Register it **without** Fastify's
`prefix` option, the well-known URL has to stay at the root. It is encapsulated: its content type parsers (everything is
read as text) do not affect the rest of your app. If you use `@fastify/cors` or another plugin that answers `OPTIONS`,
exclude the CalDAV paths from it.

## Usage without Fastify

```ts
import {createCalDavHandler, CALDAV_METHODS} from 'caldav-provider-server';

const handle = createCalDavHandler({provider, basePath: '/dav'});

// in any HTTP server, for every method in CALDAV_METHODS:
const res = await handle({method: req.method, url: req.url, headers: req.headers, body: rawBodyAsString});
// res: {status, headers, body?}
```

## URLs

| URL                                  | What                                                    |
| ------------------------------------ | ------------------------------------------------------- |
| `/.well-known/caldav`                | redirects to `/dav/`                                    |
| `/dav/`                              | entry point, tells the client its principal             |
| `/dav/principals/{principal}/`       | the user                                                |
| `/dav/calendars/{principal}/`        | calendar home, lists `listCalendars()`                  |
| `/dav/calendars/{principal}/{calendar}/` | one calendar                                        |
| `/dav/calendars/{principal}/{calendar}/{name}` | one object (`name` usually `{uid}.ics`)       |
| `/dav/inbox/{principal}/`, `/dav/outbox/{principal}/` | scheduling, only with a scheduling provider |

Users only see their own URLs. Shared calendars (team calendars, for example) appear in the home of every user who
gets them from `listCalendars()`, with the same calendar id.

## The provider

All methods are async. Throw a `CalDavError` to answer with a specific status
(`CalDavError.forbidden()`, `CalDavError.preconditionFailed()`, `CalDavError.uidConflict()`, …); any other error
becomes a 500 and is passed to `onError`.

| Method                                      | Required | What it does                                                    |
| ------------------------------------------- | -------- | --------------------------------------------------------------- |
| `authenticate(username, password)`          | yes      | HTTP Basic check, returns the principal or `null`               |
| `listCalendars(principal)`                  | yes      | calendars the user can see                                      |
| `listObjects(principal, calendar, query)`   | yes      | objects of a calendar                                           |
| `getObject(principal, calendar, name)`      | yes      | one object or `null`                                            |
| `getObjects(principal, calendar, names)`    | no       | batch for `calendar-multiget`, defaults to `getObject` per name |
| `changesSince(principal, calendar, token)`  | no       | changes for `sync-collection`, `null` for unknown tokens        |
| `putObject(principal, calendar, input)`     | no       | create or replace; without it everything is read-only           |
| `deleteObject(principal, calendar, input)`  | no       | delete                                                          |
| `moveObject(principal, from, to, input)`    | no       | `MOVE` to another calendar (Apple Calendar moves events so)     |
| `updateCalendar(principal, calendar, changes)` | no    | `PROPPATCH`: name, color, order, description, see below         |
| `createCalendar(principal, id, calendar)`   | no       | `MKCALENDAR` / extended `MKCOL`: a new calendar                 |
| `deleteCalendar(principal, calendar)`       | no       | `DELETE` of a whole calendar                                    |
| `scheduling`                                | no       | enables RFC 6638, see below                                     |
| `searchPrincipals(principal, query)`        | no       | other users to find, e.g. to invite them, see below             |

### Principal

```ts
interface Principal {
    id: string; // URL-safe, stable
    displayName?: string;
    addresses?: string[]; // 'jane@example.com' or 'mailto:jane@example.com', needed for scheduling
}
```

Extend it with whatever you need; the same object comes back in every call.

### Calendar

```ts
interface Calendar {
    id: string; // URL-safe, unique among the user's calendars
    displayName: string;
    description?: string;
    color?: string; // '#RRGGBB' or '#RRGGBBAA'
    order?: number;
    components: ('VEVENT' | 'VTODO')[];
    syncToken: string; // changes whenever an object changes; also used as CTag
    readOnly?: boolean;
    timezone?: string; // VCALENDAR with a VTIMEZONE, for floating times
}
```

`components` decides where the calendar shows up: Apple Reminders lists only calendars with `VTODO`, Apple Calendar
those with `VEVENT`. Clients cope best with one type per calendar, so offer to-dos as calendars of their own.

`syncToken` can be anything that changes with every change in the calendar: a counter, the latest `updated_at`, a hash.

### Objects

```ts
interface CalendarObject {
    name: string; // last URL segment, e.g. 'b3f1….ics'
    etag: string; // changes with the content
    ics: string; // complete VCALENDAR
    lastModified?: Date;
    scheduleTag?: string;
}
```

`listObjects` gets a `query` with `componentType` and `timeRange` when the client asked for them. It is a hint for your
database query: the server filters the result exactly afterwards (including recurrences), so returning too much is
fine, returning too little is not. Recurring events must be returned if any occurrence can fall into the range.

### Writing

```ts
async putObject(user, calendar, {name, uid, ics, componentType, isNew, ifMatch}) {
    // parse ics, store it, return the new ETag
    return {etag};
}
```

The server checks the calendar data (one component type, one UID, type allowed in this calendar), the privileges and
`If-Match` / `If-None-Match` before it calls `putObject`. Check `ifMatch` again in your transaction if you can, and
throw `CalDavError.preconditionFailed()` if it does not match.

Clients choose the object name when they create something, and it does not have to be `{uid}.ics`. Keep the name
together with the record, or throw `CalDavError.forbidden()` for names you cannot store.

If you store exactly the ICS you got, return `storedAsIs: true` and the client keeps its copy. If you store your own
format and generate the ICS anew, leave it out: the client then fetches the object again
([RFC 4791 5.3.4](https://www.rfc-editor.org/rfc/rfc4791#section-5.3.4)), and properties you do not store are gone.

A calendar is read-only for a user if `readOnly` is set or `putObject` / `deleteObject` is missing. The server then
answers `PUT`/`DELETE` with 403 and reports only read privileges, so clients show the calendar as read-only.

### Syncing

Without `changesSince` clients still work: every `sync-collection` with a token answers 403 `valid-sync-token` and the
client does a full sync, which costs a request with all ETags per calendar. With it:

```ts
async changesSince(user, calendar, token) {
    const changes = await loadChangesSince(calendar.id, Number(token));
    if (!changes) return null; // token unknown or too old
    return {syncToken: String(changes.version), changed: changes.updated.map(toObject), deleted: changes.deletedNames};
}
```

Deleted objects need a tombstone (name and version) for as long as clients may come back with an old token.

### Managing calendars

Clients rename and recolor calendars with `PROPPATCH`, create them with `MKCALENDAR` (Apple, DAVx⁵) or extended
`MKCOL` ([RFC 5689](https://www.rfc-editor.org/rfc/rfc5689)) and delete them with `DELETE`. Each needs its hook; without
it the request answers 403 and the client keeps its old state.

```ts
async updateCalendar(user, calendar, {displayName, color, order, description}) {
    // only the properties of the request are set; null means the client removed one
    await db.calendars.update(calendar.id, {name: displayName, color, order, description});
},
async createCalendar(user, id, {displayName, color, order, description, components, timezone}) {
    // id is the URL segment the client chose (often a UUID); listCalendars must return it afterwards
    await db.calendars.insert({id, owner: user.id, name: displayName, color, order, description, components});
},
async deleteCalendar(user, calendar) {
    await db.calendars.delete(calendar.id);
},
```

- `PROPPATCH` handles `displayname`, `calendar-color` (`#RRGGBB` or `#RRGGBBAA`), `calendar-order`,
  `calendar-description`, `calendar-timezone` (as `timezone`) and `schedule-calendar-transp` (as `transparent`; events
  of transparent calendars don't count in free-busy lookups). Other properties answer 403, invalid values 409. The update is atomic
  ([RFC 4918 9.2](https://www.rfc-editor.org/rfc/rfc4918#section-9.2)): if one property fails, the others answer 424
  and `updateCalendar` is not called. A `CalDavError` you throw sets the status of every property.
- `readOnly` calendars can't be changed or deleted; the server answers 403 without calling the provider. Writable
  calendars report the `write-properties` privilege, the calendar home `bind` / `unbind` when the hooks exist.
- `MKCALENDAR` takes the same properties and also accepts what clients send along: `calendar-timezone-id` (ignored)
  and `supported-calendar-component-set`, of which `VJOURNAL`
  is dropped as long as `VEVENT` or `VTODO` remains. Without a component set the calendar gets `VEVENT` and `VTODO`.
  If a property can't be set, nothing is created (403 with `mkcalendar-response` / `mkcol-response`).
- Change the calendar's `syncToken` when its properties change too, so the next home `sync-collection` reports the
  calendar to the user's other devices.

### Scheduling

With a `scheduling` provider, the server does implicit scheduling as described in RFC 6638:

- The **organizer** saves an event with attendees → `REQUEST` to all attendees. Changes to time, place, title,
  description, recurrence or status send a new `REQUEST`; removed attendees get a `CANCEL`; deleting the event cancels
  it for everybody.
- An **attendee** changes the own participation status → `REPLY` to the organizer. Deleting the event declines it
  (unless the client sends `Schedule-Reply: F`).
- `SCHEDULE-STATUS` is written back to the organizer's copy, `SCHEDULE-AGENT=CLIENT` is respected.
- `POST` to the outbox: free-busy queries (Apple's availability view) and messages of clients that schedule themselves.

You deliver the messages:

```ts
import {processSchedulingMessage} from 'caldav-provider-server';

const scheduling: SchedulingProvider<User> = {
    async deliver({method, uid, recipients, ics, sender}) {
        const result = {};
        for (const recipient of recipients) {
            const user = await findUserByEmail(recipient);
            if (!user) {
                await sendInvitationMail(recipient, ics); // iMIP, if you want
                result[recipient] = '1.1'; // sent
                continue;
            }
            const existing = await findEventByUid(user, uid);
            const {ics: updated} = processSchedulingMessage(ics, existing?.ics ?? null, recipient);
            if (updated) await saveEvent(user, uid, updated);
            result[recipient] = '1.2'; // delivered
        }
        return result;
    },
    async findPrincipal(address) {
        return findUserByEmail(address); // for free-busy
    },
};
```

`processSchedulingMessage(itip, existing, recipient)` applies a message to the recipient's copy the way a CalDAV server
with automatic processing does: a `REQUEST` creates or updates the event (own participation status and alarms survive
updates without a new `SEQUENCE`), a `CANCEL` marks it cancelled, a `REPLY` updates the attendee's status in the
organizer's copy.

Status codes per recipient: `1.1` sent (e.g. by mail), `1.2` delivered, `3.7` unknown user, `5.1` could not deliver,
`5.3` the user cannot receive invitations. Free-busy answers for every user that `findPrincipal` returns; return `null`
for users whose availability others must not see.

If your availability data lives elsewhere (absences, working hours) or depends on who asks, implement `freeBusy`
instead. It takes precedence over `findPrincipal`:

```ts
async freeBusy(requester, address, {start, end}, maskUid) {
    if (!sharesATeam(requester, address)) return null; // answered 3.7
    return (await busyTimes(address, start, end, maskUid)).map(b => ({start: b.from, end: b.to, type: b.maybe ? 'BUSY-TENTATIVE' : 'BUSY'}));
},
```

Periods are clipped to the asked range; `maskUid` is the event being planned (Apple's `X-CALENDARSERVER-MASK-UID`).

Scheduling inbox: Clients get messages through the server's automatic processing, not through the inbox, so the inbox
is empty unless you implement `listInbox` / `deleteInboxItem`.

### Finding other users

Calendar apps suggest attendees while you type: Apple with `calendarserver-principal-search`, others with
`principal-property-search`. Implement `searchPrincipals` to answer with the users the principal may invite; the client
then puts their address in the event, which your scheduling provider recognizes:

```ts
async searchPrincipals(principal, {terms, test, limit}) {
    const users = await usersVisibleTo(principal, terms, test === 'allof', limit ?? 50);
    return users.map(u => ({id: u.id, displayName: u.name, addresses: [`mailto:${u.email}`]}));
},
```

Results answer `displayname`, `calendar-user-address-set`, `email-address-set`, `principal-URL` and `calendar-user-type`.
Without it, a search only finds the signed-in user (Thunderbird looks itself up that way) and no searchable properties
are offered.

## Clients

The tests replay request bodies of real clients against the server (`test/fixtures`, sources and how each body was
obtained in [`test/fixtures/SOURCES.md`](test/fixtures/SOURCES.md)).

| Client                         | Fixtures from                                    | What it uses                                                                                     |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Apple Calendar (macOS, iOS)    | recordings in Apple's CalendarServer (OS X 10.7–10.11) | well-known, principal, calendar home with `sync-collection`, CTag, `calendar-query`, multiget, free-busy |
| Apple Reminders                | recordings in Apple's CalendarServer (iOS 5)     | calendars with `VTODO`, `calendar-query` for `VTODO`, multiget                                   |
| Thunderbird                    | Thunderbird source (comm-central)                | PROPFIND Depth 1 or `sync-collection` for ETags, then multiget; no `calendar-query`              |
| DAVx⁵                          | dav4jvm 5.0.0 with the property lists of DAVx⁵   | `sync-collection` (Depth 0), `calendar-query` for events and to-dos, multiget with `Schedule-Tag` |

Notes per client:

- **Apple Calendar** only shows calendars with `VEVENT`, **Apple Reminders** only those with `VTODO`. Shared
  calendars without write privileges are reported read-only.
- **Apple Calendar** sends `PROPPATCH` for `calendar-color`, `calendar-order` and `calendar-timezone` of every calendar
  on startup and whenever the user changes them, `schedule-calendar-transp` for "Ignore in availability". Color and
  order are per user in Apple's view: if your calendars are shared, one user's change reaches everybody.
  New calendars and reminder lists come as `MKCALENDAR` with a UUID as id.
- **DAVx⁵** creates calendars with `MKCALENDAR` (name, color, description, `calendar-timezone-id`, a component set if not
  all types are wanted) and deletes them with `DELETE`. **Thunderbird** neither creates nor changes server calendars.
- **Apple** polls the calendar home with `sync-collection`; the home sync token is computed from the calendars' tokens,
  so it needs no storage.
- **Apple Calendar** moves an event to another calendar with `MOVE` (`Destination`, `Overwrite: F`); implement
  `moveObject` to keep it the same event. Without it, `MOVE` answers 403 and the app tries `PUT` + `DELETE` instead.
- **Thunderbird** finds the scheduling inbox and outbox through `principal-collection-set` and the principal.
- **DAVx⁵** uses `If-Schedule-Tag-Match` when scheduling is enabled; without `scheduleTag` in your objects the ETag is
  used.
- Sync tokens of other servers (e.g. after moving an account) are answered with 403 `valid-sync-token`, and all clients
  then start a full sync.

The fixtures are request bodies, not complete sessions. Newer macOS and iOS versions send the same requests with some
more properties; check a setup with the example server below, and `RECORD=…` to write down what a client sends.

## What is not supported

- `PROPPATCH` of anything but calendars
- ACLs (`DAV:acl`), locking; `MOVE` and `COPY` only of objects between calendars (`COPY` stores the copy with
  `putObject` and sends no invitations)
- Reading other principals' resources: a found principal's URL answers 403; clients only need its search result
- Delegation and proxies (`calendar-proxy-*`), sharing invitations (`CS:invite`)
- Attachments (managed attachments, RFC 8607)

## Example server

`example/server.ts` runs the server with an in-memory provider: two users, a personal calendar each, a team calendar
that is read-only for Bob and a to-do list for both.

```sh
npm install
npm run example
# CalDAV server: http://localhost:5232/dav/ (users alice/alice and bob/bob)
```

With `RECORD=./recordings npm run example` every request and response is written to `./recordings` as JSON.

### macOS Calendar and Reminders

1. System Settings → Internet Accounts → Add Account → Add Other Account → CalDAV Account
2. Account Type: **Manual**, User Name `alice`, Password `alice`, Server Address `http://localhost:5232/dav/`
3. Calendar shows "Personal" and "Team (read-only for Bob)", Reminders shows "Team to-dos".

macOS also accepts `http://` for local servers; for an iPhone in the same network use the Mac's IP address instead of
`localhost`. With "Advanced" the server path is `/dav/` and the port `5232`, SSL off.

Log in as `bob` on a second Mac (or with a second account) to see the read-only calendar and to try invitations:
invite `bob@example.com` from Alice's calendar and the event appears in Bob's calendar.

### Thunderbird

New Calendar → On the Network → Username `alice`, Location `http://localhost:5232/dav/` → Find Calendars.

### DAVx⁵

Login with URL and user name → Base URL `http://<ip-of-your-machine>:5232/dav/`, user `alice`, password `alice`.

## License

MIT
