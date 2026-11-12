import {applyCalendarData} from './calendardata.ts';
import {floatingZoneOf} from './freebusy.ts';
import {inviteProperty, notificationEtag, notificationsSyncToken} from './sharing.ts';
import {type Context, homeSyncToken, normalizeAddresses, quoteEtag, type Resource, syncTokenUri} from './context.ts';
import {parseIcs, peekObject} from './ical.ts';
import type {Calendar, PrincipalSearchResult} from './types.ts';
import {cal, d, el, type Kid, NS, type QName, qkey, type XNode} from './xml.ts';

export type PropResult = {status: 200; value: Kid[]} | {status: 403 | 404};

type Getter = (ctx: Context, r: Resource) => Kid[] | undefined | Promise<Kid[] | undefined>;

const ok = (...value: Kid[]): Kid[] => value;
const href = (h: string): XNode => d('href', h);

function privileges(...names: [string, string][]): XNode[] {
    return names.map(([ns, name]) => d('privilege', el(ns, name)));
}

function privilegeSet(ctx: Context, r: Resource): XNode[] {
    const read: [string, string][] = [
        [NS.DAV, 'read'],
        [NS.DAV, 'read-acl'],
        [NS.DAV, 'read-current-user-privilege-set'],
        [NS.CALDAV, 'read-free-busy'],
    ];
    const write: [string, string][] = [
        [NS.DAV, 'write-content'],
        [NS.DAV, 'bind'],
        [NS.DAV, 'unbind'],
    ];
    switch (r.kind) {
        case 'calendar':
        case 'object': {
            const canWrite = ctx.canWrite(r.calendar);
            const canDelete = ctx.canDelete(r.calendar);
            const set = [...read];
            if (canWrite) set.push(write[0]!, write[1]!);
            if (canDelete) set.push(write[2]!);
            // Some clients (Apple, Thunderbird) only look for the aggregate DAV:write.
            if (canWrite && canDelete) set.push([NS.DAV, 'write']);
            if (r.kind === 'calendar' && ctx.canEditCalendar(r.calendar)) set.push([NS.DAV, 'write-properties']);
            return privileges(...set);
        }
        case 'home': {
            const set = [...read];
            if (ctx.provider.createCalendar && ctx.writable) set.push(write[1]!);
            if (ctx.provider.deleteCalendar && ctx.writable) set.push(write[2]!);
            return privileges(...set);
        }
        case 'inbox':
        case 'inbox-item':
            return privileges(...read, ...(ctx.writable ? [[NS.DAV, 'unbind'] as [string, string]] : []), [NS.CALDAV, 'schedule-deliver']);
        case 'outbox':
            return privileges(...read, ...(ctx.writable ? [[NS.CALDAV, 'schedule-send'] as [string, string]] : []));
        case 'proxy-group':
            return privileges(...read, ...(ctx.provider.setDelegates && !ctx.delegated ? [[NS.DAV, 'write-properties'] as [string, string]] : []));
        default:
            return privileges(...read);
    }
}

function calendarOf(r: Resource): Calendar | undefined {
    return r.kind === 'calendar' ? r.calendar : undefined;
}

function contentType(ics: string): string {
    let type: string | undefined;
    try {
        type = peekObject(parseIcs(ics)).componentType;
    } catch {
        // stored data the provider produced; no component parameter then
    }
    return `text/calendar; charset=utf-8${type ? `; component=${type.toLowerCase()}` : ''}`;
}

async function defaultCalendar(ctx: Context): Promise<Calendar | undefined> {
    const all = await ctx.calendars();
    return all.find((c) => ctx.canWrite(c) && c.components.includes('VEVENT'));
}

const getters: Record<string, Getter> = {};
const allprop = new Set<string>();

function def(ns: string, name: string, getter: Getter, inAllprop = true) {
    const key = qkey({ns, name});
    getters[key] = getter;
    if (inAllprop) allprop.add(key);
}

// --- WebDAV (RFC 4918, RFC 5397, RFC 3744, RFC 6578) ---

