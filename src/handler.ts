import {getAttachment, handleAttachmentPost, managedIdsOf} from './attachments.ts';
import {deleteCalendar, mkcalendar, proppatchCollection, transferCalendar} from './collections.ts';
import {canonicalPath, checkLocks, handleLock, handleUnlock} from './locks.ts';
import {PUSH_NS, type WebDavPush} from './push.ts';
import {handlePushRegister, handlePushUnregister, notifyAfterChange} from './pushhandler.ts';
import {Context, notificationName, quoteEtag, type Resource, unquoteEtag} from './context.ts';
import {
    handleInviteReply,
    handlePublish,
    handleShare,
    handleShareResource,
    notificationBody,
    notificationEtag,
    publicFeed,
} from './sharing.ts';
import {CalDavError} from './errors.ts';
import {type Component, IcsError, inspectObject, parseIcs} from './ical.ts';
import {allPropNames, propResponse} from './props.ts';
import {handleReport} from './report.ts';
import {handleOutboxPost, scheduleDelete, schedulePut} from './scheduling.ts';
import type {CalDavProvider, CalendarObject, Principal} from './types.ts';
import {type CalDavRequest, type CalDavResponse, errorResponse, header, multistatus, normalizeRequest, parseBody, type ParsedRequest} from './http.ts';
import {children, is, NS, type QName, qnameOf, type XNode} from './xml.ts';

export type {CalDavRequest, CalDavResponse};

export interface CalDavOptions<P extends Principal = Principal> {
    provider: CalDavProvider<P>;
    /** URL path the server lives under. Default `/dav`. */
    basePath?: string;
    /** Realm of the Basic auth challenge. */
    realm?: string;
    /**
     * Scheme and host the server is reachable at, e.g. `https://cal.example.com`, for absolute
     * URLs (attachments). Default: `X-Forwarded-Proto` (or `http`) and the `Host` header.
     */
    origin?: string;
    /**
     * Largest calendar object in bytes a client may store (PUT), reported as max-resource-size.
     * `Calendar.maxResourceSize` overrides it per calendar. Default: no limit.
     */
    maxObjectSize?: number;
    /** WebDAV-Push (DAVx⁵): a `WebDavPush` with VAPID keys and a registration store. */
    push?: WebDavPush;
    /** Called for unexpected errors (answered with 500). */
    onError?: (error: unknown, request: CalDavRequest) => void;
}

export type CalDavHandler = (request: CalDavRequest) => Promise<CalDavResponse>;

const METHODS = [
    'OPTIONS',
    'GET',
    'HEAD',
    'PUT',
    'DELETE',
    'PROPFIND',
    'PROPPATCH',
    'REPORT',
    'POST',
    'MKCOL',
    'MKCALENDAR',
    'MOVE',
    'COPY',
    'ACL',
    'LOCK',
    'UNLOCK',
];

/** HTTP methods the server answers; frameworks need to route these. */
export const CALDAV_METHODS: readonly string[] = METHODS;

function parseBasicAuth(value: string | undefined): {username: string; password: string} | null {
    const m = /^Basic\s+(\S+)$/i.exec(value ?? '');
    if (!m) return null;
    const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    return {username: decoded.slice(0, i), password: decoded.slice(i + 1)};
}

/** Depth header; a missing header counts as the given default. */
function depth(req: ParsedRequest, fallback: '0' | '1'): '0' | '1' {
    const v = header(req, 'depth')?.trim().toLowerCase();
    if (v === undefined || v === '') return fallback;
    if (v === '0' || v === '1') return v;
    if (v === 'infinity') throw CalDavError.dav(403, 'propfind-finite-depth', 'Depth: infinity is not supported');
    throw new CalDavError(400, `invalid Depth ${v}`);
}

