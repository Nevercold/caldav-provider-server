import {describe, expect, it} from 'vitest';
import {createCalDavHandler} from '../src/index.ts';
import {ics, PROPFIND, props, setup, statuses, xml} from './helpers.ts';

const C = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

describe('discovery', () => {
    it('redirects /.well-known/caldav without authentication', async () => {
        const {request} = setup();
        const res = await request('PROPFIND', '/.well-known/caldav', {user: null});
        expect(res.status).toBe(301);
        expect(res.headers.Location).toBe('/dav/');
    });

    it('answers OPTIONS with the DAV header', async () => {
        const {request} = setup();
        const res = await request('OPTIONS', '/dav/', {user: null});
        expect(res.status).toBe(200);
        expect(res.headers.DAV).toBe('1, 3, calendar-access, calendar-auto-schedule');
        expect(res.headers.Allow).toContain('REPORT');
    });

    it('leaves calendar-auto-schedule out without a scheduling provider', async () => {
        const {request} = setup({scheduling: false});
        expect((await request('OPTIONS', '/dav/')).headers.DAV).toBe('1, 3, calendar-access');
    });

    it('asks for Basic credentials', async () => {
        const {request} = setup();
        const res = await request('PROPFIND', '/dav/', {user: null});
        expect(res.status).toBe(401);
        expect(res.headers['WWW-Authenticate']).toBe('Basic realm="CalDAV", charset="UTF-8"');
        const wrong = await request('PROPFIND', '/dav/', {headers: {authorization: `Basic ${btoa('alice:nope')}`}, user: null});
        expect(wrong.status).toBe(401);
    });

    it('finds the principal and its calendar home', async () => {
        const {request} = setup();
        const root = await request('PROPFIND', '/dav/', {headers: {depth: '0'}, body: PROPFIND('<d:current-user-principal/>')});
        expect(root.status).toBe(207);
        expect(props(root)['/dav/']!['current-user-principal']).toBe('href(/dav/principals/alice/)');

        const principal = await request('PROPFIND', '/dav/principals/alice/', {
            headers: {depth: '0'},
            body: PROPFIND(
                '<c:calendar-home-set/><c:calendar-user-address-set/><d:displayname/><c:schedule-inbox-URL/><c:schedule-outbox-URL/><cs:email-address-set/><d:resourcetype/>',
            ),
        });
        expect(props(principal)['/dav/principals/alice/']).toEqual({
            'calendar-home-set': 'href(/dav/calendars/alice/)',
            'calendar-user-address-set': 'href(mailto:alice@example.com) href(/dav/principals/alice/)',
            displayname: 'Alice',
            'schedule-inbox-URL': 'href(/dav/inbox/alice/)',
            'schedule-outbox-URL': 'href(/dav/outbox/alice/)',
            'email-address-set': 'email-address(alice@example.com)',
            resourcetype: 'collection principal',
        });
    });

    it('lists calendars with their properties (Depth 1)', async () => {
        const {request} = setup();
        const res = await request('PROPFIND', '/dav/calendars/alice/', {
            headers: {depth: '1'},
            body: PROPFIND(
                '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><cs:getctag/><d:sync-token/><a:calendar-color/><a:calendar-order/><c:calendar-description/>',
            ),
        });
        const p = props(res);
        expect(Object.keys(p)).toEqual([
            '/dav/calendars/alice/',
            '/dav/calendars/alice/personal/',
            '/dav/calendars/alice/team/',
            '/dav/calendars/alice/todos/',
        ]);
        expect(p['/dav/calendars/alice/personal/']).toEqual({
            displayname: 'Personal',
            resourcetype: 'collection calendar',
            'supported-calendar-component-set': 'comp[VEVENT]',
            getctag: '0',
            'sync-token': 'http://caldav-provider-server/ns/sync/0',
            'calendar-color': '#FF0000FF',
            'calendar-order': '1',
        });
        expect(p['/dav/calendars/alice/todos/']!['supported-calendar-component-set']).toBe('comp[VTODO]');
        expect(p['/dav/calendars/alice/team/']!['calendar-description']).toBe('Shared');
    });

    it('reports unknown properties as 404 with their namespace', async () => {
        const {request} = setup();
        const res = await request('PROPFIND', '/dav/calendars/alice/personal/', {
            headers: {depth: '0'},
            body: '<d:propfind xmlns:d="DAV:" xmlns:x="urn:example"><d:prop><x:unknown/><d:displayname/></d:prop></d:propfind>',
        });
        expect(res.body).toContain('<x0:unknown/>');
        expect(res.body).toContain('xmlns:x0="urn:example"');
        expect(res.body).toContain('HTTP/1.1 404 Not Found');
    });

    it('reports read and write privileges per calendar', async () => {
        const {request} = setup();
        const body = PROPFIND('<d:current-user-privilege-set/>');
        const bob = props(await request('PROPFIND', '/dav/calendars/bob/', {user: 'bob', headers: {depth: '1'}, body}));
        expect(bob['/dav/calendars/bob/team/']!['current-user-privilege-set']).toBe(
            'privilege(read) privilege(read-current-user-privilege-set) privilege(read-free-busy)',
        );
        expect(bob['/dav/calendars/bob/todos/']!['current-user-privilege-set']).toContain('privilege(write)');
    });

    it('answers allprop without calendar-data', async () => {
        const {request} = setup();
        await request('PUT', '/dav/calendars/alice/team/x.ics', {body: ics('VEVENT', 'x', 'DTSTART:20260101T100000Z')});
        const res = await request('PROPFIND', '/dav/calendars/alice/team/', {headers: {depth: '1'}});
        expect(res.status).toBe(207);
        const p = props(res);
        expect(p['/dav/calendars/alice/team/']!.displayname).toBe('Team');
        expect(p['/dav/calendars/alice/team/x.ics']!.getetag).toBeDefined();
        expect(res.body).not.toContain('BEGIN:VCALENDAR');
    });

    it('rejects Depth: infinity and other users', async () => {
        const {request} = setup();
        const inf = await request('PROPFIND', '/dav/calendars/alice/', {headers: {depth: 'infinity'}});
        expect(inf.status).toBe(403);
        expect(inf.body).toContain('propfind-finite-depth');
        expect((await request('PROPFIND', '/dav/calendars/bob/', {headers: {depth: '0'}})).status).toBe(403);
        expect((await request('PROPFIND', '/dav/calendars/alice/nope/', {headers: {depth: '0'}})).status).toBe(404);
    });

    it('answers PROPPATCH with 403 per property', async () => {
        const {request} = setup();
        const res = await request('PROPPATCH', '/dav/calendars/alice/personal/', {
            body: '<d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><a:calendar-color>#000000</a:calendar-color></d:prop></d:set></d:propertyupdate>',
        });
        expect(res.status).toBe(207);
        expect(res.body).toContain('<ical:calendar-color/>');
        expect(res.body).toContain('403 Forbidden');
    });

    it('rejects broken XML with 400', async () => {
        const {request} = setup();
        expect((await request('PROPFIND', '/dav/', {body: '<d:propfind xmlns:d="DAV:"><d:prop>'})).status).toBe(400);
    });
});

