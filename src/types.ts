/** The authenticated user. Extend it with whatever your provider needs. */
export interface Principal {
    /** URL-safe, stable id. Becomes part of every URL of this user. */
    id: string;
    displayName?: string;
    /**
     * Calendar user addresses (RFC 6638), e.g. `mailto:jane@example.com`.
     * Plain e-mail addresses are accepted and prefixed with `mailto:`.
     * Needed for scheduling: the server recognizes the user as organizer or
     * attendee by these addresses.
     */
    addresses?: string[];
}

export type ComponentType = 'VEVENT' | 'VTODO';

export interface Calendar {
    /** URL-safe, stable id, unique among the calendars of one principal. */
    id: string;
    displayName: string;
    description?: string;
    /** `#RRGGBB` or `#RRGGBBAA` (Apple calendar-color). */
    color?: string;
    /** Sort order for Apple clients (calendar-order). */
    order?: number;
    /**
     * Component types stored in this calendar. Apple Reminders only shows
     * calendars that contain `VTODO`, Apple Calendar those with `VEVENT`.
     */
    components: ComponentType[];
    /**
     * Opaque token that changes whenever an object in the calendar changes.
     * Used as sync-token (RFC 6578) and CTag.
     */
    syncToken: string;
    /** No PUT/DELETE for this principal. Defaults to false if `putObject` exists. */
    readOnly?: boolean;
    /** VTIMEZONE (full VCALENDAR text) for floating times, see RFC 4791 5.2.2. */
    timezone?: string;
    /**
     * Events of this calendar don't make the user busy in free-busy lookups
     * (schedule-calendar-transp, RFC 6638 9.1). Default false.
     */
    transparent?: boolean;
    /**
     * Server-wide id of the calendar, the same for every user who sees it (a shared calendar has
     * one URL per user). Only used for locks: with it, a lock covers the calendar under all its URLs.
     */
    globalId?: string;
    /** Largest object in bytes clients may store here (max-resource-size); overrides `maxObjectSize`. */
    maxResourceSize?: number;
    /** The user's own calendar, shared with others (Apple shows it as shared). */
    shared?: boolean;
    /** Somebody else's calendar the user sees through a share. Can't be shared further. */
    sharedBy?: PrincipalSearchResult;
}

export type ShareAccess = 'read' | 'read-write';
export type ShareStatus = 'pending' | 'accepted' | 'declined';

/** Someone a calendar is shared with. */
export interface Sharee {
    /** Calendar user address (`mailto:…`). */
    address: string;
    displayName?: string;
    access: ShareAccess;
    status: ShareStatus;
}

/** What the owner changes in a share dialog (CalendarServer `CS:share`). */
export interface ShareChanges {
    /** Invite these or change their access. */
    set: {address: string; displayName?: string; summary?: string; access: ShareAccess}[];
    /** Addresses to remove from the share. */
    remove: string[];
}

/** An invitation to a shared calendar, shown to the invitee as a notification. */
export interface Invitation {
    /** Stable id; becomes the notification's name and the reply's `in-reply-to`. */
    id: string;
    owner: PrincipalSearchResult;
    /** Id of the shared calendar among the owner's calendars. */
    calendarId: string;
    /** The invitee's own address this invitation was sent to. */
    address: string;
    access: ShareAccess;
    status: ShareStatus;
    summary?: string;
    components?: ComponentType[];
    created?: Date;
}

/** Calendar sharing as Apple Calendar does it (CalendarServer caldav-sharing). */
export interface SharingProvider<P extends Principal = Principal> {
    /** People the principal's calendar is shared with, for the `CS:invite` property. */
    sharees(principal: P, calendar: Calendar): Promise<Sharee[]>;
    /** Invite, change or remove sharees. Throw `CalDavError` for addresses you can't share with. */
    share(principal: P, calendar: Calendar, changes: ShareChanges): Promise<void>;
    /** Invitations to the principal. Without it, invitations have to be accepted elsewhere. */
    invitations?(principal: P): Promise<Invitation[]>;
    /**
     * The invitee accepts or declines. Return the id of the calendar the share now appears
     * as in `listCalendars` (accepted), or null.
     */
    replyToInvitation?(principal: P, invitationId: string, accept: boolean): Promise<string | null>;
    /** The invitee dismissed the notification (DELETE). */
    dismissInvitation?(principal: P, invitationId: string): Promise<void>;
}