/** Child resources for Depth: 1. */
export async function childResources(ctx: Context, r: Resource): Promise<Resource[]> {
    switch (r.kind) {
        case 'home':
            return (await ctx.calendars()).map((calendar) => ({kind: 'calendar', calendar}));
        case 'calendar': {
            const objects = await ctx.provider.listObjects(ctx.principal, r.calendar, {});
            return objects.map((object) => ({kind: 'object', calendar: r.calendar, name: object.name, object}));
        }
        case 'inbox':
            return (await ctx.inboxItems()).map((object) => ({kind: 'inbox-item', name: object.name, object}));
        case 'principal':
            return ctx.provider.delegates ? [{kind: 'proxy-group', write: false}, {kind: 'proxy-group', write: true}] : [];
        case 'notifications':
            return (await ctx.invitations()).map((invitation) => ({kind: 'notification', name: notificationName(invitation), invitation}));
        default:
            return [];
    }
}

function exists(r: Resource): boolean {
    if (r.kind === 'notification') return !!r.invitation;
    return !((r.kind === 'object' || r.kind === 'inbox-item') && !r.object);
}

/** POST: sharing on calendars and the calendar home, scheduling on the outbox. */
async function post(ctx: Context, req: ParsedRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    const query = new URL(req.url, 'http://x').searchParams;
    if (query.get('action')?.startsWith('attachment-')) return handleAttachmentPost(ctx, req, r, query);
    if (/<([\w-]+:)?push-register\b/.test(req.body ?? '')) {
        const root = parseBody(req);
        if (is(root, PUSH_NS, 'push-register')) return handlePushRegister(ctx, r, root!);
    }
    if (r.kind === 'calendar' || r.kind === 'home') {
        const root = parseBody(req);
        if (r.kind === 'calendar' && is(root, NS.CS, 'share')) return handleShare(ctx, r, root!);
        if (r.kind === 'calendar' && is(root, NS.DAV, 'share-resource')) return handleShareResource(ctx, r, root!);
        if (r.kind === 'calendar' && (is(root, NS.CS, 'publish-calendar') || is(root, NS.CS, 'unpublish-calendar'))) {
            return handlePublish(ctx, r, is(root, NS.CS, 'publish-calendar'));
        }
        if (r.kind === 'home' && is(root, NS.CS, 'invite-reply')) return handleInviteReply(ctx, root!);
        throw new CalDavError(400, 'unsupported POST body');
    }
    return handleOutboxPost(ctx, req, path);
}

async function propfind(ctx: Context, req: ParsedRequest, path: string): Promise<CalDavResponse> {
    const dep = depth(req, '1');
    const root = parseBody(req);
    let mode: 'prop' | 'allprop' | 'propname' = 'allprop';
    let props: QName[] = allPropNames();
    if (root) {
        if (!is(root, NS.DAV, 'propfind')) throw new CalDavError(400, 'expected DAV:propfind');
        const kids = children(root);
        const prop = kids.find((k) => is(k, NS.DAV, 'prop'));
        if (prop) {
            mode = 'prop';
            props = children(prop).map(qnameOf);
        } else if (kids.some((k) => is(k, NS.DAV, 'propname'))) {
            mode = 'propname';
        } else {
            const include = kids.find((k) => is(k, NS.DAV, 'include'));
            if (include) props = [...props, ...children(include).map(qnameOf)];
        }
    }

    const target = await ctx.resolve(path);
    if (!exists(target)) throw CalDavError.notFound();
    const resources = [target, ...(dep === '1' ? await childResources(ctx, target) : [])];
    const responses: XNode[] = [];
    for (const r of resources) responses.push(await propResponse(ctx, r, props, mode));
    return multistatus(responses);
}

async function proppatch(ctx: Context, req: ParsedRequest, path: string): Promise<CalDavResponse> {
    const target = await ctx.resolve(path);
    if (!exists(target)) throw CalDavError.notFound();
    return proppatchCollection(ctx, req, target);
}

