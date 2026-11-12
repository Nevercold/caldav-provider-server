import {CalDavError} from './errors.ts';
import type {Calendar, CalDavProvider, CalendarObject, Principal} from './types.ts';

export type Resource =
    | {kind: 'root'}
    | {kind: 'principals'}
    | {kind: 'principal'}
    | {kind: 'home'}
    | {kind: 'calendar'; calendar: Calendar}
    | {kind: 'object'; calendar: Calendar; name: string; object: CalendarObject | null}
    | {kind: 'inbox'}
    | {kind: 'inbox-item'; name: string; object: CalendarObject | null}
    | {kind: 'outbox'};

const SYNC_PREFIX = 'http://caldav-provider-server/ns/sync/';

export const syncTokenUri = (token: string): string => SYNC_PREFIX + encodeURIComponent(token);

/** Returns the provider token of a sync-token URI, or null if it is not one of ours. */
export function parseSyncTokenUri(uri: string): string | null {
    if (!uri.startsWith(SYNC_PREFIX)) return null;
    try {
        return decodeURIComponent(uri.slice(SYNC_PREFIX.length));
    } catch {
        return null;
    }
}

/**
 * Sync token of the calendar home: the ids and tokens of all calendars, so a
 * later sync-collection can tell which calendars changed or disappeared
 * without any state on the server.
 */
export function homeSyncToken(calendars: Calendar[]): string {
    const map = Object.fromEntries(calendars.map((c) => [c.id, c.syncToken]));
    return `home:${Buffer.from(JSON.stringify(map)).toString('base64url')}`;
}

export function parseHomeSyncToken(token: string): Record<string, string> | null {
    if (!token.startsWith('home:')) return null;
    try {
        const map = JSON.parse(Buffer.from(token.slice(5), 'base64url').toString('utf8'));
        return map && typeof map === 'object' && !Array.isArray(map) ? (map as Record<string, string>) : null;
    } catch {
        return null;
    }
}

export const quoteEtag = (etag: string): string => (/^(W\/)?".*"$/.test(etag) ? etag : `"${etag}"`);
export const unquoteEtag = (etag: string): string => etag.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');

/** Per-request state. */
export class Context<P extends Principal = Principal> {
    private calendarsPromise?: Promise<Calendar[]>;

    readonly provider: CalDavProvider<P>;
    readonly base: string;
    readonly principal: P;

    constructor(provider: CalDavProvider<P>, base: string, principal: P) {
        this.provider = provider;
        this.base = base;
        this.principal = principal;
    }

    get scheduling(): boolean {
        return !!this.provider.scheduling;
    }

    calendars(): Promise<Calendar[]> {
        this.calendarsPromise ??= this.provider.listCalendars(this.principal);
        return this.calendarsPromise;
    }

    async calendar(id: string): Promise<Calendar | undefined> {
        return (await this.calendars()).find((c) => c.id === id);
    }

    canWrite(calendar: Calendar): boolean {
        return !!this.provider.putObject && !calendar.readOnly;
    }

    canDelete(calendar: Calendar): boolean {
        return !!this.provider.deleteObject && !calendar.readOnly;
    }

    /** Name, color, order and description can be changed (PROPPATCH). */
    canEditCalendar(calendar: Calendar): boolean {
        return !!this.provider.updateCalendar && !calendar.readOnly;
    }

    /** Lowercased `mailto:` addresses of the current principal. */
    addresses(): string[] {
        return normalizeAddresses(this.principal.addresses ?? []);
    }

    private seg(s: string): string {
        return encodeURIComponent(s);
    }

    rootHref(): string {
        return `${this.base}/`;
    }

    principalsHref(): string {
        return `${this.base}/principals/`;
    }

    principalHref(): string {
        return `${this.base}/principals/${this.seg(this.principal.id)}/`;
    }

    homeHref(): string {
        return `${this.base}/calendars/${this.seg(this.principal.id)}/`;
    }

    calendarHref(c: Pick<Calendar, 'id'>): string {
        return `${this.homeHref()}${this.seg(c.id)}/`;
    }

