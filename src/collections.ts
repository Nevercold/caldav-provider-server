import type {Context, Resource} from './context.ts';
import {CalDavError} from './errors.ts';
import {type CalDavResponse, multistatus, parseBody, type ParsedRequest as CalDavRequest, xmlResponse} from './http.ts';
import type {CalendarChanges, ComponentType, NewCalendar} from './types.ts';
import {children, d, el, is, NS, type QName, qkey, qnameOf, textOf, type XmlElement, type XNode} from './xml.ts';

/*
 * Calendar collections: PROPPATCH (RFC 4918 9.2), MKCALENDAR (RFC 4791 5.3.1),
 * extended MKCOL (RFC 5689) and DELETE, each through an optional provider hook.
 */

type Field = keyof CalendarChanges;

const COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/** Properties the provider stores. `parse` returns undefined for an invalid value (409). */
const WRITABLE: Record<string, {field: Field; parse: (e: XmlElement) => string | number | boolean | undefined}> = {
    [qkey({ns: NS.CALDAV, name: 'calendar-timezone'})]: {
        field: 'timezone',
        parse: (e) => {
            const tz = e.textContent ?? '';
            return tz.includes('BEGIN:VTIMEZONE') ? tz : undefined;
        },
    },
    [qkey({ns: NS.CALDAV, name: 'schedule-calendar-transp'})]: {
        field: 'transparent',
        parse: (e) => {
            const kids = children(e);
            if (kids.length !== 1) return undefined;
            if (is(kids[0], NS.CALDAV, 'transparent')) return true;
            return is(kids[0], NS.CALDAV, 'opaque') ? false : undefined;
        },
    },
    [qkey({ns: NS.DAV, name: 'displayname'})]: {field: 'displayName', parse: (e) => textOf(e)},
    [qkey({ns: NS.CALDAV, name: 'calendar-description'})]: {field: 'description', parse: (e) => textOf(e)},
    [qkey({ns: NS.APPLE, name: 'calendar-color'})]: {
        field: 'color',
        parse: (e) => (COLOR.test(textOf(e)) ? textOf(e) : undefined),
    },
    [qkey({ns: NS.APPLE, name: 'calendar-order'})]: {
        field: 'order',
        parse: (e) => (/^-?\d+$/.test(textOf(e)) ? Number(textOf(e)) : undefined),
    },
};

const REASONS: Record<number, string> = {
    200: 'OK',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    412: 'Precondition Failed',
    424: 'Failed Dependency',
    507: 'Insufficient Storage',
};

const statusLine = (status: number): string => `HTTP/1.1 ${status} ${REASONS[status] ?? ''}`.trimEnd();

/** One propstat per status, in order of first appearance. */
function propstats(results: {q: QName; status: number}[]): XNode[] {
    const groups = new Map<number, XNode[]>();
    for (const {q, status} of results) {
        if (!groups.has(status)) groups.set(status, []);
        groups.get(status)!.push(el(q.ns, q.name));
    }
    return [...groups].map(([status, props]) => d('propstat', d('prop', ...props), d('status', statusLine(status))));
}

/** The property elements of a propertyupdate/mkcol/mkcalendar body, with the operation. */
function operations(root: XmlElement): {prop: XmlElement; remove: boolean}[] {
    const out: {prop: XmlElement; remove: boolean}[] = [];
    for (const op of children(root)) {
        const remove = is(op, NS.DAV, 'remove');
        if (!remove && !is(op, NS.DAV, 'set')) continue;
        for (const prop of children(op).filter((p) => is(p, NS.DAV, 'prop'))) {
            for (const p of children(prop)) out.push({prop: p, remove});
        }
    }
    return out;
}

/**
 * PROPPATCH. Only calendars with `updateCalendar` and not `readOnly` are writable; everything
 * else answers 403 per property. The update is atomic: if one property fails, the others answer
 * 424 and the provider is not called.
 */