export interface CalendarObject {
    /**
     * Resource name, the last URL segment, e.g. `"<uid>.ics"`. For objects
     * created by the provider itself `${uid}.ics` is the usual choice; objects
     * created by clients keep the name the client chose.
     */
    name: string;
    /** Changes whenever the content changes. With or without quotes. */
    etag: string;
    /** Full VCALENDAR text. */
    ics: string;
    lastModified?: Date;
    /**
     * Schedule-Tag (RFC 6638 3.2.10). Leave it out to use the ETag, which is
     * correct but makes clients re-fetch more often.
     */
    scheduleTag?: string;
}

export interface TimeRange {
    start?: Date;
    end?: Date;
}

export interface ObjectQuery {
    componentType?: ComponentType;
    timeRange?: TimeRange;
}

export interface Changes {
    /** The new token, usually the calendar's current syncToken. */
    syncToken: string;
    /** Objects created or changed since the given token. */
    changed: CalendarObject[];
    /** Names of objects deleted since the given token. */
    deleted: string[];
}

export interface PutObjectInput {
    name: string;
    uid: string;
    ics: string;
    componentType: ComponentType;
    /** True if no object with this name existed when the request came in. */
    isNew: boolean;
    /** The ETag the client expects (If-Match), without quotes. Check it atomically if you can. */
    ifMatch?: string;
}

export interface PutObjectResult {
    /** ETag of the stored object. */
    etag: string;
    scheduleTag?: string;
    /**
     * True if the stored object is byte for byte the ICS from the request.
     * Only then the ETag goes back to the client (RFC 4791 5.3.4); otherwise
     * the client fetches the object again. Leave it out if you store the data
     * in your own format and generate the ICS anew.
     */
    storedAsIs?: boolean;
}

export interface DeleteObjectInput {
    name: string;
    ifMatch?: string;
}

export interface MoveObjectInput {
    /** The object's name in the source calendar. */
    name: string;
    /** Its name in the target calendar (usually the same). */
    destinationName: string;
    /** An object with that name in the target may be replaced (`Overwrite: T`, the default). */
    overwrite: boolean;
    /** The ETag the client expects of the source (If-Match), without quotes. */
    ifMatch?: string;
}

/**
 * Calendar properties a client changes with PROPPATCH. Only the properties of
 * the request are present; `null` means the client removed the property.
 */
export interface CalendarChanges {
    displayName?: string | null;
    /** `#RRGGBB` or `#RRGGBBAA`. */
    color?: string | null;
    order?: number | null;
    description?: string | null;
    /** VCALENDAR with one VTIMEZONE (calendar-timezone). */
    timezone?: string | null;
    /** schedule-calendar-transp; `null` (removed) means opaque again. */
    transparent?: boolean | null;
}

/** A calendar a client creates with MKCALENDAR or extended MKCOL. */
export interface NewCalendar {
    /** The client's name, or the id if it sent none. */
    displayName: string;
    color?: string;
    order?: number;
    description?: string;
    /** From supported-calendar-component-set; `['VEVENT', 'VTODO']` if the client sent none. */
    components: ComponentType[];
    /** VCALENDAR with the VTIMEZONE the client sent (calendar-timezone), if any. */
    timezone?: string;
    /** The client asked for a transparent calendar (schedule-calendar-transp). */
    transparent?: boolean;
}

/** An iTIP message (RFC 5546) the server wants delivered. */
export interface SchedulingMessage<P extends Principal = Principal> {
    method: 'REQUEST' | 'REPLY' | 'CANCEL' | 'ADD' | 'REFRESH' | 'COUNTER' | 'DECLINECOUNTER' | 'PUBLISH';
    uid: string;
    /** Calendar user address of the sender (`mailto:…`). */
    originator: string;
    /** The principal on whose behalf the message is sent. */
    sender: P;
    /** Calendar user addresses (`mailto:…`). */
    recipients: string[];
    /** VCALENDAR with METHOD. */
    ics: string;
}

/**
 * RFC 6638 request status per recipient, e.g. `1.2` (delivered), `1.1`
 * (pending, e.g. e-mail queued), `3.7` (unknown user), `5.1` (could not deliver).
 */