def(NS.DAV, 'resourcetype', (_ctx, r) => {
    switch (r.kind) {
        case 'root':
        case 'principals':
        case 'home':
            return ok(d('collection'));
        case 'principal':
            return ok(d('collection'), d('principal'));
        case 'proxy-group':
            return ok(d('principal'), el(NS.CS, r.write ? 'calendar-proxy-write' : 'calendar-proxy-read'));
        case 'calendar':
            return ok(
                d('collection'),
                cal('calendar'),
                r.calendar.sharedBy ? el(NS.CS, 'shared') : r.calendar.shared ? el(NS.CS, 'shared-owner') : null,
            );
        case 'notifications':
            return ok(d('collection'), el(NS.CS, 'notification'));
        case 'inbox':
            return ok(d('collection'), cal('schedule-inbox'));
        case 'outbox':
            return ok(d('collection'), cal('schedule-outbox'));
        default:
            return ok();
    }
});

def(NS.DAV, 'displayname', (ctx, r) => {
    switch (r.kind) {
        case 'principal':
            return ok(ctx.principal.displayName ?? ctx.principal.id);
        case 'proxy-group':
            return ok(`${ctx.principal.displayName ?? ctx.principal.id} (${r.write ? 'write' : 'read'} delegates)`);
        case 'calendar':
            return ok(r.calendar.displayName);
        case 'inbox':
            return ok('Inbox');
        case 'outbox':
            return ok('Outbox');
        default:
            return undefined;
    }
});

def(NS.DAV, 'current-user-principal', (ctx) => ok(href(ctx.userHref())));
def(NS.DAV, 'principal-URL', (ctx, r) => {
    if (r.kind === 'principal') return ok(href(ctx.principalHref()));
    return r.kind === 'proxy-group' ? ok(href(ctx.href(r))) : undefined;
});

// --- Delegation (CalendarServer calendar-proxy, caldav-proxy.txt) ---

def(NS.DAV, 'group-member-set', async (ctx, r) => {
    if (r.kind !== 'proxy-group') return undefined;
    const delegates = await ctx.provider.delegates!(ctx.principal);
    return delegates.filter((dl) => dl.write === r.write).map((dl) => href(`${ctx.principalsHref()}${encodeURIComponent(dl.id)}/`));
});

def(NS.DAV, 'group-membership', async (ctx, r) => {
    if (r.kind !== 'principal' || ctx.delegated || !ctx.provider.delegations) return undefined;
    return (await ctx.delegations()).map((dl) => href(ctx.proxyGroupHref(dl.principal.id, dl.write)));
});

for (const write of [false, true]) {
    def(NS.CS, write ? 'calendar-proxy-write-for' : 'calendar-proxy-read-for', async (ctx, r) => {
        if (r.kind !== 'principal' || ctx.delegated || !ctx.provider.delegations) return undefined;
        const owners = (await ctx.delegations()).filter((dl) => dl.write === write);
        return owners.map((dl) => href(`${ctx.principalsHref()}${encodeURIComponent(dl.principal.id)}/`));
    });
}
def(NS.DAV, 'owner', (ctx, r) => {
    if (r.kind === 'root' || r.kind === 'principals') return undefined;
    // A calendar shared with the user belongs to whoever shared it.
    const by = r.kind === 'calendar' ? r.calendar.sharedBy : undefined;
    return ok(href(by ? `${ctx.principalsHref()}${encodeURIComponent(by.id)}/` : ctx.principalHref()));
});
def(NS.DAV, 'principal-collection-set', (ctx) => ok(href(ctx.principalsHref())));
def(NS.DAV, 'current-user-privilege-set', (ctx, r) => privilegeSet(ctx, r));

// --- Access control (RFC 3744), read-only: the provider decides who may do what ---

/** The ACL is the signed-in user's own privileges, as one protected ACE. */
def(
    NS.DAV,
    'acl',
    (ctx, r) => ok(d('ace', d('principal', href(ctx.principalHref())), d('grant', ...privilegeSet(ctx, r)), d('protected'))),
    false,
);