describe('objects', () => {
    const url = '/dav/calendars/alice/personal/e1.ics';
    const event = ics('VEVENT', 'e1', 'DTSTART:20260310T100000Z', 'DTEND:20260310T110000Z', 'SUMMARY:One');

    it('creates, reads, updates and deletes', async () => {
        const {request} = setup();
        const created = await request('PUT', url, {body: event, headers: {'content-type': 'text/calendar', 'if-none-match': '*'}});
        expect(created.status).toBe(201);
        expect(created.headers.ETag).toBeDefined();

        const got = await request('GET', url);
        expect(got.status).toBe(200);
        expect(got.body).toBe(event);
        expect(got.headers.ETag).toBe(created.headers.ETag);
        expect(got.headers['Content-Type']).toBe('text/calendar; charset=utf-8');

        const conflict = await request('PUT', url, {body: event, headers: {'if-none-match': '*'}});
        expect(conflict.status).toBe(412);
        const stale = await request('PUT', url, {body: event, headers: {'if-match': '"nope"'}});
        expect(stale.status).toBe(412);
        const updated = await request('PUT', url, {body: event.replace('One', 'Two'), headers: {'if-match': created.headers.ETag!}});
        expect(updated.status).toBe(204);

        expect((await request('DELETE', url, {headers: {'if-match': created.headers.ETag!}})).status).toBe(412);
        expect((await request('DELETE', url, {headers: {'if-match': updated.headers.ETag!}})).status).toBe(204);
        expect((await request('GET', url)).status).toBe(404);
        expect((await request('DELETE', url)).status).toBe(404);
    });

    it('omits the ETag when the provider does not store the data as is', async () => {
        const {provider, request} = setup();
        const put = provider.putObject.bind(provider);
        provider.putObject = async (...args) => ({...(await put(...args)), storedAsIs: false});
        const res = await request('PUT', url, {body: event});
        expect(res.status).toBe(201);
        expect(res.headers.ETag).toBeUndefined();
    });

    it('refuses writes to read-only calendars', async () => {
        const {request} = setup();
        const res = await request('PUT', '/dav/calendars/bob/team/x.ics', {user: 'bob', body: event});
        expect(res.status).toBe(403);
        expect(res.body).toContain('need-privileges');
    });

    it('refuses writes without putObject', async () => {
        const {provider} = setup();
        const handle = createCalDavHandler({provider: {...provider, authenticate: provider.authenticate.bind(provider), listCalendars: provider.listCalendars.bind(provider), getObject: provider.getObject.bind(provider), listObjects: provider.listObjects.bind(provider), putObject: undefined}});
        const res = await handle({method: 'PUT', url, headers: {authorization: `Basic ${btoa('alice:pw')}`}, body: event});
        expect(res.status).toBe(403);
    });

    it('validates the calendar data', async () => {
        const {request} = setup();
        const bad = await request('PUT', url, {body: 'nonsense'});
        expect(bad.status).toBe(400);
        expect(bad.body).toContain('valid-calendar-data');

        const todo = await request('PUT', url, {body: ics('VTODO', 't1', 'SUMMARY:x')});
        expect(todo.status).toBe(403);
        expect(todo.body).toContain('supported-calendar-component');

        const twoUids = event.replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:other\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
        const res = await request('PUT', url, {body: twoUids});
        expect(res.status).toBe(400);
        expect(res.body).toContain('valid-calendar-object-resource');

        expect((await request('PUT', url, {body: event, headers: {'content-type': 'application/json'}})).status).toBe(415);
    });

    it('lists objects with ETags (Depth 1)', async () => {
        const {request} = setup();
        await request('PUT', url, {body: event});
        const res = await request('PROPFIND', '/dav/calendars/alice/personal/', {
            headers: {depth: '1'},
            body: PROPFIND('<d:getetag/><d:getcontenttype/><d:resourcetype/>'),
        });
        const p = props(res)[url]!;
        expect(p.getetag).toMatch(/^"v\d+"$/);
        expect(p.getcontenttype).toBe('text/calendar; charset=utf-8; component=vevent');
        expect(p.resourcetype).toBe('');
    });

    it('encodes and decodes object names', async () => {
        const {request} = setup();
        const odd = '/dav/calendars/alice/personal/a%20b%40c.ics';
        expect((await request('PUT', odd, {body: event})).status).toBe(201);
        const res = await request('PROPFIND', '/dav/calendars/alice/personal/', {headers: {depth: '1'}, body: PROPFIND('<d:getetag/>')});
        expect(Object.keys(props(res))).toContain(odd);
        expect((await request('GET', odd)).status).toBe(200);
    });
});

