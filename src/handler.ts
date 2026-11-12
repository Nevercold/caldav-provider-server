import {deleteCalendar, mkcalendar, proppatchCollection} from './collections.ts';
import {Context, quoteEtag, type Resource, unquoteEtag} from './context.ts';
import {CalDavError} from './errors.ts';
import {type Component, IcsError, inspectObject, parseIcs} from './ical.ts';
import {allPropNames, propResponse} from './props.ts';
import {handleReport} from './report.ts';
import {handleOutboxPost, scheduleDelete, schedulePut} from './scheduling.ts';
import type {CalDavProvider, CalendarObject, Principal} from './types.ts';
import {type CalDavRequest, type CalDavResponse, errorResponse, header, multistatus, parseBody} from './http.ts';
import {children, is, NS, type QName, qnameOf, type XNode} from './xml.ts';

export type {CalDavRequest, CalDavResponse};

export interface CalDavOptions<P extends Principal = Principal> {
    provider: CalDavProvider<P>;
    /** URL path the server lives under. Default `/dav`. */
    basePath?: string;
    /** Realm of the Basic auth challenge. */
    realm?: string;
    /** Called for unexpected errors (answered with 500). */
    onError?: (error: unknown, request: CalDavRequest) => void;
}

export type CalDavHandler = (request: CalDavRequest) => Promise<CalDavResponse>;

const METHODS = ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'REPORT', 'POST', 'MKCOL', 'MKCALENDAR', 'MOVE', 'COPY'];

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
function depth(req: CalDavRequest, fallback: '0' | '1'): '0' | '1' {
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
        default:
            return [];
    }
}

function exists(r: Resource): boolean {
    return !((r.kind === 'object' || r.kind === 'inbox-item') && !r.object);
}

async function propfind(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
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

async function proppatch(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
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
    if (r.kind !== 'object' && r.kind !== 'inbox-item') {
        throw new CalDavError(405, 'GET is only supported on calendar objects');
    }
    if (!r.object) throw CalDavError.notFound();
    return {status: 200, headers: objectHeaders(ctx, r.object), body: head ? undefined : r.object.ics};
}

/** If-Match / If-None-Match (RFC 7232) and If-Schedule-Tag-Match (RFC 6638 8.3). */
function checkPreconditions(ctx: Context, req: CalDavRequest, current: CalendarObject | null): string | undefined {
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

async function put(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind !== 'object') throw new CalDavError(405, 'PUT is only supported on calendar objects');
    if (!ctx.canWrite(r.calendar)) throw CalDavError.forbidden('calendar is read-only');

    const type = header(req, 'content-type');
    if (type && !/^text\/calendar\b/i.test(type)) throw CalDavError.caldav(415, 'supported-calendar-data');

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

async function del(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind === 'inbox-item') {
        if (!r.object) throw CalDavError.notFound();
        const s = ctx.provider.scheduling!;
        if (!s.deleteInboxItem) throw CalDavError.forbidden('inbox is read-only');
        await s.deleteInboxItem(ctx.principal, r.name);
        return {status: 204, headers: {}};
    }
    if (r.kind === 'calendar') return deleteCalendar(ctx, r);
    if (r.kind !== 'object') throw CalDavError.forbidden('only calendars and calendar objects can be deleted');
    if (!r.object) throw CalDavError.notFound();
    if (!ctx.canDelete(r.calendar)) throw CalDavError.forbidden('calendar is read-only');
    const ifMatch = checkPreconditions(ctx, req, r.object);
    await ctx.provider.deleteObject!(ctx.principal, r.calendar, {name: r.name, ifMatch});
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
    req: CalDavRequest,
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

async function move(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
    if (!ctx.provider.moveObject) throw CalDavError.forbidden('MOVE is not supported');
    const r = await ctx.resolve(path);
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
async function copy(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
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

function optionsResponse(provider: CalDavProvider<never>): CalDavResponse {
    return {
        status: 200,
        headers: {
            DAV: davHeader(provider),
            Allow: METHODS.join(', '),
            'Content-Length': '0',
        },
    };
}

function davHeader(provider: CalDavProvider<never>): string {
    return [
        '1',
        '3',
        'calendar-access',
        ...(provider.scheduling ? ['calendar-auto-schedule'] : []),
        ...(provider.createCalendar ? ['extended-mkcol'] : []),
    ].join(', ');
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

    return async (req) => {
        const method = req.method.toUpperCase();
        const path = new URL(req.url, 'http://x').pathname;
        try {
            if (path === '/.well-known/caldav' || path === '/.well-known/caldav/') {
                return {status: 301, headers: {Location: `${base}/`}};
            }
            if (path !== base && !path.startsWith(`${base}/`)) throw CalDavError.notFound();
            if (method === 'OPTIONS') return optionsResponse(provider as CalDavProvider<never>);

            const credentials = parseBasicAuth(header(req, 'authorization'));
            const principal = credentials ? await provider.authenticate(credentials.username, credentials.password) : null;
            if (!principal) {
                return {
                    status: 401,
                    headers: {'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`, 'Content-Type': 'text/plain'},
                    body: 'Unauthorized',
                };
            }
            const ctx = new Context(provider, base, principal);
            let res: CalDavResponse;
            switch (method) {
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
                    res = await handleOutboxPost(ctx, req, path);
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
                default:
                    return {status: 405, headers: {Allow: METHODS.join(', ')}};
            }
            res.headers.DAV ??= davHeader(provider as CalDavProvider<never>);
            return res;
        } catch (e) {
            if (e instanceof CalDavError) return errorResponse(e);
            options.onError?.(e, req);
            return {status: 500, headers: {'Content-Type': 'text/plain'}, body: 'Internal Server Error'};
        }
    };
}