export type ScheduleStatus = `${number}.${number}` | `${number}.${number}.${number}`;

/** A busy time of a free-busy answer (RFC 5545 3.2.9 FBTYPE). */
export interface BusyPeriod {
    start: Date;
    end: Date;
    /** Default `BUSY`. */
    type?: 'BUSY' | 'BUSY-TENTATIVE' | 'BUSY-UNAVAILABLE';
}

export interface SchedulingProvider<P extends Principal = Principal> {
    /**
     * Deliver an iTIP message: put it into the calendars of local users
     * (see `processSchedulingMessage`) and/or send it by e-mail (iMIP).
     * Return a status per recipient; missing recipients count as `5.1`.
     */
    deliver(message: SchedulingMessage<P>): Promise<Record<string, ScheduleStatus>>;
    /**
     * Resolve a calendar user address to a local principal. Used for
     * free-busy lookups. Without it, free-busy only answers with `3.7`.
     */
    findPrincipal?(address: string): Promise<P | null>;
    /**
     * Busy times of a calendar user for a free-busy lookup by `requester`
     * (RFC 6638 5), e.g. from your own availability data. Return null if the
     * address is unknown or not visible to the requester (answered `3.7`).
     * `maskUid` is the event being planned, to leave out. Takes precedence
     * over `findPrincipal`, which reads the user's calendars instead.
     */
    freeBusy?(requester: P, address: string, range: {start: Date; end: Date}, maskUid?: string): Promise<BusyPeriod[] | null>;
    /** Items of the scheduling inbox. Without it, the inbox is empty. */
    listInbox?(principal: P): Promise<CalendarObject[]>;
    deleteInboxItem?(principal: P, name: string): Promise<void>;
}

/** Another calendar user found by a principal search (e.g. to invite them). */
export interface PrincipalSearchResult {
    /** URL-safe id; becomes the principal URL like a signed-in principal's id. */
    id: string;
    displayName?: string;
    /** Calendar user addresses (`mailto:…`; plain e-mail addresses are prefixed). Clients invite by these. */
    addresses: string[];
}

export interface PrincipalSearchQuery {
    /** Search terms as typed, at least one. */
    terms: string[];
    /** `allof`: every term must match; `anyof`: one is enough. */
    test: 'anyof' | 'allof';
    /** Apple's search context, e.g. `attendee` when inviting, if given. */
    context?: string;
    /** Most results the client wants, if given. */
    limit?: number;
}

/**
 * Storage of properties clients set and the server doesn't know itself ("dead properties",
 * RFC 4918 4.2), e.g. Apple's default alarms on the calendar home. Keys are
 * `{namespace}name`, values the property's content as XML.
 */
export interface PropertyStore<P extends Principal = Principal> {
    /** All stored properties of a resource, by path (e.g. `/dav/calendars/jane/`). */
    get(principal: P, path: string): Promise<Record<string, string>>;
    /** Set (string) or remove (null) properties of a resource, all or none. */
    set(principal: P, path: string, changes: Record<string, string | null>): Promise<void>;
}

/**
 * Publishing a calendar as a read-only feed (Apple's "Public Calendar", CalendarServer
 * CS:publish-calendar). The URL can be anything, e.g. a feed you already serve elsewhere.
 */
export interface PublishingProvider<P extends Principal = Principal> {
    /** The public URL if the calendar is published, else null (CS:publish-url). */
    publishedUrl(principal: P, calendar: Calendar): Promise<string | null>;
    /** Publish and return the public URL (absolute, e.g. `webcal://…` or `https://…`). */
    publish(principal: P, calendar: Calendar): Promise<string>;
    /**
     * The URL the calendar would get when published (CS:pre-publish-url, which Apple shows in the
     * "Public Calendar" setting and reads for every calendar). Defaults to `publishedUrl`.
     */
    previewUrl?(principal: P, calendar: Calendar): Promise<string | null>;
    /** Stop publishing. Without it, unpublishing is accepted and nothing happens (the URL stays valid). */
    unpublish?(principal: P, calendar: Calendar): Promise<void>;
    /**
     * Optional: let the server serve the feed itself, without login, at `<basePath>/public/<token>`
     * (`.ics` may be appended). Return the calendar for a token, or null (404). Return URLs of that
     * form from `publish` to use it.
     */
    resolveFeed?(token: string): Promise<{principal: P; calendar: Calendar} | null>;
}