def(
    NS.DAV,
    'supported-privilege-set',
    (_ctx, r) => {
        const sp = (ns: string, name: string, ...kids: XNode[]) => d('supported-privilege', d('privilege', el(ns, name)), ...kids);
        const extra =
            r.kind === 'inbox' || r.kind === 'inbox-item'
                ? [sp(NS.CALDAV, 'schedule-deliver')]
                : r.kind === 'outbox'
                  ? [sp(NS.CALDAV, 'schedule-send')]
                  : [];
        return ok(
            d(
                'supported-privilege',
                d('privilege', d('all')),
                d('abstract'),
                sp(NS.DAV, 'read', sp(NS.DAV, 'read-acl'), sp(NS.DAV, 'read-current-user-privilege-set'), sp(NS.CALDAV, 'read-free-busy')),
                sp(NS.DAV, 'write', sp(NS.DAV, 'write-properties'), sp(NS.DAV, 'write-content'), sp(NS.DAV, 'bind'), sp(NS.DAV, 'unbind')),
                sp(NS.DAV, 'write-acl'),
                ...extra,
            ),
        );
    },
    false,
);

def(NS.DAV, 'acl-restrictions', () => ok(d('grant-only'), d('no-invert')), false);
def(NS.DAV, 'inherited-acl-set', () => ok(), false);

def(NS.DAV, 'supported-report-set', (ctx, r) => {
    const report = (ns: string, name: string) => d('supported-report', d('report', el(ns, name)));
    switch (r.kind) {
        case 'calendar':
            return ok(
                report(NS.CALDAV, 'calendar-query'),
                report(NS.CALDAV, 'calendar-multiget'),
                report(NS.CALDAV, 'free-busy-query'),
                report(NS.DAV, 'sync-collection'),
            );
        case 'inbox':
            return ok(report(NS.CALDAV, 'calendar-query'), report(NS.CALDAV, 'calendar-multiget'));
        case 'home':
        case 'notifications':
            return ok(report(NS.DAV, 'sync-collection'));
        case 'principal':
        case 'proxy-group':
            return ok(report(NS.DAV, 'expand-property'));
        case 'principals':
            return ok(
                report(NS.DAV, 'principal-property-search'),
                report(NS.DAV, 'principal-search-property-set'),
                ctx.provider.searchPrincipals ? report(NS.CS, 'calendarserver-principal-search') : null,
            );
        default:
            return ok();
    }
});

def(NS.DAV, 'sync-token', async (ctx, r) => {
    if (r.kind === 'home') return ok(syncTokenUri(homeSyncToken(await ctx.calendars())));
    if (r.kind === 'notifications') return ok(syncTokenUri(notificationsSyncToken(await ctx.invitations())));
    const c = calendarOf(r);
    return c ? ok(syncTokenUri(c.syncToken)) : undefined;
});

def(NS.DAV, 'getetag', (_ctx, r) => {
    if ((r.kind === 'object' || r.kind === 'inbox-item') && r.object) return ok(quoteEtag(r.object.etag));
    if (r.kind === 'notification' && r.invitation) return ok(quoteEtag(notificationEtag(r.invitation)));
    return undefined;
});

def(NS.DAV, 'getcontenttype', (_ctx, r) => {
    if (r.kind === 'notification' && r.invitation) return ok('application/xml; charset=utf-8');
    if ((r.kind === 'object' || r.kind === 'inbox-item') && r.object) return ok(contentType(r.object.ics));
    return undefined;
});

def(NS.DAV, 'getcontentlength', (_ctx, r) => {
    if ((r.kind === 'object' || r.kind === 'inbox-item') && r.object) {
        return ok(String(Buffer.byteLength(r.object.ics, 'utf8')));
    }
    return undefined;
});

def(NS.DAV, 'getlastmodified', (_ctx, r) => {
    if ((r.kind === 'object' || r.kind === 'inbox-item') && r.object?.lastModified) {
        return ok(r.object.lastModified.toUTCString());
    }
    return undefined;
});

// --- CalDAV (RFC 4791) ---

def(NS.CALDAV, 'calendar-home-set', (ctx, r) => (r.kind === 'principal' ? ok(href(ctx.homeHref())) : undefined));

def(NS.CALDAV, 'calendar-description', (_ctx, r) => {
    const c = calendarOf(r);
    return c?.description !== undefined ? ok(c.description) : undefined;
});

def(NS.CALDAV, 'calendar-timezone', (_ctx, r) => {
    const c = calendarOf(r);
    return c?.timezone ? ok(c.timezone) : undefined;
});