function objectHeaders(ctx: Context, object: CalendarObject): Record<string, string> {
    const h: Record<string, string> = {
        'Content-Type': 'text/calendar; charset=utf-8',
        ETag: quoteEtag(object.etag),
    };
    if (object.lastModified) h['Last-Modified'] = object.lastModified.toUTCString();
    if (ctx.scheduling) h['Schedule-Tag'] = quoteEtag(object.scheduleTag ?? object.etag);
    return h;
}

async function get(ctx: Context, path: string, head: boolean): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind === 'attachment') return getAttachment(ctx, r.managedId, head);
    if (r.kind === 'notification') {
        if (!r.invitation) throw CalDavError.notFound();
        const body = notificationBody(ctx, r.invitation);
        return {
            status: 200,
            headers: {'Content-Type': 'application/xml; charset=utf-8', ETag: quoteEtag(notificationEtag(r.invitation))},
            body: head ? undefined : body,
        };
    }
    if (r.kind !== 'object' && r.kind !== 'inbox-item') {
        throw new CalDavError(405, 'GET is only supported on calendar objects');
    }
    if (!r.object) throw CalDavError.notFound();
    return {status: 200, headers: objectHeaders(ctx, r.object), body: head ? undefined : r.object.ics};
}

/** If-Match / If-None-Match (RFC 7232) and If-Schedule-Tag-Match (RFC 6638 8.3). */
function checkPreconditions(ctx: Context, req: ParsedRequest, current: CalendarObject | null): string | undefined {
    const tags = (v: string) => v.split(',').map((t) => t.trim()).filter(Boolean);
    const ifMatch = header(req, 'if-match');
    if (ifMatch !== undefined) {
        if (!current) throw CalDavError.preconditionFailed('object does not exist');
        const list = tags(ifMatch);
        if (!list.includes('*') && !list.map(unquoteEtag).includes(unquoteEtag(current.etag))) {
            throw CalDavError.preconditionFailed('ETag does not match');
        }
    }
    const ifNoneMatch = header(req, 'if-none-match');
    if (ifNoneMatch !== undefined && current) {
        const list = tags(ifNoneMatch);
        if (list.includes('*') || list.map(unquoteEtag).includes(unquoteEtag(current.etag))) {
            throw CalDavError.preconditionFailed('object exists');
        }
    }
    const ifScheduleTag = header(req, 'if-schedule-tag-match');
    if (ifScheduleTag !== undefined && ctx.scheduling) {
        if (!current) throw CalDavError.preconditionFailed('object does not exist');
        if (unquoteEtag(ifScheduleTag.trim()) !== unquoteEtag(current.scheduleTag ?? current.etag)) {
            throw CalDavError.preconditionFailed('Schedule-Tag does not match');
        }
    }
    return ifMatch !== undefined && !tags(ifMatch).includes('*') && current ? unquoteEtag(current.etag) : undefined;
}

