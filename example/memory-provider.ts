import {
    CalDavError,
    type CalDavProvider,
    type Calendar,
    type CalendarChanges,
    type CalendarObject,
    type Changes,
    type MoveObjectInput,
    type NewCalendar,
    type Principal,
    type PrincipalSearchQuery,
    type PrincipalSearchResult,
    processSchedulingMessage,
    type PutObjectResult,
    type ScheduleStatus,
    type SchedulingProvider,
} from '../src/index.ts';

export interface User extends Principal {
    username: string;
    password: string;
}

interface StoredCalendar {
    meta: Omit<Calendar, 'syncToken' | 'readOnly'>;
    objects: Map<string, CalendarObject>;
    /** Change log: version of the change, object name, deleted? */
    log: {version: number; name: string; deleted: boolean}[];
    members: Map<string, {readOnly: boolean}>;
    /** Version of the last change of the calendar's properties. */
    touched: number;
}

/**
 * Keeps everything in memory. Calendars can be shared between users, read-only
 * or writable per user. Scheduling messages for local users are processed
 * into their calendars; other recipients are only logged.
 */
export class MemoryProvider implements CalDavProvider<User> {
    private readonly users = new Map<string, User>();
    private readonly calendars = new Map<string, StoredCalendar>();
    private version = 0;

    /** Every delivered iTIP message, for tests and for the console. */
    readonly outbox: {method: string; recipients: string[]; ics: string}[] = [];

    addUser(user: User): this {
        this.users.set(user.id, user);
        return this;
    }

    addCalendar(
        meta: Omit<Calendar, 'syncToken' | 'readOnly'>,
        members: Record<string, 'read' | 'write'>,
    ): this {
        this.calendars.set(meta.id, {
            meta,
            objects: new Map(),
            log: [],
            touched: 0,
            members: new Map(Object.entries(members).map(([id, access]) => [id, {readOnly: access === 'read'}])),
        });
        return this;
    }

    /** Stores an object directly, like a backend would when data changes in its own UI. */
    seed(calendarId: string, name: string, ics: string): CalendarObject {
        const cal = this.calendars.get(calendarId);
        if (!cal) throw new Error(`unknown calendar ${calendarId}`);
        return this.write(cal, name, ics);
    }

    private write(cal: StoredCalendar, name: string, ics: string): CalendarObject {
        const version = ++this.version;
        const object = {name, ics, etag: `v${version}`, lastModified: new Date()};
        cal.objects.set(name, object);
        cal.log.push({version, name, deleted: false});
        return object;
    }

    private stored(principal: User, calendar: Calendar): StoredCalendar {
        const cal = this.calendars.get(calendar.id);
        if (!cal || !cal.members.has(principal.id)) throw CalDavError.notFound();
        return cal;
    }

    /** Changes of objects and of properties both count, so other devices notice a rename. */
    private currentVersion(cal: StoredCalendar): number {
        return Math.max(cal.log.at(-1)?.version ?? 0, cal.touched);
    }

    private toCalendar(cal: StoredCalendar, userId: string): Calendar {
        return {...cal.meta, syncToken: String(this.currentVersion(cal)), readOnly: cal.members.get(userId)!.readOnly};
    }

    async authenticate(username: string, password: string): Promise<User | null> {
        const user = [...this.users.values()].find((u) => u.username === username);
        return user && user.password === password ? user : null;
    }

    async listCalendars(principal: User): Promise<Calendar[]> {
        return [...this.calendars.values()].filter((c) => c.members.has(principal.id)).map((c) => this.toCalendar(c, principal.id));
    }

    async listObjects(principal: User, calendar: Calendar): Promise<CalendarObject[]> {
        // The query hint is ignored; the server filters exactly anyway.
        return [...this.stored(principal, calendar).objects.values()];
    }

    async getObject(principal: User, calendar: Calendar, name: string): Promise<CalendarObject | null> {
        return this.stored(principal, calendar).objects.get(name) ?? null;
    }

    async changesSince(principal: User, calendar: Calendar, syncToken: string): Promise<Changes | null> {
        const cal = this.stored(principal, calendar);
        const since = Number(syncToken);
        const current = this.currentVersion(cal);
        if (!Number.isInteger(since) || since < 0 || since > current) return null;
        const touched = new Set(cal.log.filter((e) => e.version > since).map((e) => e.name));
        const changed: CalendarObject[] = [];
        const deleted: string[] = [];
        for (const name of touched) {
            const o = cal.objects.get(name);
            if (o) changed.push(o);
            else deleted.push(name);
        }
        return {syncToken: String(current), changed, deleted};
    }

    async putObject(principal: User, calendar: Calendar, input: {name: string; ics: string; ifMatch?: string}): Promise<PutObjectResult> {
        const cal = this.stored(principal, calendar);
        if (cal.members.get(principal.id)!.readOnly) throw CalDavError.forbidden();
        const current = cal.objects.get(input.name);
        if (input.ifMatch && current?.etag !== input.ifMatch) throw CalDavError.preconditionFailed();
        const object = this.write(cal, input.name, input.ics);
        return {etag: object.etag, storedAsIs: true};
    }