def(NS.CALDAV, 'supported-calendar-component-set', (_ctx, r) => {
    const c = calendarOf(r);
    if (c) return c.components.map((name) => ({ns: NS.CALDAV, name: 'comp', attrs: {name}, children: []}));
    if (r.kind === 'inbox') {
        return ['VEVENT', 'VTODO'].map((name) => ({ns: NS.CALDAV, name: 'comp', attrs: {name}, children: []}));
    }
    return undefined;
});

def(NS.CALDAV, 'supported-calendar-data', (_ctx, r) =>
    r.kind === 'calendar' || r.kind === 'inbox'
        ? ok({ns: NS.CALDAV, name: 'calendar-data', attrs: {'content-type': 'text/calendar', version: '2.0'}, children: []})
        : undefined,
);

// calendar-data is only returned when asked for explicitly (RFC 4791 9.6).
def(
    NS.CALDAV,
    'calendar-data',
    (ctx, r) => {
        if ((r.kind !== 'object' && r.kind !== 'inbox-item') || !r.object) return undefined;
        if (!ctx.calendarData) return ok(r.object.ics);
        const floating = floatingZoneOf(r.kind === 'object' ? r.calendar.timezone : undefined);
        return ok(applyCalendarData(r.object.ics, ctx.calendarData, floating));
    },
    false,
);

// --- Managed attachments (RFC 8607) ---

// Empty: attachments live on this server.
def(NS.CALDAV, 'managed-attachments-server-URL', (ctx, r) => (r.kind === 'home' && ctx.provider.attachments ? ok() : undefined));
def(NS.CALDAV, 'max-attachment-size', (ctx, r) => {
    const max = ctx.provider.attachments?.maxSize;
    return r.kind === 'home' && max !== undefined ? ok(String(max)) : undefined;
});
def(NS.CALDAV, 'max-attachments-per-resource', (ctx, r) => {
    const max = ctx.provider.attachments?.maxPerObject;
    return r.kind === 'home' && max !== undefined ? ok(String(max)) : undefined;
});

// --- Scheduling (RFC 6638) ---

def(NS.CALDAV, 'calendar-user-address-set', (ctx, r) => {
    if (r.kind !== 'principal') return undefined;
    return ok(...ctx.addresses().map(href), href(ctx.principalHref()));
});

def(NS.CALDAV, 'calendar-user-type', (_ctx, r) => (r.kind === 'principal' ? ok('INDIVIDUAL') : undefined));
def(NS.CALDAV, 'schedule-inbox-URL', (ctx, r) => (r.kind === 'principal' && ctx.scheduling ? ok(href(ctx.inboxHref())) : undefined));
def(NS.CALDAV, 'schedule-outbox-URL', (ctx, r) => (r.kind === 'principal' && ctx.scheduling ? ok(href(ctx.outboxHref())) : undefined));

def(NS.CALDAV, 'schedule-default-calendar-URL', async (ctx, r) => {
    if (r.kind !== 'inbox') return undefined;
    const c = await defaultCalendar(ctx);
    return c ? ok(href(ctx.calendarHref(c))) : undefined;
});

def(NS.CALDAV, 'schedule-calendar-transp', (_ctx, r) =>
    r.kind === 'calendar' ? ok(cal(r.calendar.transparent ? 'transparent' : 'opaque')) : undefined,
);

def(NS.CALDAV, 'schedule-tag', (ctx, r) => {
    if (!ctx.scheduling || r.kind !== 'object' || !r.object) return undefined;
    return ok(quoteEtag(r.object.scheduleTag ?? r.object.etag));
});

// --- CalendarServer / Apple extensions ---

def(NS.CS, 'getctag', async (ctx, r) => {
    if (r.kind === 'notifications') return ok(notificationsSyncToken(await ctx.invitations()));
    const c = calendarOf(r);
    return c ? ok(c.syncToken) : undefined;
});

// --- Sharing (CalendarServer caldav-sharing) ---

def(NS.CS, 'invite', (ctx, r) => inviteProperty(ctx, r));

def(NS.CS, 'allowed-sharing-modes', (ctx, r) => {
    if (r.kind !== 'calendar') return undefined;
    const canShare = !!ctx.provider.sharing && ctx.writable && !r.calendar.sharedBy;
    return ok(canShare ? el(NS.CS, 'can-be-shared') : null);
});