async function put(ctx: Context, req: ParsedRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind !== 'object') throw new CalDavError(405, 'PUT is only supported on calendar objects');
    if (!ctx.canWrite(r.calendar)) throw CalDavError.forbidden('calendar is read-only');

    const type = header(req, 'content-type');
    if (type && !/^text\/calendar\b/i.test(type)) throw CalDavError.caldav(415, 'supported-calendar-data');
    const max = ctx.maxSizeOf(r.calendar);
    if (max !== undefined && (req.bytes?.byteLength ?? 0) > max) {
        throw CalDavError.caldav(403, 'max-resource-size', `objects are limited to ${max} bytes`);
    }

    let vcal: Component;
    let info;
    try {
        vcal = parseIcs(req.body ?? '');
    } catch (e) {
        if (e instanceof IcsError) throw CalDavError.caldav(400, 'valid-calendar-data', e.message);
        throw e;
    }
    try {
        info = inspectObject(vcal);
    } catch (e) {
        if (e instanceof IcsError) throw CalDavError.caldav(400, 'valid-calendar-object-resource', e.message);
        throw e;
    }
    if (!r.calendar.components.includes(info.componentType)) {
        throw CalDavError.caldav(403, 'supported-calendar-component', `calendar does not accept ${info.componentType}`);
    }
    const ifMatch = checkPreconditions(ctx, req, r.object);

    let ics = req.body!;
    if (ctx.scheduling) {
        const previous = r.object ? safeParse(r.object.ics) : null;
        ics = (await schedulePut(ctx, vcal, previous)) ?? ics;
    }

    const result = await ctx.provider.putObject!(ctx.principal, r.calendar, {
        name: r.name,
        uid: info.uid,
        ics,
        componentType: info.componentType,
        isNew: !r.object,
        ifMatch,
    });
    const headers: Record<string, string> = {};
    // RFC 4791 5.3.4: only send the ETag if the stored data equals what the client sent.
    if (ics === req.body && result.etag && result.storedAsIs) {
        headers.ETag = quoteEtag(result.etag);
    }
    if (ctx.scheduling && result.scheduleTag) headers['Schedule-Tag'] = quoteEtag(result.scheduleTag);
    return {status: r.object ? 204 : 201, headers};
}

function safeParse(ics: string): Component | null {
    try {
        return parseIcs(ics);
    } catch {
        return null;
    }
}

async function del(ctx: Context, req: ParsedRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind === 'inbox-item') {
        if (!r.object) throw CalDavError.notFound();
        const s = ctx.provider.scheduling!;
        if (!s.deleteInboxItem || !ctx.writable) throw CalDavError.forbidden('inbox is read-only');
        await s.deleteInboxItem(ctx.principal, r.name);
        return {status: 204, headers: {}};
    }
    if (r.kind === 'notification') {
        if (!r.invitation) throw CalDavError.notFound();
        const dismiss = ctx.provider.sharing?.dismissInvitation;
        if (!dismiss || !ctx.writable) throw CalDavError.forbidden('notifications cannot be deleted');
        await dismiss(ctx.principal, r.invitation.id);
        return {status: 204, headers: {}};
    }
    if (r.kind === 'calendar') return deleteCalendar(ctx, r);
    if (r.kind !== 'object') throw CalDavError.forbidden('only calendars and calendar objects can be deleted');
    if (!r.object) throw CalDavError.notFound();
    if (!ctx.canDelete(r.calendar)) throw CalDavError.forbidden('calendar is read-only');
    const ifMatch = checkPreconditions(ctx, req, r.object);
    await ctx.provider.deleteObject!(ctx.principal, r.calendar, {name: r.name, ifMatch});
    const attachments = ctx.provider.attachments;
    if (attachments) {
        for (const id of managedIdsOf(r.object.ics)) await attachments.remove(ctx.principal, r.calendar, r.name, id);
    }
    if (ctx.scheduling) {
        const previous = safeParse(r.object.ics);
        const scheduleReply = header(req, 'schedule-reply')?.trim().toUpperCase() !== 'F';
        if (previous) await scheduleDelete(ctx, previous, scheduleReply);
    }
    return {status: 204, headers: {}};
}

/**
 * MOVE of an object to another calendar (RFC 4918 9.9), through the provider's `moveObject`.
 * Collections can't be moved; the target calendar must accept the component.
 */
