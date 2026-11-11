import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {MemoryProvider} from '../example/memory-provider.ts';
import {type CalDavResponse, createCalDavHandler} from '../src/index.ts';
import type {XmlElement} from '../src/xml.ts';
import {ics, props, statuses, xml} from './helpers.ts';

/*
 * Request bodies of real clients, see test/fixtures/SOURCES.md. The fixtures
 * use the paths /calendars/user/calendar/ (events) and /calendars/user/tasks/
 * (to-dos); the server runs below /dav with the same user and calendar ids.
 */

const dir = join(import.meta.dirname, 'fixtures');
const fixture = (file: string) => readFileSync(join(dir, file), 'utf8');

function server() {
    const provider = new MemoryProvider()
        .addUser({id: 'user', username: 'user', password: 'pw', displayName: 'User 01', addresses: ['mailto:user01@example.com']})
        .addUser({id: 'user02', username: 'user02', password: 'pw', displayName: 'User 02', addresses: ['mailto:user02@example.com']})
        .addCalendar({id: 'calendar', displayName: 'Calendar', components: ['VEVENT'], color: '#FF0000FF', order: 1}, {user: 'write'})
        .addCalendar({id: 'tasks', displayName: 'Tasks', components: ['VTODO']}, {user: 'write'})
        .addCalendar({id: 'shared', displayName: 'Shared', components: ['VEVENT']}, {user: 'read', user02: 'write'});
    provider.seed('calendar', 'event1.ics', ics('VEVENT', 'event1', 'DTSTART:20150701T100000Z', 'DTEND:20150701T110000Z', 'SUMMARY:2015'));
    provider.seed('calendar', 'event2.ics', ics('VEVENT', 'event2', 'DTSTART:20250301T100000Z', 'DTEND:20250301T110000Z', 'SUMMARY:2025'));
    provider.seed('tasks', 'task1.ics', ics('VTODO', 'task1', 'SUMMARY:Open', 'STATUS:NEEDS-ACTION'));
    provider.seed('tasks', 'task2.ics', ics('VTODO', 'task2', 'SUMMARY:Done', 'STATUS:COMPLETED', 'COMPLETED:20250101T000000Z'));
    provider.seed('shared', 'busy.ics', ics('VEVENT', 'busy', 'DTSTART:20250115T100000Z', 'DTEND:20250115T110000Z'));
    const handle = createCalDavHandler({provider, onError: (e) => console.error(e)});
    return (method: string, url: string, body: string, headers: Record<string, string> = {}): Promise<CalDavResponse> =>
        handle({
            method,
            url,
            body: body.replace(/>\/calendars\/user\//g, '>/dav/calendars/user/'),
            headers: {authorization: `Basic ${btoa('user:pw')}`, ...headers},
        });
}

const CAL = '/dav/calendars/user/calendar/';
const TASKS = '/dav/calendars/user/tasks/';
const HOME = '/dav/calendars/user/';
const PRINCIPAL = '/dav/principals/user/';

/** Text of a direct child of the multistatus, e.g. its sync-token. */
function first(res: CalDavResponse, ns: string, name: string): string | undefined {
    const top = Array.from(xml(res).childNodes).find((n) => n.nodeType === 1 && (n as XmlElement).namespaceURI === ns && (n as XmlElement).localName === name);
    return top?.textContent ?? undefined;
}

async function syncToken(send: ReturnType<typeof server>, url: string): Promise<string> {
    const res = await send('REPORT', url, '<d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:prop><d:getetag/></d:prop></d:sync-collection>', {
        depth: '1',
    });
    return first(res, 'DAV:', 'sync-token')!;
}

describe('every fixture gets a well-formed answer', () => {
    const cases: [string, string, string, Record<string, string>][] = [
        ['apple-calendar/01-propfind-well-known.xml', 'PROPFIND', '/.well-known/caldav/', {depth: '0'}],
        ['apple-calendar/02-propfind-principal-initial.xml', 'PROPFIND', '/dav/principals/', {depth: '0'}],
        ['apple-calendar/03-propfind-principal.xml', 'PROPFIND', PRINCIPAL, {depth: '0'}],
        ['apple-calendar/04-report-principal-search-property-set.xml', 'REPORT', '/dav/principals/', {depth: '0'}],
        ['apple-calendar/05-report-expand-property-proxy.xml', 'REPORT', PRINCIPAL, {}],
        ['apple-calendar/06-propfind-calendar-home-depth1.xml', 'PROPFIND', HOME, {depth: '1'}],
        ['apple-calendar/08-propfind-calendar-ctag.xml', 'PROPFIND', CAL, {depth: '0'}],
        ['apple-calendar/09-report-calendar-query-vevent.xml', 'REPORT', CAL, {depth: '1'}],
        ['apple-calendar/10-propfind-calendar-depth1.xml', 'PROPFIND', CAL, {depth: '1'}],
        ['apple-calendar/11-report-sync-collection-calendar-initial.xml', 'REPORT', CAL, {depth: '1'}],
        ['apple-calendar/13-report-calendar-multiget.xml', 'REPORT', CAL, {}],
        ['apple-calendar/14-propfind-inbox-depth1.xml', 'PROPFIND', '/dav/inbox/user/', {depth: '1'}],
        ['apple-reminders/01-propfind-well-known.xml', 'PROPFIND', '/.well-known/caldav/', {depth: '0'}],
        ['apple-reminders/02-propfind-principal-initial.xml', 'PROPFIND', '/dav/principals/', {depth: '0'}],
        ['apple-reminders/03-propfind-principal.xml', 'PROPFIND', PRINCIPAL, {depth: '0'}],
        ['apple-reminders/04-report-principal-search-property-set.xml', 'REPORT', '/dav/principals/', {depth: '0'}],
        ['apple-reminders/05-propfind-calendar-home-depth1.xml', 'PROPFIND', HOME, {depth: '1'}],
        ['apple-reminders/06-propfind-tasks-ctag.xml', 'PROPFIND', TASKS, {depth: '0'}],
        ['apple-reminders/07-report-calendar-query-vtodo.xml', 'REPORT', TASKS, {depth: '1'}],
        ['apple-reminders/08-report-calendar-query-vevent-time-range.xml', 'REPORT', CAL, {depth: '1'}],
        ['apple-reminders/09-report-calendar-multiget-vtodo.xml', 'REPORT', TASKS, {}],
        ['apple-reminders/10-propfind-inbox-depth1.xml', 'PROPFIND', '/dav/inbox/user/', {depth: '1'}],
        ['thunderbird/01-propfind-detect-collection.xml', 'PROPFIND', '/dav/', {depth: '0'}],
        ['thunderbird/02-propfind-principal-calendar-home-set.xml', 'PROPFIND', PRINCIPAL, {depth: '0'}],
        ['thunderbird/03-propfind-calendar-home-depth1.xml', 'PROPFIND', HOME, {depth: '1'}],
        ['thunderbird/04-propfind-calendar-resource-type.xml', 'PROPFIND', CAL, {depth: '0'}],
        ['thunderbird/05-propfind-calendar-ctag.xml', 'PROPFIND', CAL, {depth: '0'}],
        ['thunderbird/06-propfind-calendar-depth1-etags.xml', 'PROPFIND', CAL, {depth: '1'}],
        ['thunderbird/07-report-sync-collection-initial.xml', 'REPORT', CAL, {depth: '1'}],
        ['thunderbird/09-report-calendar-multiget.xml', 'REPORT', CAL, {depth: '1'}],
        ['thunderbird/10-propfind-calendar-home-principal-collection-set.xml', 'PROPFIND', HOME, {depth: '0'}],
        ['thunderbird/11-propfind-principal-scheduling.xml', 'PROPFIND', PRINCIPAL, {depth: '0'}],
        ['thunderbird/12-report-principal-property-search.xml', 'REPORT', '/dav/principals/', {depth: '1'}],
        ['davx5/01-propfind-current-user-principal.xml', 'PROPFIND', '/dav/', {depth: '0'}],
        ['davx5/02-propfind-base-url-discovery.xml', 'PROPFIND', '/dav/', {depth: '0'}],
        ['davx5/03-propfind-principal-home-set.xml', 'PROPFIND', PRINCIPAL, {depth: '0'}],
        ['davx5/04-propfind-principal-calendar-user-address-set.xml', 'PROPFIND', PRINCIPAL, {depth: '0'}],
        ['davx5/05-propfind-calendar-home-depth1.xml', 'PROPFIND', HOME, {depth: '1'}],
        ['davx5/06-propfind-principal-refresh.xml', 'PROPFIND', PRINCIPAL, {depth: '0'}],
        ['davx5/07-propfind-calendar-capabilities.xml', 'PROPFIND', CAL, {depth: '0'}],
        ['davx5/08-propfind-calendar-sync-state.xml', 'PROPFIND', CAL, {depth: '0'}],
        ['davx5/09-report-sync-collection-initial.xml', 'REPORT', CAL, {depth: '0'}],
        ['davx5/11-report-calendar-query-vevent-time-range.xml', 'REPORT', CAL, {depth: '1'}],
        ['davx5/12-report-calendar-query-vevent.xml', 'REPORT', CAL, {depth: '1'}],
        ['davx5/13-report-calendar-query-vtodo.xml', 'REPORT', TASKS, {depth: '1'}],
        ['davx5/14-report-calendar-multiget.xml', 'REPORT', CAL, {}],
    ];

    it.each(cases)('%s', async (file, method, url, headers) => {
        const res = await server()(method, url, fixture(file), {'content-type': 'text/xml; charset=utf-8', ...headers});
        expect([200, 207, 301]).toContain(res.status);
        if (res.status !== 301) expect(() => xml(res)).not.toThrow();
    });
});

describe('Apple Calendar', () => {
    it('discovers principal, home and inbox/outbox', async () => {
        const send = server();
        const wk = await send('PROPFIND', '/.well-known/caldav/', fixture('apple-calendar/01-propfind-well-known.xml'), {depth: '0'});
        expect(wk.headers.Location).toBe('/dav/');
        const initial = props(await send('PROPFIND', '/dav/principals/', fixture('apple-calendar/02-propfind-principal-initial.xml'), {depth: '0'}));
        expect(initial['/dav/principals/']!['current-user-principal']).toBe(`href(${PRINCIPAL})`);

        const p = props(await send('PROPFIND', PRINCIPAL, fixture('apple-calendar/03-propfind-principal.xml'), {depth: '0'}))[PRINCIPAL]!;
        expect(p['calendar-home-set']).toBe(`href(${HOME})`);
        expect(p['calendar-user-address-set']).toContain('mailto:user01@example.com');
        expect(p['schedule-inbox-URL']).toBe('href(/dav/inbox/user/)');
        expect(p['schedule-outbox-URL']).toBe('href(/dav/outbox/user/)');
        expect(p['principal-URL']).toBe(`href(${PRINCIPAL})`);
    });

    it('principal-search-property-set and expand-property', async () => {
        const send = server();
        const set = await send('REPORT', '/dav/principals/', fixture('apple-calendar/04-report-principal-search-property-set.xml'), {depth: '0'});
        expect(set.status).toBe(200);
        expect(set.body).toContain('principal-search-property-set');
        const expand = await send('REPORT', PRINCIPAL, fixture('apple-calendar/05-report-expand-property-proxy.xml'));
        expect(expand.status).toBe(207);
    });

    it('lists calendars with color, order, ctag and privileges', async () => {
        const send = server();
        const p = props(await send('PROPFIND', HOME, fixture('apple-calendar/06-propfind-calendar-home-depth1.xml'), {depth: '1'}));
        expect(p[CAL]).toMatchObject({
            displayname: 'Calendar',
            'calendar-color': '#FF0000FF',
            'calendar-order': '1',
            'supported-calendar-component-set': 'comp[VEVENT]',
            resourcetype: 'collection calendar',
        });
        expect(p[CAL]!.getctag).toBeDefined();
        expect(p[CAL]!['current-user-privilege-set']).toContain('privilege(write)');
        expect(p['/dav/calendars/user/shared/']!['current-user-privilege-set']).not.toContain('write');
        expect(p[TASKS]!['supported-calendar-component-set']).toBe('comp[VTODO]');
    });

    it('home sync-collection reports changed and removed calendars', async () => {
        const send = server();
        const body = fixture('apple-calendar/07-report-sync-collection-calendar-home.xml');
        // the fixture carries a token of another server
        expect((await send('REPORT', HOME, body, {depth: '1'})).status).toBe(403);

        const initial = await send('REPORT', HOME, body.replace(/<A:sync-token>[^<]*<\/A:sync-token>/, '<A:sync-token></A:sync-token>'), {depth: '1'});
        expect(Object.keys(props(initial)).sort()).toEqual([CAL, '/dav/calendars/user/shared/', TASKS]);
        const token = first(initial, 'DAV:', 'sync-token')!;

        const unchanged = await send('REPORT', HOME, body.replace('http://example.com/ns/sync/1234', token), {depth: '1'});
        expect(Object.keys(props(unchanged))).toEqual([]);
        expect(first(unchanged, 'DAV:', 'sync-token')).toBe(token);
    });

    it('calendar-query with time-range returns only matching events', async () => {
        const send = server();
        const res = await send('REPORT', CAL, fixture('apple-calendar/09-report-calendar-query-vevent.xml'), {depth: '1'});
        expect(Object.keys(props(res))).toEqual([`${CAL}event1.ics`]);
    });

    it('sync-collection: initial sync, then with token', async () => {
        const send = server();
        const initial = await send('REPORT', CAL, fixture('apple-calendar/11-report-sync-collection-calendar-initial.xml'), {depth: '1'});
        expect(Object.keys(props(initial)).sort()).toEqual([`${CAL}event1.ics`, `${CAL}event2.ics`]);
        const token = first(initial, 'DAV:', 'sync-token')!;
        const body = fixture('apple-calendar/12-report-sync-collection-calendar.xml');
        expect((await send('REPORT', CAL, body, {depth: '1'})).status).toBe(403);
        const delta = await send('REPORT', CAL, body.replace('http://example.com/ns/sync/1234', token), {depth: '1'});
        expect(delta.status).toBe(207);
        expect(Object.keys(props(delta))).toEqual([]);
    });

    it('calendar-multiget returns calendar-data', async () => {
        const send = server();
        const res = await send('REPORT', CAL, fixture('apple-calendar/13-report-calendar-multiget.xml'));
        const p = props(res);
        expect(p[`${CAL}event1.ics`]!['calendar-data']).toContain('UID:event1');
        expect(p[`${CAL}event2.ics`]!['calendar-data']).toContain('UID:event2');
    });

    it('free-busy via outbox POST', async () => {
        const send = server();
        const res = await send('POST', '/dav/outbox/user/', fixture('apple-calendar/15-post-outbox-freebusy.ics'), {
            'content-type': 'text/calendar',
            originator: 'mailto:user01@example.com',
            recipient: 'mailto:user01@example.com, mailto:user02@example.com',
        });
        expect(res.status).toBe(200);
        // user01 also sees the shared calendar
        expect(res.body!.match(/FREEBUSY;FBTYPE=BUSY:20250115T100000Z\/20250115T110000Z/g)).toHaveLength(2);
    });
});

describe('Apple Reminders', () => {
    it('sees the to-do list as a VTODO calendar', async () => {
        const send = server();
        const p = props(await send('PROPFIND', HOME, fixture('apple-reminders/05-propfind-calendar-home-depth1.xml'), {depth: '1'}));
        expect(p[TASKS]!['supported-calendar-component-set']).toBe('comp[VTODO]');
        const ctag = props(await send('PROPFIND', TASKS, fixture('apple-reminders/06-propfind-tasks-ctag.xml'), {depth: '0'}));
        expect(ctag[TASKS]!.getctag).toBeDefined();
    });

    it('calendar-query for VTODO and multiget', async () => {
        const send = server();
        const q = await send('REPORT', TASKS, fixture('apple-reminders/07-report-calendar-query-vtodo.xml'), {depth: '1'});
        expect(Object.keys(props(q)).sort()).toEqual([`${TASKS}task1.ics`, `${TASKS}task2.ics`]);
        expect(props(q)[`${TASKS}task1.ics`]!.getcontenttype).toBe('text/calendar; charset=utf-8; component=vtodo');
        const m = props(await send('REPORT', TASKS, fixture('apple-reminders/09-report-calendar-multiget-vtodo.xml')));
        expect(m[`${TASKS}task1.ics`]!['calendar-data']).toContain('SUMMARY:Open');
    });

    it('calendar-query with an open-ended time-range', async () => {
        const send = server();
        const res = await send('REPORT', CAL, fixture('apple-reminders/08-report-calendar-query-vevent-time-range.xml'), {depth: '1'});
        expect(Object.keys(props(res))).toEqual([`${CAL}event2.ics`]);
    });
});

describe('Thunderbird', () => {
    it('detects the collection and the scheduling URLs', async () => {
        const send = server();
        const detect = await send('PROPFIND', CAL, fixture('thunderbird/01-propfind-detect-collection.xml'), {depth: '0'});
        const d = props(detect)[CAL]!;
        expect(d.resourcetype).toBe('collection calendar');
        expect(d['current-user-principal']).toBe(`href(${PRINCIPAL})`);

        const pcs = props(await send('PROPFIND', HOME, fixture('thunderbird/10-propfind-calendar-home-principal-collection-set.xml'), {depth: '0'}));
        expect(pcs[HOME]!['principal-collection-set']).toBe('href(/dav/principals/)');

        const s = props(await send('PROPFIND', PRINCIPAL, fixture('thunderbird/11-propfind-principal-scheduling.xml'), {depth: '0'}))[PRINCIPAL]!;
        expect(s['schedule-outbox-URL']).toBe('href(/dav/outbox/user/)');

        const search = await send('REPORT', '/dav/principals/', fixture('thunderbird/12-report-principal-property-search.xml'), {depth: '1'});
        expect(Object.keys(props(search))).toEqual([PRINCIPAL]);
    });

    it('lists ETags with PROPFIND Depth 1 and fetches with multiget', async () => {
        const send = server();
        const list = props(await send('PROPFIND', CAL, fixture('thunderbird/06-propfind-calendar-depth1-etags.xml'), {depth: '1'}));
        expect(list[`${CAL}event1.ics`]!.getetag).toMatch(/^"/);
        const m = await send('REPORT', CAL, fixture('thunderbird/09-report-calendar-multiget.xml'), {depth: '1'});
        expect(Object.values(props(m)).some((p) => p['calendar-data']?.includes('BEGIN:VCALENDAR'))).toBe(true);
        expect(statuses(m)).toEqual({});
    });

    it('sync-collection with a token of this server', async () => {
        const send = server();
        const token = await syncToken(send, CAL);
        const res = await send('REPORT', CAL, fixture('thunderbird/08-report-sync-collection.xml').replace('http://example.com/ns/sync/1234', token), {
            depth: '1',
        });
        expect(res.status).toBe(207);
    });
});

describe('DAVx⁵', () => {
    it('discovers home and addresses', async () => {
        const send = server();
        const root = props(await send('PROPFIND', '/dav/', fixture('davx5/01-propfind-current-user-principal.xml'), {depth: '0'}));
        expect(root['/dav/']!['current-user-principal']).toBe(`href(${PRINCIPAL})`);
        const home = props(await send('PROPFIND', PRINCIPAL, fixture('davx5/03-propfind-principal-home-set.xml'), {depth: '0'}));
        expect(home[PRINCIPAL]!['calendar-home-set']).toBe(`href(${HOME})`);
        const addr = props(await send('PROPFIND', PRINCIPAL, fixture('davx5/04-propfind-principal-calendar-user-address-set.xml'), {depth: '0'}));
        expect(addr[PRINCIPAL]!['calendar-user-address-set']).toContain('mailto:user01@example.com');
    });

    it('reads collection capabilities', async () => {
        const send = server();
        const p = props(await send('PROPFIND', HOME, fixture('davx5/05-propfind-calendar-home-depth1.xml'), {depth: '1'}));
        expect(p[CAL]!['supported-calendar-component-set']).toBe('comp[VEVENT]');
        expect(p['/dav/calendars/user/shared/']!['current-user-privilege-set']).not.toContain('write');
        const caps = props(await send('PROPFIND', CAL, fixture('davx5/07-propfind-calendar-capabilities.xml'), {depth: '0'}))[CAL]!;
        expect(caps['supported-report-set']).toContain('sync-collection');
        const state = props(await send('PROPFIND', CAL, fixture('davx5/08-propfind-calendar-sync-state.xml'), {depth: '0'}))[CAL]!;
        expect(state['sync-token']).toMatch(/^http:\/\/caldav-provider-server\/ns\/sync\//);
    });

    it('sync-collection with Depth 0', async () => {
        const send = server();
        const initial = await send('REPORT', CAL, fixture('davx5/09-report-sync-collection-initial.xml'), {depth: '0'});
        expect(Object.keys(props(initial)).sort()).toEqual([`${CAL}event1.ics`, `${CAL}event2.ics`]);
        const token = first(initial, 'DAV:', 'sync-token')!;
        const delta = await send('REPORT', CAL, fixture('davx5/10-report-sync-collection.xml').replace('http://example.com/ns/sync/1234', token), {depth: '0'});
        expect(delta.status).toBe(207);
    });

    it('calendar-query for events and to-dos, then multiget', async () => {
        const send = server();
        const range = await send('REPORT', CAL, fixture('davx5/11-report-calendar-query-vevent-time-range.xml'), {depth: '1'});
        expect(Object.keys(props(range))).toEqual([`${CAL}event2.ics`]);
        const all = await send('REPORT', CAL, fixture('davx5/12-report-calendar-query-vevent.xml'), {depth: '1'});
        expect(Object.keys(props(all)).sort()).toEqual([`${CAL}event1.ics`, `${CAL}event2.ics`]);
        const todos = await send('REPORT', TASKS, fixture('davx5/13-report-calendar-query-vtodo.xml'), {depth: '1'});
        expect(Object.keys(props(todos)).sort()).toEqual([`${TASKS}task1.ics`, `${TASKS}task2.ics`]);

        const m = props(await send('REPORT', CAL, fixture('davx5/14-report-calendar-multiget.xml')));
        expect(m[`${CAL}event1.ics`]).toMatchObject({getcontenttype: 'text/calendar; charset=utf-8; component=vevent'});
        expect(m[`${CAL}event1.ics`]!['schedule-tag']).toBeDefined();
        expect(m[`${CAL}event2.ics`]!['calendar-data']).toContain('UID:event2');
    });
});