def(NS.CS, 'notification-URL', (ctx, r) =>
    r.kind === 'principal' && ctx.provider.sharing?.invitations ? ok(href(ctx.notificationsHref())) : undefined,
);

def(NS.CS, 'notificationtype', (_ctx, r) =>
    r.kind === 'notification' && r.invitation ? ok({ns: NS.CS, name: 'invite-notification', attrs: {'shared-type': 'calendar'}, children: []}) : undefined,
);

def(NS.CS, 'email-address-set', (ctx, r) => {
    if (r.kind !== 'principal') return undefined;
    const mails = ctx.addresses().filter((a) => a.startsWith('mailto:'));
    return ok(...mails.map((m) => el(NS.CS, 'email-address', m.slice(7))));
});

def(NS.APPLE, 'calendar-color', (_ctx, r) => {
    const c = calendarOf(r);
    return c?.color ? ok(c.color) : undefined;
});

def(NS.APPLE, 'calendar-order', (_ctx, r) => {
    const c = calendarOf(r);
    return c?.order !== undefined ? ok(String(c.order)) : undefined;
});

export function allPropNames(): QName[] {
    return [...allprop].map((k) => {
        const m = /^\{(.*)\}(.*)$/.exec(k)!;
        return {ns: m[1]!, name: m[2]!};
    });
}

/** Properties of another user's principal (search results and `getPrincipal`). */
function otherPrincipalProp(ctx: Context, found: PrincipalSearchResult, q: QName): Kid[] | undefined {
    const self = `${ctx.principalsHref()}${encodeURIComponent(found.id)}/`;
    const addresses = normalizeAddresses(found.addresses);
    switch (qkey(q)) {
        case qkey({ns: NS.DAV, name: 'displayname'}):
            return [found.displayName ?? found.id];
        case qkey({ns: NS.DAV, name: 'resourcetype'}):
            return [d('collection'), d('principal')];
        case qkey({ns: NS.DAV, name: 'principal-URL'}):
            return [href(self)];
        case qkey({ns: NS.DAV, name: 'current-user-principal'}):
            return [href(ctx.principalHref())];
        case qkey({ns: NS.DAV, name: 'current-user-privilege-set'}):
            return privileges([NS.DAV, 'read']);
        case qkey({ns: NS.CALDAV, name: 'calendar-user-address-set'}):
            return [...addresses.map(href), href(self)];
        case qkey({ns: NS.CALDAV, name: 'calendar-user-type'}):
            return ['INDIVIDUAL'];
        case qkey({ns: NS.CS, name: 'email-address-set'}):
            return addresses.filter((a) => a.startsWith('mailto:')).map((a) => el(NS.CS, 'email-address', a.slice(7)));
        case qkey({ns: NS.CS, name: 'record-type'}):
            return ['users'];
        default:
            return undefined;
    }
}

export async function getProp(ctx: Context, r: Resource, q: QName): Promise<PropResult> {
    if (r.kind === 'other-principal') {
        const value = otherPrincipalProp(ctx, r.found, q);
        return value === undefined ? {status: 404} : {status: 200, value};
    }
    const getter = getters[qkey(q)];
    if (!getter) return {status: 404};
    const value = await getter(ctx, r);
    return value === undefined ? {status: 404} : {status: 200, value};
}

/** Builds a DAV:response with one propstat per status. */
export async function propResponse(
    ctx: Context,
    r: Resource,
    props: QName[],
    mode: 'prop' | 'allprop' | 'propname' = 'prop',
): Promise<XNode> {
    const found: XNode[] = [];
    const missing: XNode[] = [];
    for (const q of props) {
        const result = await getProp(ctx, r, q);
        if (result.status === 200) found.push(el(q.ns, q.name, ...(mode === 'propname' ? [] : result.value)));
        else if (mode === 'prop') missing.push(el(q.ns, q.name));
    }
    const propstat = (list: XNode[], status: string) => d('propstat', d('prop', ...list), d('status', status));
    return d(
        'response',
        href(ctx.href(r)),
        found.length || !missing.length ? propstat(found, 'HTTP/1.1 200 OK') : null,
        missing.length ? propstat(missing, 'HTTP/1.1 404 Not Found') : null,
    );
}

export function statusResponse(hrefValue: string, status: string): XNode {
    return d('response', href(hrefValue), d('status', status));
}
