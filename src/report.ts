import {type Context, homeSyncToken, parseHomeSyncToken, parseSyncTokenUri, type Resource, syncTokenUri} from './context.ts';
import {CalDavError} from './errors.ts';
import {FilterError, matchesFilter, parseFilter, queryFromFilter} from './filter.ts';
import {type CalDavRequest, type CalDavResponse, multistatus, parseBody, xmlResponse} from './http.ts';
import {parseIcs} from './ical.ts';
import {propResponse, statusResponse} from './props.ts';
import type {Calendar, CalendarObject} from './types.ts';
import {child, children, d, is, NS, type QName, qnameOf, textOf, type XmlElement, type XNode} from './xml.ts';

function requestedProps(root: XmlElement): QName[] {
    const prop = child(root, NS.DAV, 'prop');
    return prop ? children(prop).map(qnameOf) : [{ns: NS.DAV, name: 'getetag'}];
}

function asResource(calendar: Calendar | null, object: CalendarObject): Resource {
    return calendar
        ? {kind: 'object', calendar, name: object.name, object}
        : {kind: 'inbox-item', name: object.name, object};
}

async function collectionOf(ctx: Context, path: string): Promise<{calendar: Calendar | null; objects?: () => Promise<CalendarObject[]>}> {
    const r = await ctx.resolve(path);
    if (r.kind === 'calendar') return {calendar: r.calendar};
    if (r.kind === 'inbox') return {calendar: null, objects: () => ctx.inboxItems()};
    throw CalDavError.dav(403, 'supported-report', 'report not supported on this resource');
}

async function calendarQuery(ctx: Context, root: XmlElement, path: string): Promise<CalDavResponse> {
    const {calendar, objects} = await collectionOf(ctx, path);
    let filter;
    try {
        filter = parseFilter(child(root, NS.CALDAV, 'filter'));
    } catch (e) {
        if (e instanceof FilterError) throw CalDavError.caldav(403, e.precondition, e.message);
        throw e;
    }
    if (!filter) throw CalDavError.caldav(403, 'valid-filter', 'calendar-query needs a filter');

    const props = requestedProps(root);
    const list = calendar
        ? await ctx.provider.listObjects(ctx.principal, calendar, queryFromFilter(filter))
        : await objects!();
    const floating = calendar?.timezone ? floatingZoneOf(calendar.timezone) : undefined;
    const responses: XNode[] = [];
    for (const object of list) {
        let vcal;
        try {
            vcal = parseIcs(object.ics);
        } catch {
            continue;
        }
        if (!matchesFilter(filter, vcal, floating)) continue;
        responses.push(await propResponse(ctx, asResource(calendar, object), props));
    }
    return multistatus(responses);
}

/** TZID of the VTIMEZONE in calendar-timezone, used for floating times. */
function floatingZoneOf(timezone: string): string | undefined {
    return /^TZID:(.+)$/m.exec(timezone)?.[1]?.trim();
}

async function calendarMultiget(ctx: Context, root: XmlElement, path: string): Promise<CalDavResponse> {
    const {calendar, objects} = await collectionOf(ctx, path);
    const props = requestedProps(root);
    const hrefs = children(root)
        .filter((c) => is(c, NS.DAV, 'href'))
        .map(textOf);

    const collectionHref = calendar ? ctx.calendarHref(calendar) : ctx.inboxHref();
    const names = new Map<string, string>();
    const responses: XNode[] = [];
    for (const href of hrefs) {
        const p = ctx.pathOfHref(href);
        const segs = ctx.segments(p);
        const parent = ctx.segments(collectionHref)!;
        const isChild = segs && segs.length === parent.length + 1 && parent.every((s, i) => segs[i] === s);
        if (isChild) names.set(segs[segs.length - 1]!, href);
        else responses.push(statusResponse(href, 'HTTP/1.1 404 Not Found'));
    }

    let found: CalendarObject[];
    if (!calendar) {
        found = (await objects!()).filter((o) => names.has(o.name));
    } else if (ctx.provider.getObjects) {
        found = await ctx.provider.getObjects(ctx.principal, calendar, [...names.keys()]);
    } else {
        const all = await Promise.all([...names.keys()].map((n) => ctx.provider.getObject(ctx.principal, calendar, n)));
        found = all.filter((o): o is CalendarObject => !!o);
    }
    const byName = new Map(found.map((o) => [o.name, o]));
    for (const [name, href] of names) {
        const object = byName.get(name);
        if (object) responses.push(await propResponse(ctx, asResource(calendar, object), props));
        else responses.push(statusResponse(href, 'HTTP/1.1 404 Not Found'));
    }
    return multistatus(responses);
}

