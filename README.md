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
| `moveCalendar` / `copyCalendar(principal, calendar, newId)` | no | `MOVE` (new id) / `COPY` (duplicate) of a whole calendar |
| `scheduling`                                | no       | enables RFC 6638, see below                                     |
| `searchPrincipals(principal, query)`        | no       | other users to find, e.g. to invite them, see below             |
| `getPrincipal(principal, id)`               | no       | another user by id, for a `PROPFIND` on their principal URL     |
| `delegations(user)`                         | no       | whose calendars the user may use "on behalf of", see below      |
| `delegates(principal)`, `setDelegates(…)`   | no       | the principal's delegates, shown and changed by clients         |
| `sharing`                                   | no       | sharing calendars from the client (Apple Calendar), see below   |
| `properties`                                | no       | storage for properties clients set (e.g. default alarms)        |
| `updatePrincipal(principal, changes)`       | no       | the user renames themselves (`displayname` of the principal)    |
| `publishing`                                | no       | public read-only feeds ("Public Calendar"), see below           |
| `attachments`                               | no       | managed attachments (RFC 8607), see below                       |
| `locks`                                     | no       | `LOCK` / `UNLOCK` storage, see below                            |

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

Objects can be limited in size with the `maxObjectSize` option (bytes), or per calendar with `maxResourceSize`. Larger
`PUT`s answer 403 `max-resource-size`, and clients see the limit as `max-resource-size` of the calendar. Inline
attachments count, managed ones (below) don't.

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
- `MOVE` of a calendar to `/calendars/<principal>/<new id>/` calls `moveCalendar` (a rename of the URL), `COPY`
  calls `copyCalendar`. The destination must not exist; read-only calendars can be copied but not moved. Clients
  rarely do this; generic WebDAV tools do.
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

Clients sometimes read a found user's principal URL afterwards. `getPrincipal(principal, id)` returns the same shape
as a search result, or `null` for users the principal may not see (404); without it such URLs answer 403.

### Delegation

A delegate uses another user's calendars "on behalf of" them (CalendarServer's calendar-proxy model, which Apple
Calendar shows as "Delegates" / "Accounts I can access"). `delegations(user)` says whose calendars the user may use:

```ts
async delegations(user) {
    const rows = await db.delegations.where({delegate: user.id});
    return rows.map(r => ({principal: toPrincipal(r.owner), write: r.canWrite}));
},
```

- The user's principal reports `calendar-proxy-read-for` / `calendar-proxy-write-for` and `group-membership`, and
  `expand-property` resolves them to the owners' names and addresses.
- Requests below `/calendars/<owner>/`, `/inbox/<owner>/`, `/outbox/<owner>/` and `/principals/<owner>/` run as the
  owner: every provider method gets the owner's principal, `current-user-principal` stays the signed-in user. Read
  delegates can't write, create, delete or schedule; write delegates are still limited by `readOnly` of each calendar.
  Changes a write delegate makes are scheduled as the owner.
- With `delegates(principal)` the principal has two proxy groups, `/principals/<id>/calendar-proxy-read/` and
  `calendar-proxy-write/`, whose `group-member-set` lists the delegates. With `setDelegates(principal, write, ids)` the
  client can change them (PROPPATCH of `group-member-set`).

### Sharing

Calendars shared in your backend simply show up in `listCalendars` of every member. To let users share from Apple
Calendar too (CalendarServer's sharing model: "Share Calendar…", invitations, accept/decline), add a `sharing`
provider:

```ts
const sharing: SharingProvider<User> = {
    async sharees(user, calendar) {
        return db.shares(calendar.id).map(s => ({address: `mailto:${s.email}`, displayName: s.name, access: s.access, status: s.status}));
    },
    async share(user, calendar, {set, remove}) {
        // invite, change access, remove; throw CalDavError for addresses you can't share with
    },
    async invitations(user) {
        // invitations to the user: {id, owner, calendarId, address, access, status, summary?}
    },
    async replyToInvitation(user, id, accept) {
        // return the id the calendar has in listCalendars(user) once accepted
    },
    async dismissInvitation(user, id) {},
};
```

- Mark calendars in `listCalendars`: `shared: true` on the owner's shared calendar, `sharedBy` (the owner) on a
  calendar the user sees through a share. Apple shows them accordingly; `sharedBy` calendars can't be shared further.
- The owner POSTs `CS:share` to the calendar; the calendar's `CS:invite` lists the sharees with their status.
- Invitations appear in the user's notification collection (`/notifications/<id>/`, announced as
  `CS:notification-URL`) with `sync-collection` support. The invitee POSTs `CS:invite-reply` to the calendar home,
  which calls `replyToInvitation`; `DELETE` of a notification calls `dismissInvitation`.

Clients that follow the WebDAV resource sharing draft (draft-pot-webdav-resource-sharing) can share through the same
provider: `POST` of `DAV:share-resource` maps onto `share` (`no-access` removes a sharee), and calendars report
`DAV:share-access` and `DAV:invite`. Invitations of that draft's notification format are not sent; invitees answer
through the CalendarServer notifications above or your own UI.

### Other properties