export async function proppatchCollection(ctx: Context, req: CalDavRequest, target: Resource): Promise<CalDavResponse> {
    const root = parseBody(req);
    if (!is(root, NS.DAV, 'propertyupdate')) throw new CalDavError(400, 'expected DAV:propertyupdate');
    const ops = operations(root!);
    if (target.kind === 'proxy-group') return proppatchProxyGroup(ctx, target, ops);
    const editable = target.kind === 'calendar' && ctx.canEditCalendar(target.calendar);

    const changes: CalendarChanges = {};
    const results = ops.map(({prop, remove}) => {
        const q = qnameOf(prop);
        const w = WRITABLE[qkey(q)];
        if (!editable || !w) return {q, status: 403};
        const value = remove ? null : w.parse(prop);
        if (value === undefined) return {q, status: 409};
        (changes as Record<string, unknown>)[w.field] = value;
        return {q, status: 200};
    });

    if (results.some((r) => r.status !== 200)) {
        for (const r of results) if (r.status === 200) r.status = 424;
    } else if (results.length && target.kind === 'calendar') {
        try {
            await ctx.provider.updateCalendar!(ctx.principal, target.calendar, changes);
        } catch (e) {
            if (!(e instanceof CalDavError)) throw e;
            for (const r of results) r.status = e.status;
        }
    }
    return multistatus([d('response', d('href', ctx.href(target)), ...propstats(results))]);
}

/**
 * PROPPATCH of group-member-set on the principal's own proxy group: the client changes its
 * delegates. Only that property, through `setDelegates`.
 */
async function proppatchProxyGroup(
    ctx: Context,
    target: Extract<Resource, {kind: 'proxy-group'}>,
    ops: {prop: XmlElement; remove: boolean}[],
): Promise<CalDavResponse> {
    const editable = !!ctx.provider.setDelegates && !ctx.delegated;
    let ids: string[] | undefined;
    const results = ops.map(({prop, remove}) => {
        const q = qnameOf(prop);
        if (!editable || !is(prop, NS.DAV, 'group-member-set')) return {q, status: 403};
        const list: string[] = [];
        for (const h of remove ? [] : children(prop).filter((c) => is(c, NS.DAV, 'href'))) {
            const segs = ctx.segments(ctx.pathOfHref(textOf(h)));
            if (!segs || segs[0] !== 'principals' || segs.length !== 2 || segs[1] === ctx.principal.id) return {q, status: 409};
            list.push(segs[1]!);
        }
        ids = [...new Set(list)];
        return {q, status: 200};
    });
    if (results.some((r) => r.status !== 200)) {
        for (const r of results) if (r.status === 200) r.status = 424;
    } else if (ids) {
        try {
            await ctx.provider.setDelegates!(ctx.principal, target.write, ids);
        } catch (e) {
            if (!(e instanceof CalDavError)) throw e;
            for (const r of results) r.status = e.status;
        }
    }
    return multistatus([d('response', d('href', ctx.href(target)), ...propstats(results))]);
}

const SUPPORTED: ComponentType[] = ['VEVENT', 'VTODO'];

/**
 * Reads the properties of a MKCALENDAR or extended MKCOL body. Besides the writable properties
 * it accepts what clients send along when creating a calendar: resourcetype (DAVx⁵),
 * supported-calendar-component-set and calendar-timezone-id (RFC 7809, ignored).
 */