async function syncCollection(ctx: Context, root: XmlElement, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    const level = textOf(child(root, NS.DAV, 'sync-level')) || '1';
    if (level !== '1' && level !== 'infinite') throw new CalDavError(400, `invalid sync-level ${level}`);
    const props = requestedProps(root);
    const tokenUri = textOf(child(root, NS.DAV, 'sync-token'));
    if (r.kind === 'home') return syncHome(ctx, tokenUri, props);
    if (r.kind !== 'calendar') throw CalDavError.dav(403, 'supported-report', 'sync-collection only works on calendars');
    const calendar = r.calendar;

    const responses: XNode[] = [];
    let newToken = calendar.syncToken;
    if (!tokenUri) {
        const all = await ctx.provider.listObjects(ctx.principal, calendar, {});
        for (const o of all) responses.push(await propResponse(ctx, asResource(calendar, o), props));
    } else {
        const token = parseSyncTokenUri(tokenUri);
        const changes = token !== null && ctx.provider.changesSince ? await ctx.provider.changesSince(ctx.principal, calendar, token) : null;
        if (!changes) throw CalDavError.dav(403, 'valid-sync-token', 'unknown sync token, do a full sync');
        newToken = changes.syncToken;
        for (const o of changes.changed) responses.push(await propResponse(ctx, asResource(calendar, o), props));
        for (const name of changes.deleted) responses.push(statusResponse(ctx.objectHref(calendar, name), 'HTTP/1.1 404 Not Found'));
    }
    return multistatus(responses, d('sync-token', syncTokenUri(newToken)));
}

/** sync-collection on the calendar home: reports added, changed and removed calendars. */
async function syncHome(ctx: Context, tokenUri: string, props: QName[]): Promise<CalDavResponse> {
    const calendars = await ctx.calendars();
    let previous: Record<string, string> = {};
    if (tokenUri) {
        const token = parseSyncTokenUri(tokenUri);
        const parsed = token === null ? null : parseHomeSyncToken(token);
        if (!parsed) throw CalDavError.dav(403, 'valid-sync-token', 'unknown sync token, do a full sync');
        previous = parsed;
    }
    const responses: XNode[] = [];
    for (const calendar of calendars) {
        if (previous[calendar.id] !== calendar.syncToken) {
            responses.push(await propResponse(ctx, {kind: 'calendar', calendar}, props));
        }
    }
    const ids = new Set(calendars.map((c) => c.id));
    for (const id of Object.keys(previous)) {
        if (!ids.has(id)) responses.push(statusResponse(`${ctx.homeHref()}${encodeURIComponent(id)}/`, 'HTTP/1.1 404 Not Found'));
    }
    return multistatus(responses, d('sync-token', syncTokenUri(homeSyncToken(calendars))));
}

/**
 * principal-property-search (RFC 3744 9.4). Only the current user can be
 * found; it matches if any search value is contained in its id, name or
 * addresses.
 */
async function principalPropertySearch(ctx: Context, root: XmlElement): Promise<CalDavResponse> {
    const r = await ctx.resolve(ctx.principalHref());
    const haystack = [ctx.principal.id, ctx.principal.displayName ?? '', ...ctx.addresses(), ctx.principalHref(), ctx.homeHref()]
        .join('\n')
        .toLowerCase();
    const matches = children(root)
        .filter((c) => is(c, NS.DAV, 'property-search'))
        .map((c) => textOf(child(c, NS.DAV, 'match')).toLowerCase());
    const anyOf = root.getAttribute('test') !== 'allof';
    const hit = matches.length > 0 && (anyOf ? matches.some((m) => haystack.includes(m)) : matches.every((m) => haystack.includes(m)));
    return multistatus(hit ? [await propResponse(ctx, r, requestedProps(root))] : []);
}

/**
 * expand-property (RFC 3253 3.8). Apple asks for proxy and group membership
 * properties with it. Nested properties are not expanded; the properties are
 * reported like in a PROPFIND, which answers 404 for the ones that do not exist.
 */
async function expandProperty(ctx: Context, root: XmlElement, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    const props = children(root)
        .filter((c) => is(c, NS.DAV, 'property'))
        .map((p) => ({ns: p.getAttribute('namespace') || NS.DAV, name: p.getAttribute('name') ?? ''}))
        .filter((q) => q.name);
    return multistatus([await propResponse(ctx, r, props)]);
}

export async function handleReport(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
    const root = parseBody(req);
    if (!root) throw new CalDavError(400, 'REPORT needs a body');
    if (is(root, NS.CALDAV, 'calendar-query')) return calendarQuery(ctx, root, path);
    if (is(root, NS.CALDAV, 'calendar-multiget')) return calendarMultiget(ctx, root, path);
    if (is(root, NS.DAV, 'sync-collection')) return syncCollection(ctx, root, path);
    if (is(root, NS.DAV, 'expand-property')) return expandProperty(ctx, root, path);
    if (is(root, NS.DAV, 'principal-property-search')) return principalPropertySearch(ctx, root);
    // No searchable properties: clients then do not offer principal search.
    if (is(root, NS.DAV, 'principal-search-property-set')) return xmlResponse(200, d('principal-search-property-set'));
    throw CalDavError.dav(403, 'supported-report', `unsupported report ${root.localName}`);
}
