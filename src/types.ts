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
    /** Items of the scheduling inbox. Without it, the inbox is empty. */
    listInbox?(principal: P): Promise<CalendarObject[]>;
    deleteInboxItem?(principal: P, name: string): Promise<void>;
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
    /** Enables scheduling (RFC 6638). */
    scheduling?: SchedulingProvider<P>;
}