/** Destination of a MOVE or COPY (RFC 4918 10.3): an object resource on this server. */
async function destinationOf(
    ctx: Context,
    req: ParsedRequest,
    source: Extract<Resource, {kind: 'object'}>,
): Promise<Extract<Resource, {kind: 'object'}>> {
    const destination = header(req, 'destination');
    if (!destination) throw new CalDavError(400, `${req.method.toUpperCase()} needs a Destination header`);
    let destinationPath: string;
    try {
        destinationPath = new URL(destination, 'http://x').pathname;
    } catch {
        throw new CalDavError(400, 'invalid Destination header');
    }
    if (destinationPath !== ctx.base && !destinationPath.startsWith(`${ctx.base}/`)) {
        throw new CalDavError(502, 'Destination is on another server');
    }
    let target: Resource;
    try {
        target = await ctx.resolve(destinationPath);
    } catch (e) {
        // RFC 4918 9.9.4: the destination's collection doesn't exist.
        if (e instanceof CalDavError && e.status === 404) throw new CalDavError(409, 'destination calendar does not exist');
        throw e;
    }
    if (target.kind !== 'object') throw CalDavError.forbidden('the destination must be a calendar object');
    if (target.calendar.id === source.calendar.id && target.name === source.name) {
        throw CalDavError.forbidden('source and destination are the same');
    }
    return target;
}

/** Component type and UID of stored data, if it is a valid object. */
function infoOf(ics: string) {
    const vcal = safeParse(ics);
    try {
        return vcal ? inspectObject(vcal) : undefined;
    } catch {
        return undefined;
    }
}

async function move(ctx: Context, req: ParsedRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind === 'calendar') return transferCalendar(ctx, req, r, true);
    if (!ctx.provider.moveObject) throw CalDavError.forbidden('MOVE is not supported');
    if (r.kind !== 'object') throw CalDavError.forbidden('only calendar objects can be moved');
    if (!r.object) throw CalDavError.notFound();
    const target = await destinationOf(ctx, req, r);
    if (!ctx.canDelete(r.calendar) || !ctx.canWrite(target.calendar)) throw CalDavError.forbidden('calendar is read-only');

    const componentType = infoOf(r.object.ics)?.componentType;
    if (componentType && !target.calendar.components.includes(componentType)) {
        throw CalDavError.caldav(403, 'supported-calendar-component', `calendar does not accept ${componentType}`);
    }
    const overwrite = header(req, 'overwrite')?.trim().toUpperCase() !== 'F';
    if (target.object && !overwrite) throw CalDavError.preconditionFailed('destination exists');
    const ifMatch = checkPreconditions(ctx, req, r.object);

    await ctx.provider.moveObject(ctx.principal, r.calendar, target.calendar, {name: r.name, destinationName: target.name, overwrite, ifMatch});
    return {status: target.object ? 204 : 201, headers: {}};
}

/**
 * COPY of an object into another calendar (RFC 4918 9.8), stored with the provider's
 * `putObject`. A copy within the same calendar would hold the UID twice (RFC 4791 5.3.2.1).
 * The copy is not scheduled: attendees already have the event.
 */
async function copy(ctx: Context, req: ParsedRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind === 'calendar') return transferCalendar(ctx, req, r, false);
    if (r.kind !== 'object') throw CalDavError.forbidden('only calendar objects can be copied');
    if (!r.object) throw CalDavError.notFound();
    const target = await destinationOf(ctx, req, r);
    if (!ctx.canWrite(target.calendar)) throw CalDavError.forbidden('calendar is read-only');
    if (target.calendar.id === r.calendar.id) throw CalDavError.uidConflict('the calendar already holds this UID');

    const info = infoOf(r.object.ics);
    if (!info) throw CalDavError.caldav(403, 'valid-calendar-object-resource', 'the object cannot be copied');
    if (!target.calendar.components.includes(info.componentType)) {
        throw CalDavError.caldav(403, 'supported-calendar-component', `calendar does not accept ${info.componentType}`);
    }
    const overwrite = header(req, 'overwrite')?.trim().toUpperCase() !== 'F';
    if (target.object && !overwrite) throw CalDavError.preconditionFailed('destination exists');
    checkPreconditions(ctx, req, r.object);

    await ctx.provider.putObject!(ctx.principal, target.calendar, {
        name: target.name,
        uid: info.uid,
        ics: r.object.ics,
        componentType: info.componentType,
        isNew: !target.object,
    });
    return {status: target.object ? 204 : 201, headers: {}};
}