    async deleteObject(principal: User, calendar: Calendar, input: {name: string; ifMatch?: string}): Promise<void> {
        const cal = this.stored(principal, calendar);
        if (cal.members.get(principal.id)!.readOnly) throw CalDavError.forbidden();
        const current = cal.objects.get(input.name);
        if (!current) throw CalDavError.notFound();
        if (input.ifMatch && current.etag !== input.ifMatch) throw CalDavError.preconditionFailed();
        cal.objects.delete(input.name);
        cal.log.push({version: ++this.version, name: input.name, deleted: true});
    }

    async moveObject(principal: User, from: Calendar, to: Calendar, input: MoveObjectInput): Promise<void> {
        const source = this.stored(principal, from);
        const target = this.stored(principal, to);
        if (source.members.get(principal.id)!.readOnly || target.members.get(principal.id)!.readOnly) throw CalDavError.forbidden();
        const object = source.objects.get(input.name);
        if (!object) throw CalDavError.notFound();
        if (input.ifMatch && object.etag !== input.ifMatch) throw CalDavError.preconditionFailed();
        if (target.objects.has(input.destinationName) && !input.overwrite) throw CalDavError.preconditionFailed();
        source.objects.delete(input.name);
        source.log.push({version: ++this.version, name: input.name, deleted: true});
        this.write(target, input.destinationName, object.ics);
    }

    async updateCalendar(principal: User, calendar: Calendar, changes: CalendarChanges): Promise<void> {
        const cal = this.stored(principal, calendar);
        if (cal.members.get(principal.id)!.readOnly) throw CalDavError.forbidden();
        if (changes.displayName === null) throw new CalDavError(409, 'a calendar needs a name');
        const meta: Record<string, unknown> = cal.meta;
        for (const [key, value] of Object.entries(changes)) {
            if (value === null) delete meta[key];
            else meta[key] = value;
        }
        cal.touched = ++this.version;
    }

    /** New calendars belong to their creator alone. */
    async createCalendar(principal: User, id: string, input: NewCalendar): Promise<void> {
        if (this.calendars.has(id)) throw new CalDavError(409, 'calendar id is taken');
        this.addCalendar({id, ...input}, {[principal.id]: 'write'});
        this.calendars.get(id)!.touched = ++this.version;
    }

    async deleteCalendar(principal: User, calendar: Calendar): Promise<void> {
        const cal = this.stored(principal, calendar);
        if (cal.members.get(principal.id)!.readOnly) throw CalDavError.forbidden();
        this.calendars.delete(calendar.id);
    }

    /** Every other user whose name or address contains the terms (to invite them). */
    async searchPrincipals(principal: User, query: PrincipalSearchQuery): Promise<PrincipalSearchResult[]> {
        return [...this.users.values()]
            .filter((u) => u.id !== principal.id)
            .filter((u) => {
                const haystack = [u.displayName ?? '', ...(u.addresses ?? [])].join('\n').toLowerCase();
                const hit = (t: string) => haystack.includes(t);
                return query.test === 'allof' ? query.terms.every(hit) : query.terms.some(hit);
            })
            .map((u) => ({id: u.id, displayName: u.displayName, addresses: u.addresses ?? []}));
    }

    private userByAddress(address: string): User | undefined {
        const mail = address.replace(/^mailto:/i, '').toLowerCase();
        return [...this.users.values()].find((u) => u.addresses?.some((a) => a.replace(/^mailto:/i, '').toLowerCase() === mail));
    }

    /** Finds the object with the UID in the user's writable calendars. */
    private findByUid(user: User, uid: string): {cal: StoredCalendar; object: CalendarObject} | undefined {
        for (const cal of this.calendars.values()) {
            if (!cal.members.has(user.id)) continue;
            for (const object of cal.objects.values()) {
                if (object.ics.includes(`UID:${uid}`)) return {cal, object};
            }
        }
        return undefined;
    }

    readonly scheduling: SchedulingProvider<User> = {
        deliver: async (message) => {
            this.outbox.push({method: message.method, recipients: message.recipients, ics: message.ics});
            const result: Record<string, ScheduleStatus> = {};
            for (const recipient of message.recipients) {
                const user = this.userByAddress(recipient);
                if (!user) {
                    // A real backend would send an iMIP e-mail here.
                    result[recipient] = '3.7';
                    continue;
                }
                const found = this.findByUid(user, message.uid);
                const processed = processSchedulingMessage(message.ics, found?.object.ics ?? null, recipient);
                if (processed.ics) {
                    const target =
                        found?.cal ??
                        [...this.calendars.values()].find((c) => c.members.get(user.id)?.readOnly === false && c.meta.components.includes('VEVENT'));
                    if (!target) {
                        result[recipient] = '5.3';
                        continue;
                    }
                    this.write(target, found?.object.name ?? `${message.uid}.ics`, processed.ics);
                }
                result[recipient] = '1.2';
            }
            return result;
        },
        findPrincipal: async (address) => this.userByAddress(address) ?? null,
    };
}