    objectHref(c: Calendar, name: string): string {
        return `${this.calendarHref(c)}${this.seg(name)}`;
    }

    inboxHref(): string {
        return `${this.base}/inbox/${this.seg(this.principal.id)}/`;
    }

    outboxHref(): string {
        return `${this.base}/outbox/${this.seg(this.principal.id)}/`;
    }

    href(r: Resource): string {
        switch (r.kind) {
            case 'root':
                return this.rootHref();
            case 'principals':
                return this.principalsHref();
            case 'principal':
                return this.principalHref();
            case 'home':
                return this.homeHref();
            case 'calendar':
                return this.calendarHref(r.calendar);
            case 'object':
                return this.objectHref(r.calendar, r.name);
            case 'inbox':
                return this.inboxHref();
            case 'inbox-item':
                return `${this.inboxHref()}${this.seg(r.name)}`;
            case 'outbox':
                return this.outboxHref();
        }
    }

    /**
     * Splits a request path below the base path into decoded segments.
     * Returns null if the path is outside the base path.
     */
    segments(path: string): string[] | null {
        if (path !== this.base && !path.startsWith(`${this.base}/`)) return null;
        const rest = path.slice(this.base.length).split('/').filter(Boolean);
        try {
            return rest.map((s) => decodeURIComponent(s));
        } catch {
            throw new CalDavError(400, 'invalid path encoding');
        }
    }

    /**
     * Resolves a path to a resource. Object resources are returned with
     * `object: null` if they do not exist (PUT creates them).
     * Throws 404 for unknown collections and 403 for other users' resources.
     */
    async resolve(path: string, loadObject = true): Promise<Resource> {
        const segs = this.segments(path);
        if (!segs) throw CalDavError.notFound();
        const [area, owner, ...rest] = segs;
        if (!area) return {kind: 'root'};
        if (!['principals', 'calendars', 'inbox', 'outbox'].includes(area)) throw CalDavError.notFound();
        if (owner === undefined) {
            if (area === 'principals') return {kind: 'principals'};
            throw CalDavError.notFound();
        }
        if (owner !== this.principal.id) throw CalDavError.forbidden('resource of another principal');

        if (area === 'principals') {
            if (rest.length) throw CalDavError.notFound();
            return {kind: 'principal'};
        }
        if (area === 'outbox') {
            if (rest.length || !this.scheduling) throw CalDavError.notFound();
            return {kind: 'outbox'};
        }
        if (area === 'inbox') {
            if (!this.scheduling || rest.length > 1) throw CalDavError.notFound();
            if (!rest.length) return {kind: 'inbox'};
            const name = rest[0]!;
            const items = loadObject ? await this.inboxItems() : [];
            return {kind: 'inbox-item', name, object: items.find((i) => i.name === name) ?? null};
        }

        const [calendarId, name, ...tail] = rest;
        if (calendarId === undefined) return {kind: 'home'};
        if (tail.length) throw CalDavError.notFound();
        const calendar = await this.calendar(calendarId);
        if (!calendar) throw CalDavError.notFound();
        if (name === undefined) return {kind: 'calendar', calendar};
        const object = loadObject ? await this.provider.getObject(this.principal, calendar, name) : null;
        return {kind: 'object', calendar, name, object};
    }

    inboxItems(): Promise<CalendarObject[]> {
        const s = this.provider.scheduling;
        return s?.listInbox ? s.listInbox(this.principal) : Promise.resolve([]);
    }

    /** Maps an href from a request body to a resource path. */
    pathOfHref(href: string): string {
        try {
            const url = new URL(href, 'http://x');
            return url.pathname;
        } catch {
            return href;
        }
    }
}

export function normalizeAddress(a: string): string {
    const t = a.trim();
    return (/^mailto:/i.test(t) ? `mailto:${t.slice(7)}` : t.includes('@') && !t.includes(':') ? `mailto:${t}` : t).toLowerCase();
}

export function normalizeAddresses(list: string[]): string[] {
    return list.map(normalizeAddress);
}