function optionsResponse(provider: CalDavProvider<never>, push: boolean): CalDavResponse {
    return {
        status: 200,
        headers: {
            DAV: davHeader(provider, push),
            Allow: METHODS.join(', '),
            'Content-Length': '0',
        },
    };
}

/** Lock checks of the methods that change something (RFC 4918 7). */
async function enforceLocks(ctx: Context, req: ParsedRequest, method: string, path: string): Promise<void> {
    const target = canonicalPath(ctx, path);
    const destination = () => {
        const value = header(req, 'destination');
        if (!value) return [];
        try {
            return [canonicalPath(ctx, new URL(value, 'http://x').pathname)];
        } catch {
            return [];
        }
    };
    switch (method) {
        case 'PUT':
        case 'PROPPATCH':
        case 'MKCOL':
        case 'MKCALENDAR':
            return checkLocks(ctx, req, [target]);
        case 'POST':
            if (new URL(req.url, 'http://x').searchParams.get('action')?.startsWith('attachment-')) return checkLocks(ctx, req, [target]);
            return;
        case 'DELETE':
            return checkLocks(ctx, req, [target], true);
        case 'MOVE':
            await checkLocks(ctx, req, [target], true);
            return checkLocks(ctx, req, destination());
        case 'COPY':
            return checkLocks(ctx, req, destination());
    }
}

function davHeader(provider: CalDavProvider<never>, push: boolean): string {
    return [
        '1',
        ...(provider.locks ? ['2'] : []),
        '3',
        'access-control',
        'calendar-access',
        ...(provider.scheduling ? ['calendar-auto-schedule'] : []),
        ...(provider.createCalendar ? ['extended-mkcol'] : []),
        ...(provider.sharing ? ['calendarserver-sharing', 'resource-sharing'] : []),
        ...(provider.attachments ? ['calendar-managed-attachments'] : []),
        ...(push ? ['webdav-push'] : []),
    ].join(', ');
}

/**
 * The request runs as the owner of the path if the user is their delegate: below
 * `/calendars/<owner>/`, `/inbox/<owner>/`, `/outbox/<owner>/` and `/principals/<owner>/…`.
 */
async function contextFor<P extends Principal>(provider: CalDavProvider<P>, base: string, user: P, path: string): Promise<Context<P>> {
    const ctx = new Context(provider, base, user);
    if (!provider.delegations) return ctx;
    const segs = ctx.segments(path);
    const owner = segs?.[1];
    if (!segs || owner === undefined || owner === user.id || !['calendars', 'inbox', 'outbox', 'principals', 'notifications', 'attachments'].includes(segs[0]!)) return ctx;
    const delegation = (await ctx.delegations()).find((d) => d.principal.id === owner);
    return delegation ? new Context(provider, base, delegation.principal, user, delegation.write) : ctx;
}

/**
 * Creates the framework-independent request handler.
 *
 * ```ts
 * const handle = createCalDavHandler({provider});
 * const res = await handle({method: 'PROPFIND', url: '/dav/', headers, body});
 * ```
 */