/** An uploaded attachment (RFC 8607). */
export interface AttachmentInput {
    filename: string;
    contentType: string;
    data: Uint8Array;
}

/** Managed attachments (RFC 8607): the provider stores the files, the server keeps ATTACH in the objects. */
export interface AttachmentProvider<P extends Principal = Principal> {
    /** Store a new attachment of an object and return its id (URL-safe). */
    add(principal: P, calendar: Calendar, objectName: string, input: AttachmentInput): Promise<string>;
    /** Replace an attachment's content. Return the new id (RFC 8607 asks for a new one), or the same. */
    update(principal: P, calendar: Calendar, objectName: string, managedId: string, input: AttachmentInput): Promise<string>;
    /** The attachment is no longer referenced by the object. */
    remove(principal: P, calendar: Calendar, objectName: string, managedId: string): Promise<void>;
    /** Download, for everybody who can see an object referencing it. Null answers 404. */
    get(principal: P, managedId: string): Promise<AttachmentInput | null>;
    /** Largest attachment in bytes (max-attachment-size). */
    maxSize?: number;
    /** Most attachments per object (max-attachments-per-resource). */
    maxPerObject?: number;
}

/** A WebDAV lock (RFC 4918 6). */
export interface Lock {
    /** `urn:uuid:…`, created by the server. */
    token: string;
    /** Path of the locked resource, e.g. `/dav/calendars/jane/work/`. */
    path: string;
    /** Id of the principal who holds the lock. */
    principal: string;
    scope: 'exclusive' | 'shared';
    depth: '0' | 'infinity';
    /** The client's DAV:owner element, serialized, if it sent one. */
    owner?: string;
    timeoutSeconds: number;
    expires: Date;
}

/**
 * Storage of locks. Locks must be visible to every server instance, so they live with the provider;
 * `MemoryLocks` is enough for a single instance.
 */
export interface LockProvider {
    /** Unexpired locks on any of these paths. */
    find(paths: string[]): Promise<Lock[]>;
    /** Unexpired locks on these paths or below them (for Depth: infinity locks and deletes). */
    findBelow(path: string): Promise<Lock[]>;
    save(lock: Lock): Promise<void>;
    remove(token: string): Promise<void>;
}

/** A principal whose calendars the user may use. */
export interface Delegation<P extends Principal = Principal> {
    principal: P;
    /** Write delegate: may change objects (still limited by `readOnly` of each calendar). */
    write: boolean;
}

/** A delegate of a principal. */
export interface Delegate extends PrincipalSearchResult {
    write: boolean;
}

