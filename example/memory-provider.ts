import {
    type AttachmentInput,
    type AttachmentProvider,
    CalDavError,
    type CalDavProvider,
    type Calendar,
    type CalendarChanges,
    type CalendarObject,
    type Changes,
    type Delegate,
    type Delegation,
    type Invitation,
    type MoveObjectInput,
    type NewCalendar,
    type Principal,
    type PrincipalSearchQuery,
    type PrincipalSearchResult,
    processSchedulingMessage,
    type PutObjectResult,
    type ScheduleStatus,
    type SchedulingProvider,
    type ShareAccess,
    type ShareStatus,
    type SharingProvider,
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
    /** The first user with write access; only they can share it from a client. */
    owner?: string;
    /** Shares made from a client, by address. */
    shares: Map<string, ShareEntry>;
}

interface ShareEntry {
    id: string;
    displayName?: string;
    summary?: string;
    access: ShareAccess;
    status: ShareStatus;
    dismissed: boolean;
    created: Date;
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
            owner: Object.entries(members).find(([, access]) => access === 'write')?.[0],
            shares: new Map(),
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
        const calendar: Calendar = {...cal.meta, syncToken: String(this.currentVersion(cal)), readOnly: cal.members.get(userId)!.readOnly};
        const user = this.users.get(userId);
        const owner = cal.owner ? this.users.get(cal.owner) : undefined;
        if (cal.owner === userId && cal.shares.size) calendar.shared = true;
        // Joined through a share from a client.
        if (owner && owner.id !== userId && user && this.shareOf(cal, user)?.status === 'accepted') {
            calendar.sharedBy = this.summary(owner);
        }
        return calendar;
    }

    private summary(u: User): PrincipalSearchResult {
        return {id: u.id, displayName: u.displayName, addresses: u.addresses ?? []};
    }

    private shareOf(cal: StoredCalendar, user: User): ShareEntry | undefined {
        const mine = new Set((user.addresses ?? []).map((a) => `mailto:${a.replace(/^mailto:/i, '').toLowerCase()}`));
        for (const [address, entry] of cal.shares) if (mine.has(address)) return entry;
        return undefined;
    }

    /** Attachment files by managed id. */
    readonly files: Map<string, {calendarId: string; input: AttachmentInput}> = new Map();

    readonly attachments: AttachmentProvider<User> = {
        add: async (principal, calendar, _name, input) => {
            this.stored(principal, calendar);
            const id = crypto.randomUUID();
            this.files.set(id, {calendarId: calendar.id, input});
            return id;
        },
        update: async (principal, calendar, _name, managedId, input) => {
            this.stored(principal, calendar);
            this.files.delete(managedId);
            const id = crypto.randomUUID();
            this.files.set(id, {calendarId: calendar.id, input});
            return id;
        },
        remove: async (_principal, _calendar, _name, managedId) => {
            this.files.delete(managedId);
        },
        // Readable for every member of the calendar the attachment belongs to.
        get: async (principal, managedId) => {
            const file = this.files.get(managedId);
            const cal = file && this.calendars.get(file.calendarId);
            return file && cal?.members.has(principal.id) ? file.input : null;
        },
        maxSize: 10 * 1024 * 1024,
    };

    readonly sharing: SharingProvider<User> = {
        sharees: async (principal, calendar) => {
            const cal = this.stored(principal, calendar);
            return [...cal.shares].map(([address, e]) => ({address, displayName: e.displayName, access: e.access, status: e.status}));
        },
        share: async (principal, calendar, changes) => {
            const cal = this.stored(principal, calendar);
            if (cal.owner !== principal.id) throw CalDavError.forbidden('only the owner can share');
            for (const s of changes.set) {
                const user = this.userByAddress(s.address);
                if (!user) throw new CalDavError(409, `unknown user ${s.address}`);
                if (user.id === principal.id) continue;
                const entry = cal.shares.get(s.address);
                if (entry) {
                    entry.access = s.access;
                    if (entry.status === 'accepted') cal.members.set(user.id, {readOnly: s.access === 'read'});
                } else {
                    cal.shares.set(s.address, {
                        id: crypto.randomUUID(),
                        displayName: s.displayName,
                        summary: s.summary,
                        access: s.access,
                        status: 'pending',
                        dismissed: false,
                        created: new Date(),
                    });
                }
            }
            for (const address of changes.remove) {
                const user = this.userByAddress(address);
                if (cal.shares.delete(address) && user) cal.members.delete(user.id);
            }
            cal.touched = ++this.version;
        },
        invitations: async (principal) => {
            const out: Invitation[] = [];
            for (const cal of this.calendars.values()) {
                const entry = this.shareOf(cal, principal);
                const owner = cal.owner ? this.users.get(cal.owner) : undefined;
                if (!entry || entry.dismissed || !owner) continue;
                const address = [...cal.shares].find(([, e]) => e === entry)![0];
                out.push({
                    id: entry.id,
                    owner: this.summary(owner),
                    calendarId: cal.meta.id,
                    address,
                    access: entry.access,
                    status: entry.status,
                    summary: entry.summary,
                    components: cal.meta.components,
                    created: entry.created,
                });
            }
            return out;
        },
        replyToInvitation: async (principal, id, accept) => {
            for (const cal of this.calendars.values()) {
                const entry = this.shareOf(cal, principal);
                if (entry?.id !== id) continue;
                entry.status = accept ? 'accepted' : 'declined';
                if (accept) cal.members.set(principal.id, {readOnly: entry.access === 'read'});
                else cal.members.delete(principal.id);
                cal.touched = ++this.version;
                return accept ? cal.meta.id : null;
            }
            throw CalDavError.notFound();
        },
        dismissInvitation: async (principal, id) => {
            for (const cal of this.calendars.values()) {
                const entry = this.shareOf(cal, principal);
                if (entry?.id === id) entry.dismissed = true;
            }
        },
    };

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

    /** owner id → delegate id → write access */
    private readonly proxies = new Map<string, Map<string, boolean>>();

    /** Lets `delegate` use the calendars of `owner`. */
    addDelegate(owner: string, delegate: string, write: boolean): this {
        if (!this.proxies.has(owner)) this.proxies.set(owner, new Map());
        this.proxies.get(owner)!.set(delegate, write);
        return this;
    }

    async delegations(user: User): Promise<Delegation<User>[]> {
        const out: Delegation<User>[] = [];
        for (const [owner, delegates] of this.proxies) {
            const write = delegates.get(user.id);
            const principal = this.users.get(owner);
            if (write !== undefined && principal) out.push({principal, write});
        }
        return out;
    }

    async delegates(principal: User): Promise<Delegate[]> {
        return [...(this.proxies.get(principal.id) ?? new Map<string, boolean>())]
            .map(([id, write]) => ({u: this.users.get(id), write}))
            .filter((e): e is {u: User; write: boolean} => !!e.u)
            .map(({u, write}) => ({id: u.id, displayName: u.displayName, addresses: u.addresses ?? [], write}));
    }

    async setDelegates(principal: User, write: boolean, ids: string[]): Promise<void> {
        if (ids.some((id) => !this.users.has(id))) throw new CalDavError(409, 'unknown user');
        const current = this.proxies.get(principal.id) ?? new Map<string, boolean>();
        for (const [id, w] of [...current]) if (w === write) current.delete(id);
        for (const id of ids) current.set(id, write);
        this.proxies.set(principal.id, current);
    }

    async getPrincipal(_principal: User, id: string): Promise<PrincipalSearchResult | null> {
        const u = this.users.get(id);
        return u ? {id: u.id, displayName: u.displayName, addresses: u.addresses ?? []} : null;
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