function readNewCalendar(
    id: string,
    root: XmlElement | null,
    mkcol: boolean,
): {calendar: NewCalendar; results: {q: QName; status: number}[]} {
    const calendar: NewCalendar = {displayName: id, components: [...SUPPORTED]};
    const results: {q: QName; status: number}[] = [];
    let isCalendar = !mkcol;
    for (const {prop, remove} of root ? operations(root) : []) {
        const q = qnameOf(prop);
        const w = WRITABLE[qkey(q)];
        let status = 200;
        if (remove) {
            status = 403;
        } else if (w) {
            const value = w.parse(prop);
            if (value === undefined) status = 409;
            else (calendar as unknown as Record<string, unknown>)[w.field] = value;
        } else if (is(prop, NS.DAV, 'resourcetype')) {
            const kids = children(prop);
            isCalendar = kids.some((k) => is(k, NS.CALDAV, 'calendar'));
            // Only calendars can be created; other resource types fail the request.
            if (!isCalendar || kids.some((k) => !is(k, NS.DAV, 'collection') && !is(k, NS.CALDAV, 'calendar'))) {
                status = 403;
            }
        } else if (is(prop, NS.CALDAV, 'supported-calendar-component-set')) {
            const names = children(prop)
                .filter((c) => is(c, NS.CALDAV, 'comp'))
                .map((c) => (c.getAttribute('name') ?? '').toUpperCase());
            // Unsupported types such as VJOURNAL are dropped as long as one supported type is left.
            const components = SUPPORTED.filter((s) => names.includes(s));
            if (components.length) calendar.components = components;
            else status = 403;
        } else if (is(prop, NS.CALDAV, 'calendar-timezone-id')) {
            // Accepted without effect: the VTIMEZONE comes with calendar-timezone.
        } else {
            status = 403;
        }
        results.push({q, status});
    }
    if (!isCalendar) throw CalDavError.dav(403, 'valid-resourcetype', 'only calendar collections can be created');
    return {calendar, results};
}

/** MKCALENDAR and extended MKCOL on `/calendars/<principal>/<id>/`. */
export async function mkcalendar(ctx: Context, req: CalDavRequest, path: string, method: string): Promise<CalDavResponse> {
    const mkcol = method === 'MKCOL';
    const segs = ctx.segments(path);
    if (!segs || segs[0] !== 'calendars' || segs.length !== 3) {
        throw CalDavError.caldav(403, 'calendar-collection-location-ok', 'calendars can only be created in the calendar home');
    }
    const [, owner, id] = segs as [string, string, string];
    if (owner !== ctx.principal.id) throw CalDavError.forbidden('resource of another principal');
    if (!ctx.provider.createCalendar || !ctx.writable) throw CalDavError.forbidden('creating calendars is not allowed');
    if (!id.trim() || id.includes('/')) throw new CalDavError(400, 'invalid calendar id');
    if (await ctx.calendar(id)) throw CalDavError.dav(405, 'resource-must-be-null', 'the calendar exists');

    const root = parseBody(req);
    if (mkcol ? !is(root, NS.DAV, 'mkcol') : root && !is(root, NS.CALDAV, 'mkcalendar')) {
        if (mkcol && !root) throw CalDavError.forbidden('plain collections cannot be created');
        throw new CalDavError(400, `expected ${mkcol ? 'DAV:mkcol' : 'CALDAV:mkcalendar'}`);
    }
    const {calendar, results} = readNewCalendar(id, root, mkcol);
    if (results.some((r) => r.status !== 200)) {
        for (const r of results) if (r.status === 200) r.status = 424;
        const body = mkcol ? d('mkcol-response', ...propstats(results)) : el(NS.CALDAV, 'mkcalendar-response', ...propstats(results));
        return xmlResponse(403, body);
    }
    await ctx.provider.createCalendar(ctx.principal, id, calendar);
    return {status: 201, headers: {Location: ctx.calendarHref({id})}};
}

/** DELETE of a whole calendar. */
export async function deleteCalendar(ctx: Context, target: Extract<Resource, {kind: 'calendar'}>): Promise<CalDavResponse> {
    if (!ctx.provider.deleteCalendar) throw CalDavError.forbidden('deleting calendars is not supported');
    if (target.calendar.readOnly || !ctx.writable) throw CalDavError.forbidden('calendar is read-only');
    await ctx.provider.deleteCalendar(ctx.principal, target.calendar);
    return {status: 204, headers: {}};
}
