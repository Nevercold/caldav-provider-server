import {notificationEtag, notificationsSyncToken, parseNotificationsSyncToken} from './sharing.ts';
import {type Context, homeSyncToken, notificationName, parseHomeSyncToken, parseSyncTokenUri, type Resource, syncTokenUri} from './context.ts';
import {parseCalendarDataRequest} from './calendardata.ts';
import {CalDavError} from './errors.ts';
import {FilterError, matchesFilter, parseFilter, queryFromFilter} from './filter.ts';
import {floatingZoneOf, freeBusyQuery} from './freebusy.ts';
import {type CalDavResponse, multistatus, parseBody, type ParsedRequest as CalDavRequest, xmlResponse} from './http.ts';
import {parseIcs} from './ical.ts';
import {getProp, propResponse, statusResponse} from './props.ts';
import type {Calendar, CalendarObject, PrincipalSearchQuery} from './types.ts';
import {child, children, d, el, is, NS, type QName, qnameOf, textOf, type XmlElement, type XNode} from './xml.ts';

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
    const floating = floatingZoneOf(calendar?.timezone);
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
    if (r.kind === 'notifications') return syncNotifications(ctx, tokenUri, props);
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

/** sync-collection on the notification collection, stateless like the calendar home's. */
async function syncNotifications(ctx: Context, tokenUri: string, props: QName[]): Promise<CalDavResponse> {
    const list = await ctx.invitations();
    let previous: Record<string, string> = {};
    if (tokenUri) {
        const token = parseSyncTokenUri(tokenUri);
        const parsed = token === null ? null : parseNotificationsSyncToken(token);
        if (!parsed) throw CalDavError.dav(403, 'valid-sync-token', 'unknown sync token, do a full sync');
        previous = parsed;
    }
    const responses: XNode[] = [];
    for (const invitation of list) {
        const name = notificationName(invitation);
        if (previous[name] !== notificationEtag(invitation)) {
            responses.push(await propResponse(ctx, {kind: 'notification', name, invitation}, props));
        }
    }
    const names = new Set(list.map(notificationName));
    for (const name of Object.keys(previous)) {
        if (!names.has(name)) responses.push(statusResponse(`${ctx.notificationsHref()}${encodeURIComponent(name)}`, 'HTTP/1.1 404 Not Found'));
    }
    return multistatus(responses, d('sync-token', syncTokenUri(notificationsSyncToken(list))));
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
 * The signed-in principal if the terms match its id, name or addresses (clients
 * look themselves up this way), plus the provider's results.
 */
async function principalSearch(ctx: Context, query: PrincipalSearchQuery, props: QName[]): Promise<CalDavResponse> {
    const terms = query.terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!terms.length) return multistatus([]);
    const haystack = [ctx.principal.id, ctx.principal.displayName ?? '', ...ctx.addresses(), ctx.principalHref(), ctx.homeHref()]
        .join('\n')
        .toLowerCase();
    const selfHit = query.test === 'allof' ? terms.every((t) => haystack.includes(t)) : terms.some((t) => haystack.includes(t));

    const responses: XNode[] = [];
    if (selfHit) responses.push(await propResponse(ctx, await ctx.resolve(ctx.principalHref()), props));
    if (ctx.provider.searchPrincipals) {
        const found = await ctx.provider.searchPrincipals(ctx.principal, {...query, terms});
        for (const f of found) {
            if (f.id === ctx.principal.id) continue;
            if (query.limit && responses.length >= query.limit) break;
            responses.push(await propResponse(ctx, {kind: 'other-principal', found: f}, props));
        }
    }
    return multistatus(responses);
}

/** principal-property-search (RFC 3744 9.4): the match values are the terms. */
function principalPropertySearch(ctx: Context, root: XmlElement): Promise<CalDavResponse> {
    const terms = children(root)
        .filter((c) => is(c, NS.DAV, 'property-search'))
        .map((c) => textOf(child(c, NS.DAV, 'match')));
    return principalSearch(ctx, {terms, test: root.getAttribute('test') === 'allof' ? 'allof' : 'anyof'}, requestedProps(root));
}

/** Apple's calendarserver-principal-search (CalendarServer caldav-principal-search). */
function calendarServerPrincipalSearch(ctx: Context, root: XmlElement): Promise<CalDavResponse> {
    const terms = children(root)
        .filter((c) => is(c, NS.CS, 'search-token'))
        .map((c) => textOf(c));
    const limitText = textOf(child(child(root, NS.CS, 'limit'), NS.CS, 'nresults'));
    const limit = Number.parseInt(limitText, 10);
    return principalSearch(
        ctx,
        {
            terms,
            test: root.getAttribute('test') === 'anyof' ? 'anyof' : 'allof',
            context: root.getAttribute('context') || undefined,
            limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        },
        requestedProps(root),
    );
}