/** All methods are async. Throw a `CalDavError` to answer with a specific status. */
export interface CalDavProvider<P extends Principal = Principal> {
    /** Check HTTP Basic credentials. Return null if they are wrong. */
    authenticate(username: string, password: string): Promise<P | null>;
    /** All calendars the principal can see, including shared ones. */
    listCalendars(principal: P): Promise<Calendar[]>;
    /**
     * Objects of a calendar. The query is a hint for pre-filtering in the
     * database; the server filters the result exactly afterwards, so it is
     * fine to ignore it or to return too much.
     */
    listObjects(principal: P, calendar: Calendar, query: ObjectQuery): Promise<CalendarObject[]>;
    getObject(principal: P, calendar: Calendar, name: string): Promise<CalendarObject | null>;
    /** Batch variant for calendar-multiget. Defaults to calling getObject per name. */
    getObjects?(principal: P, calendar: Calendar, names: string[]): Promise<CalendarObject[]>;
    /**
     * Changes since a sync token. Return null if the token is unknown or too
     * old; the client then does a full sync. Without this method every
     * sync-collection request with a token answers with a full sync.
     */
    changesSince?(principal: P, calendar: Calendar, syncToken: string): Promise<Changes | null>;
    /** Create or replace an object. Without it, every calendar is read-only. */
    putObject?(principal: P, calendar: Calendar, input: PutObjectInput): Promise<PutObjectResult>;
    deleteObject?(principal: P, calendar: Calendar, input: DeleteObjectInput): Promise<void>;
    /**
     * Move an object to another calendar of the principal (WebDAV MOVE, how Apple Calendar moves
     * an event). Keep it the same object: a delete plus create would cancel and re-invite its
     * attendees. Without it, MOVE answers 403 and clients fall back to PUT + DELETE.
     */
    moveObject?(principal: P, from: Calendar, to: Calendar, input: MoveObjectInput): Promise<void>;
    /**
     * Change name, color, order, description, timezone or transparency of a calendar (PROPPATCH). Called once per
     * request with all changes, which must be applied all or none. Not called for calendars
     * that are `readOnly`. Throw a `CalDavError` to reject; its status goes to every property.
     * Without it, PROPPATCH answers 403 for every property.
     */
    updateCalendar?(principal: P, calendar: Calendar, changes: CalendarChanges): Promise<void>;
    /**
     * Create a calendar (MKCALENDAR, or extended MKCOL as some clients send it). `id` is the
     * URL segment the client chose, often a UUID; afterwards `listCalendars` must return a
     * calendar with this id. Throw a `CalDavError` to reject. Without it, creating answers 403.
     */
    createCalendar?(principal: P, id: string, calendar: NewCalendar): Promise<void>;
    /**
     * Delete a calendar with all its objects (DELETE on the collection). Not called for
     * calendars that are `readOnly`. Without it, deleting answers 403.
     */
    deleteCalendar?(principal: P, calendar: Calendar): Promise<void>;
    /** Give a calendar a new id, i.e. a new URL (MOVE of the collection). Without it, 403. */
    moveCalendar?(principal: P, calendar: Calendar, newId: string): Promise<void>;
    /** Duplicate a calendar with all objects under a new id (COPY of the collection). Without it, 403. */
    copyCalendar?(principal: P, calendar: Calendar, newId: string): Promise<void>;
    /** Enables scheduling (RFC 6638). */
    scheduling?: SchedulingProvider<P>;
    /** Enables sharing calendars from the client (Apple Calendar). */
    sharing?: SharingProvider<P>;
    /**
     * Stores properties the server doesn't know (PROPPATCH on the calendar home, calendars,
     * objects and the principal). Without it, unknown properties answer 403.
     */
    properties?: PropertyStore<P>;
    /** The user renames themselves (PROPPATCH of displayname on their principal). Without it, 403. */
    updatePrincipal?(principal: P, changes: {displayName: string | null}): Promise<void>;
    /** Enables publishing calendars as public feeds (Apple's "Public Calendar"). */
    publishing?: PublishingProvider<P>;
    /** Enables managed attachments (RFC 8607). */
    attachments?: AttachmentProvider<P>;
    /** Enables LOCK/UNLOCK (WebDAV class 2). None of the common CalDAV clients needs it. */
    locks?: LockProvider;
    /**
     * Other calendar users the principal may find, e.g. to invite them
     * (principal-property-search, Apple's calendarserver-principal-search).
     * Match the terms against names and addresses as you see fit. Without it,
     * a search only finds the principal itself.
     */
    searchPrincipals?(principal: P, query: PrincipalSearchQuery): Promise<PrincipalSearchResult[]>;
    /**
     * Another user by id, for a PROPFIND on their principal URL (clients look up attendees and
     * organizers there). Return null if the principal may not see them (404). Without it,
     * other principals' URLs answer 403.
     */
    getPrincipal?(principal: P, id: string): Promise<PrincipalSearchResult | null>;
    /**
     * Whose calendars the user may use as a delegate ("on behalf of"). Requests below another
     * principal's URLs then run as that principal: every provider method gets the owner, and
     * read-only delegates can't write. Clients find these through calendar-proxy-read-for /
     * calendar-proxy-write-for on the user's principal. Without it, there is no delegation.
     */
    delegations?(user: P): Promise<Delegation<P>[]>;
    /**
     * Who may use the principal's calendars, for the proxy groups clients show in their
     * delegation settings (`/principals/<id>/calendar-proxy-read/` and `-write/`).
     */
    delegates?(principal: P): Promise<Delegate[]>;
    /**
     * Replace the read (`write: false`) or write delegates of the principal, when a client changes
     * them in its delegation settings (PROPPATCH of group-member-set). Without it, they are read-only.
     */
    setDelegates?(principal: P, write: boolean, ids: string[]): Promise<void>;
}