describe('REPORT', () => {
    async function seeded() {
        const s = setup();
        await s.request('PUT', '/dav/calendars/alice/personal/a.ics', {body: ics('VEVENT', 'a', 'DTSTART:20260310T100000Z', 'DTEND:20260310T110000Z')});
        await s.request('PUT', '/dav/calendars/alice/personal/b.ics', {body: ics('VEVENT', 'b', 'DTSTART:20260410T100000Z', 'DTEND:20260410T110000Z')});
        await s.request('PUT', '/dav/calendars/alice/todos/t.ics', {body: ics('VTODO', 't', 'SUMMARY:open', 'STATUS:NEEDS-ACTION')});
        await s.request('PUT', '/dav/calendars/alice/todos/u.ics', {body: ics('VTODO', 'u', 'SUMMARY:done', 'STATUS:COMPLETED', 'COMPLETED:20260101T000000Z')});
        return s;
    }

    it('calendar-query with time-range', async () => {
        const {request} = await seeded();
        const res = await request('REPORT', '/dav/calendars/alice/personal/', {
            headers: {depth: '1'},
            body: `<c:calendar-query ${C}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20260301T000000Z" end="20260401T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
        });
        expect(res.status).toBe(207);
        const p = props(res);
        expect(Object.keys(p)).toEqual(['/dav/calendars/alice/personal/a.ics']);
        expect(p['/dav/calendars/alice/personal/a.ics']!['calendar-data']).toContain('UID:a');
    });

    it('calendar-query for open to-dos', async () => {
        const {request} = await seeded();
        const res = await request('REPORT', '/dav/calendars/alice/todos/', {
            headers: {depth: '1'},
            body: `<c:calendar-query ${C}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"><c:prop-filter name="COMPLETED"><c:is-not-defined/></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
        });
        expect(Object.keys(props(res))).toEqual(['/dav/calendars/alice/todos/t.ics']);
    });

    it('calendar-query rejects invalid filters', async () => {
        const {request} = await seeded();
        const res = await request('REPORT', '/dav/calendars/alice/todos/', {
            body: `<c:calendar-query ${C}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VTODO"/></c:filter></c:calendar-query>`,
        });
        expect(res.status).toBe(403);
        expect(res.body).toContain('valid-filter');
    });

    it('calendar-multiget with absolute and relative hrefs', async () => {
        const {request} = await seeded();
        const res = await request('REPORT', '/dav/calendars/alice/personal/', {
            headers: {depth: '1'},
            body: `<c:calendar-multiget ${C}><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>/dav/calendars/alice/personal/a.ics</d:href><d:href>https://example.com/dav/calendars/alice/personal/b.ics</d:href><d:href>/dav/calendars/alice/personal/missing.ics</d:href><d:href>/dav/calendars/alice/todos/t.ics</d:href></c:calendar-multiget>`,
        });
        const p = props(res);
        expect(p['/dav/calendars/alice/personal/a.ics']!['calendar-data']).toContain('UID:a');
        expect(p['/dav/calendars/alice/personal/b.ics']!['calendar-data']).toContain('UID:b');
        expect(statuses(res)).toEqual({
            '/dav/calendars/alice/personal/missing.ics': 'HTTP/1.1 404 Not Found',
            '/dav/calendars/alice/todos/t.ics': 'HTTP/1.1 404 Not Found',
        });
    });

    it('sync-collection: initial, incremental, deletions, invalid token', async () => {
        const {request} = await seeded();
        const sync = (token: string) =>
            request('REPORT', '/dav/calendars/alice/personal/', {
                headers: {depth: '0'},
                body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
            });
        const initial = await sync('');
        expect(Object.keys(props(initial)).sort()).toEqual(['/dav/calendars/alice/personal/a.ics', '/dav/calendars/alice/personal/b.ics']);
        const token = xml(initial).getElementsByTagNameNS('DAV:', 'sync-token')[0]!.textContent!;
        expect(token).toMatch(/^http:\/\/caldav-provider-server\/ns\/sync\//);

        expect(Object.keys(props(await sync(token)))).toEqual([]);

        await request('DELETE', '/dav/calendars/alice/personal/a.ics');
        await request('PUT', '/dav/calendars/alice/personal/c.ics', {body: ics('VEVENT', 'c', 'DTSTART:20260101T000000Z')});
        const delta = await sync(token);
        expect(Object.keys(props(delta))).toContain('/dav/calendars/alice/personal/c.ics');
        expect(statuses(delta)).toEqual({'/dav/calendars/alice/personal/a.ics': 'HTTP/1.1 404 Not Found'});

        const invalid = await sync('http://other/token');
        expect(invalid.status).toBe(403);
        expect(invalid.body).toContain('valid-sync-token');
    });

    it('rejects unsupported reports', async () => {
        const {request} = await seeded();
        const res = await request('REPORT', '/dav/calendars/alice/personal/', {body: '<c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav"/>'});
        expect(res.status).toBe(403);
        expect(res.body).toContain('supported-report');
    });

    it('expand-property on the principal', async () => {
        const {request} = await seeded();
        const res = await request('REPORT', '/dav/principals/alice/', {
            headers: {depth: '0'},
            body: '<A:expand-property xmlns:A="DAV:"><A:property name="calendar-proxy-write-for" namespace="http://calendarserver.org/ns/"><A:property name="displayname" namespace="DAV:"/></A:property><A:property name="displayname" namespace="DAV:"/></A:expand-property>',
        });
        expect(res.status).toBe(207);
        expect(props(res)['/dav/principals/alice/']).toEqual({displayname: 'Alice'});
    });
});