Clients also set properties the server doesn't know, e.g. Apple Calendar's default alarms on the calendar home
(`default-alarm-vevent-date`, `default-alarm-vevent-datetime`), which it sends on every start. With a `properties`
store they are kept and returned on the home, calendars, objects and the principal (WebDAV "dead properties"):

```ts
const properties: PropertyStore<User> = {
    async get(user, path) {
        return db.props.get(path) ?? {}; // {'{urn:ietf:params:xml:ns:caldav}default-alarm-vevent-date': 'BEGIN:VALARM…'}
    },
    async set(user, path, changes) {
        await db.props.merge(path, changes); // a null value removes the property
    },
};
```

Values are the property's content as XML text, so nested elements keep their namespaces. Properties the server
computes itself (`getetag`, `resourcetype`, …) stay protected (403). A `PROPPATCH` that mixes calendar properties and
stored ones is checked as a whole, then `updateCalendar` and `set` are called in that order. Delete stored properties
together with the resource if you like; the server doesn't. `updatePrincipal(principal, {displayName})` lets the user
rename themselves.

### Publishing

Apple Calendar's "Public Calendar" switch publishes a read-only feed (CalendarServer `CS:publish-calendar`). The
URL is yours: return any absolute URL, e.g. a feed you already serve elsewhere.

```ts
const publishing: PublishingProvider<User> = {
    async publishedUrl(user, calendar) {
        return feeds.urlOf(calendar.id); // or null when not published
    },
    async publish(user, calendar) {
        return feeds.create(calendar.id); // e.g. 'webcal://feeds.example.com/<signed token>.ics'
    },
    async unpublish(user, calendar) {}, // optional; without it, switching off is accepted and nothing happens
};
```

Calendars then offer `can-be-published` and report `CS:publish-url`. Read-only calendars and calendars shared with
the user can't be published. Optionally the server serves the feed itself, without login, at
`<basePath>/public/<token>` (`.ics` may be appended): implement `resolveFeed(token)` returning the owner and the
calendar, and return such URLs from `publish`. The feed is one VCALENDAR with all objects, their time zones and
`X-WR-CALNAME`.

### Attachments

With an `attachments` provider, clients upload files to events and to-dos ([RFC 8607](https://www.rfc-editor.org/rfc/rfc8607)
managed attachments, as Apple Calendar does). The provider stores the bytes; the server keeps the `ATTACH` properties
of the object up to date (`MANAGED-ID`, `FILENAME`, `SIZE`, `FMTTYPE`, URL) and stores the object with `putObject`.

```ts
const attachments: AttachmentProvider<User> = {
    async add(user, calendar, objectName, {filename, contentType, data}) {
        return (await blobs.put({calendar: calendar.id, objectName, filename, contentType, data})).id;
    },
    async update(user, calendar, objectName, managedId, input) {
        return (await blobs.replace(managedId, input)).id; // a new id, as RFC 8607 asks
    },
    async remove(user, calendar, objectName, managedId) {
        await blobs.delete(managedId);
    },
    async get(user, managedId) {
        return blobs.readIfVisibleTo(user, managedId); // {filename, contentType, data} or null
    },
    maxSize: 20 * 1024 * 1024,
};
```

- `POST <object>?action=attachment-add` (optionally `&rid=` for single instances, `M` for the master),
  `attachment-update&managed-id=…` and `attachment-remove&managed-id=…`. Deleting an object removes its attachments.
- Files are downloaded from `/dav/attachments/<principal>/<managed-id>`. The URL in `ATTACH` is absolute; set the
  `origin` option (e.g. `https://cal.example.com`) when the server runs behind a proxy, otherwise it is built from
  `X-Forwarded-Proto` and `Host`.
- Request bodies may be bytes (`Uint8Array`/`Buffer`); the Fastify plugin passes them through. Attachment downloads
  answer with bytes as `body`.

### Locking

None of the common CalDAV clients locks, but generic WebDAV tools do. With a `locks` provider the server supports
`LOCK` / `UNLOCK` (WebDAV class 2, `DAV: 1, 2, 3`), `lockdiscovery` and `supportedlock`, and refuses changes to locked
resources with 423 unless the `If` header carries the lock token of the lock's holder. Locks have to be visible to
every server instance; `MemoryLocks` keeps them in memory for a single one:

```ts
import {MemoryLocks} from 'caldav-provider-server';

const provider = {...myProvider, locks: new MemoryLocks()};
```

For several instances, implement `LockProvider` (`find`, `findBelow`, `save`, `remove`) on a shared store such as
Redis or your database. Timeouts default to an hour and are capped at a day.

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

- Changing ACLs: `DAV:acl`, `supported-privilege-set` and `acl-restrictions` are reported (the user's own privileges
  as one protected ACE), the `ACL` method answers 403; who may do what is up to the provider
- Other users' calendars without a delegation: their principal URL answers with `getPrincipal`, their calendar
  home 403
- Locks of unmapped URLs (they would create empty resources). Locks belong to a URL: a shared calendar reached through
  another user's URL is not covered by them
- The invitee side of the WebDAV resource sharing draft (its notifications and replies); invitees use
  CalendarServer's notifications

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