export function createCalDavHandler<P extends Principal>(options: CalDavOptions<P>): CalDavHandler {
    const provider = options.provider;
    const base = (options.basePath ?? '/dav').replace(/\/+$/, '');
    const realm = (options.realm ?? 'CalDAV').replace(/"/g, '');

    return async (original) => {
        const req = normalizeRequest(original);
        const method = req.method.toUpperCase();
        const path = new URL(req.url, 'http://x').pathname;
        try {
            if (path === '/.well-known/caldav' || path === '/.well-known/caldav/') {
                return {status: 301, headers: {Location: `${base}/`}};
            }
            if (path !== base && !path.startsWith(`${base}/`)) throw CalDavError.notFound();
            if (method === 'OPTIONS') return optionsResponse(provider as CalDavProvider<never>, !!options.push);
            // Published feeds are public: no login.
            const publicMatch = /^\/public\/([^/]+)$/.exec(path.slice(base.length));
            if (publicMatch && provider.publishing?.resolveFeed && (method === 'GET' || method === 'HEAD')) {
                let token: string;
                try {
                    token = decodeURIComponent(publicMatch[1]!);
                } catch {
                    throw CalDavError.notFound();
                }
                return await publicFeed(provider, token, method === 'HEAD');
            }

            const credentials = parseBasicAuth(header(req, 'authorization'));
            const principal = credentials ? await provider.authenticate(credentials.username, credentials.password) : null;
            if (!principal) {
                return {
                    status: 401,
                    headers: {'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`, 'Content-Type': 'text/plain'},
                    body: 'Unauthorized',
                };
            }
            const ctx = await contextFor(provider, base, principal, path);
            const proto = header(req, 'x-forwarded-proto')?.split(',')[0]?.trim() || 'http';
            ctx.origin = (options.origin ?? `${proto}://${header(req, 'host') ?? 'localhost'}`).replace(/\/+$/, '');
            ctx.maxObjectSize = options.maxObjectSize;
            ctx.push = options.push;
            const registration = /^\/push\/([^/]+)$/.exec(path.slice(base.length));
            if (registration && options.push) {
                if (method !== 'DELETE') return {status: 405, headers: {Allow: 'DELETE'}};
                let id: string;
                try {
                    id = decodeURIComponent(registration[1]!);
                } catch {
                    throw CalDavError.notFound();
                }
                return await handlePushUnregister(ctx, id);
            }
            if (provider.locks) await enforceLocks(ctx, req, method, path);
            let res: CalDavResponse;
            switch (method) {
                case 'LOCK': {
                    let found = false;
                    try {
                        found = exists(await ctx.resolve(path));
                    } catch (e) {
                        if (!(e instanceof CalDavError) || e.status !== 404) throw e;
                    }
                    res = await handleLock(ctx, req, path, found);
                    break;
                }
                case 'UNLOCK':
                    res = await handleUnlock(ctx, req, path);
                    break;
                case 'PROPFIND':
                    res = await propfind(ctx, req, path);
                    break;
                case 'PROPPATCH':
                    res = await proppatch(ctx, req, path);
                    break;
                case 'REPORT':
                    res = await handleReport(ctx, req, path);
                    break;
                case 'GET':
                case 'HEAD':
                    res = await get(ctx, path, method === 'HEAD');
                    break;
                case 'PUT':
                    res = await put(ctx, req, path);
                    break;
                case 'DELETE':
                    res = await del(ctx, req, path);
                    break;
                case 'POST':
                    res = await post(ctx, req, path);
                    break;
                case 'MOVE':
                    res = await move(ctx, req, path);
                    break;
                case 'MKCOL':
                case 'MKCALENDAR':
                    res = await mkcalendar(ctx, req, path, method);
                    break;
                case 'COPY':
                    res = await copy(ctx, req, path);
                    break;
                case 'ACL':
                    // Every ACE is protected; access is up to the provider (RFC 3744 8.1.1).
                    throw CalDavError.dav(403, 'no-protected-ace-conflict', 'the ACL cannot be changed');
                default:
                    return {status: 405, headers: {Allow: METHODS.join(', ')}};
            }
            res.headers.DAV ??= davHeader(provider as CalDavProvider<never>, !!options.push);
            if (options.push && res.status < 300) {
                notifyAfterChange(ctx, req, method, path, (e) => options.onError?.(e, original));
            }
            return res;
        } catch (e) {
            if (e instanceof CalDavError) return errorResponse(e);
            options.onError?.(e, original);
            return {status: 500, headers: {'Content-Type': 'text/plain'}, body: 'Internal Server Error'};
        }
    };
}