/** One `<D:property>` of an expand-property request, with the properties to expand it with. */
interface ExpandSpec {
    q: QName;
    nested: ExpandSpec[];
}

function expandSpecs(el: XmlElement): ExpandSpec[] {
    return children(el)
        .filter((c) => is(c, NS.DAV, 'property') && c.getAttribute('name'))
        .map((p) => ({q: {ns: p.getAttribute('namespace') || NS.DAV, name: p.getAttribute('name')!}, nested: expandSpecs(p)}));
}

/** A DAV:response for `r`; hrefs in properties with nested specs become responses of their targets. */
async function expandResponse(ctx: Context, r: Resource, specs: ExpandSpec[], depth: number): Promise<XNode> {
    const found: XNode[] = [];
    const missing: XNode[] = [];
    for (const spec of specs) {
        const result = await getProp(ctx, r, spec.q);
        if (result.status !== 200) {
            missing.push(el(spec.q.ns, spec.q.name));
            continue;
        }
        let value = result.value;
        if (spec.nested.length && depth < 3) {
            value = [];
            for (const kid of result.value.flat()) {
                const isHref = kid && typeof kid === 'object' && kid.ns === NS.DAV && kid.name === 'href';
                if (!isHref) {
                    value.push(kid);
                    continue;
                }
                const target = String(kid.children?.[0] ?? '');
                try {
                    value.push(await expandResponse(ctx, await ctx.resolve(ctx.pathOfHref(target)), spec.nested, depth + 1));
                } catch (e) {
                    if (!(e instanceof CalDavError)) throw e;
                    value.push(statusResponse(target, `HTTP/1.1 ${e.status === 403 ? '403 Forbidden' : '404 Not Found'}`));
                }
            }
        }
        found.push(el(spec.q.ns, spec.q.name, ...value));
    }
    const propstat = (list: XNode[], status: string) => d('propstat', d('prop', ...list), d('status', status));
    return d(
        'response',
        d('href', ctx.href(r)),
        found.length || !missing.length ? propstat(found, 'HTTP/1.1 200 OK') : null,
        missing.length ? propstat(missing, 'HTTP/1.1 404 Not Found') : null,
    );
}

/**
 * expand-property (RFC 3253 3.8). Apple asks for the delegation properties with it
 * (calendar-proxy-write-for with the owners' names and addresses).
 */
async function expandProperty(ctx: Context, root: XmlElement, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    return multistatus([await expandResponse(ctx, r, expandSpecs(root), 0)]);
}

/**
 * The properties a principal search can match. Without a provider search
 * nothing is offered, so clients don't show a search that only finds the user.
 */
function principalSearchPropertySet(ctx: Context): CalDavResponse {
    if (!ctx.provider.searchPrincipals) return xmlResponse(200, d('principal-search-property-set'));
    const property = (ns: string, name: string, description: string) =>
        d('principal-search-property', d('prop', el(ns, name)), {ns: NS.DAV, name: 'description', attrs: {'xml:lang': 'en'}, children: [description]});
    return xmlResponse(
        200,
        d(
            'principal-search-property-set',
            property(NS.DAV, 'displayname', 'Display name'),
            property(NS.CALDAV, 'calendar-user-address-set', 'Calendar user address'),
            property(NS.CS, 'email-address-set', 'E-mail address'),
        ),
    );
}

export async function handleReport(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
    const root = parseBody(req);
    if (!root) throw new CalDavError(400, 'REPORT needs a body');
    ctx.calendarData = parseCalendarDataRequest(child(child(root, NS.DAV, 'prop'), NS.CALDAV, 'calendar-data'));
    if (is(root, NS.CALDAV, 'calendar-query')) return calendarQuery(ctx, root, path);
    if (is(root, NS.CALDAV, 'calendar-multiget')) return calendarMultiget(ctx, root, path);
    if (is(root, NS.CALDAV, 'free-busy-query')) return freeBusyQuery(ctx, root, path);
    if (is(root, NS.DAV, 'sync-collection')) return syncCollection(ctx, root, path);
    if (is(root, NS.DAV, 'expand-property')) return expandProperty(ctx, root, path);
    if (is(root, NS.DAV, 'principal-property-search')) return principalPropertySearch(ctx, root);
    if (is(root, NS.CS, 'calendarserver-principal-search')) return calendarServerPrincipalSearch(ctx, root);
    if (is(root, NS.DAV, 'principal-search-property-set')) return principalSearchPropertySet(ctx);
    throw CalDavError.dav(403, 'supported-report', `unsupported report ${root.localName}`);
}
