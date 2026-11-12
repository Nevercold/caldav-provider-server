import {describe, expect, it} from 'vitest';
import {CalDavError} from '../src/index.ts';
import {ics, PROPFIND, props, propStatuses, setup, xml} from './helpers.ts';

const CAL = '/dav/calendars/alice/personal/';
const HOME = '/dav/calendars/alice/';

const update = (ops: string) =>
    `<d:propertyupdate xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" xmlns:x="urn:x">${ops}</d:propertyupdate>`;
const set = (p: string) => `<d:set><d:prop>${p}</d:prop></d:set>`;
const remove = (p: string) => `<d:remove><d:prop>${p}</d:prop></d:remove>`;

const mkcalendar = (p: string) =>
    `<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop>${p}</d:prop></d:set></c:mkcalendar>`;
const mkcol = (p: string) =>
    `<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop>${p}</d:prop></d:set></d:mkcol>`;

describe('PROPPATCH', () => {
    it('changes several properties at once and removes with null', async () => {
        const {request, provider} = setup();
        const calls: unknown[] = [];
        const original = provider.updateCalendar.bind(provider);
        provider.updateCalendar = async (p, c, changes) => {
            calls.push(changes);
            return original(p, c, changes);
        };
        const res = await request(
            'PROPPATCH',
            CAL,
            {body: update(set('<d:displayname>Work</d:displayname><a:calendar-order>5</a:calendar-order>') + remove('<a:calendar-color/>'))},
        );
        expect(res.status).toBe(207);
        expect(propStatuses(res)).toEqual({displayname: 200, 'calendar-order': 200, 'calendar-color': 200});
        expect(calls).toEqual([{displayName: 'Work', order: 5, color: null}]);
        const p = props(await request('PROPFIND', CAL, {body: PROPFIND('<d:displayname/><a:calendar-color/>'), headers: {depth: '0'}}))[CAL]!;
        expect(p).toEqual({displayname: 'Work'});
    });

    it('is atomic: one failing property fails all with 424', async () => {
        const {request, provider} = setup();
        let called = false;
        provider.updateCalendar = async () => {
            called = true;
        };
        const res = await request('PROPPATCH', CAL, {body: update(set('<d:displayname>Work</d:displayname><d:getetag>"1"</d:getetag>'))});
        expect(propStatuses(res)).toEqual({displayname: 424, getetag: 403});
        expect(called).toBe(false);
    });

    it('answers 409 for invalid values', async () => {
        const {request} = setup();
        const res = await request('PROPPATCH', CAL, {body: update(set('<a:calendar-color>red</a:calendar-color><a:calendar-order>x</a:calendar-order>'))});
        expect(propStatuses(res)).toEqual({'calendar-color': 409, 'calendar-order': 409});
    });

    it('passes a provider rejection to every property', async () => {
        const {request, provider} = setup();
        provider.updateCalendar = async () => {
            throw CalDavError.forbidden('not the owner');
        };
        const res = await request('PROPPATCH', CAL, {body: update(set('<d:displayname>X</d:displayname><c:calendar-description>Y</c:calendar-description>'))});
        expect(propStatuses(res)).toEqual({displayname: 403, 'calendar-description': 403});
    });

    it('answers 403 for read-only calendars and other resources', async () => {
        const {request} = setup();
        const team = await request('PROPPATCH', '/dav/calendars/bob/team/', {user: 'bob', body: update(set('<d:displayname>X</d:displayname>'))});
        expect(propStatuses(team)).toEqual({displayname: 403});
        const home = await request('PROPPATCH', HOME, {body: update(set('<d:displayname>X</d:displayname>'))});
        expect(propStatuses(home)).toEqual({displayname: 403});
    });

    it('advertises write-properties and bind/unbind on the home', async () => {
        const {request} = setup();
        const cal = props(await request('PROPFIND', CAL, {body: PROPFIND('<d:current-user-privilege-set/>'), headers: {depth: '0'}}))[CAL]!;
        expect(cal['current-user-privilege-set']).toContain('privilege(write-properties)');
        const home = props(await request('PROPFIND', HOME, {body: PROPFIND('<d:current-user-privilege-set/>'), headers: {depth: '0'}}))[HOME]!;
        expect(home['current-user-privilege-set']).toContain('privilege(bind) privilege(unbind)');
        const team = props(
            await request('PROPFIND', '/dav/calendars/bob/team/', {user: 'bob', body: PROPFIND('<d:current-user-privilege-set/>'), headers: {depth: '0'}}),
        )['/dav/calendars/bob/team/']!;
        expect(team['current-user-privilege-set']).not.toContain('write-properties');
    });
});

describe('MKCALENDAR and extended MKCOL', () => {
    it('creates a calendar with the client-chosen id', async () => {
        const {request, provider} = setup();
        const created: unknown[] = [];
        const original = provider.createCalendar.bind(provider);
        provider.createCalendar = async (p, id, input) => {
            created.push({id, input});
            return original(p, id, input);
        };
        const res = await request('MKCALENDAR', `${HOME}new%20one/`, {
            body: mkcalendar(
                '<d:displayname>New</d:displayname><a:calendar-color>#00FF00</a:calendar-color><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set><c:schedule-calendar-transp><c:opaque/></c:schedule-calendar-transp>',
            ),
        });
        expect(res.status).toBe(201);
        expect(res.headers.Location).toBe(`${HOME}new%20one/`);
        expect(created).toEqual([{id: 'new one', input: {displayName: 'New', color: '#00FF00', components: ['VTODO'], transparent: false}}]);
    });

    it('works without a body and defaults name and components', async () => {
        const {request, provider} = setup();
        expect((await request('MKCALENDAR', `${HOME}plain/`)).status).toBe(201);
        const calendars = await provider.listCalendars({id: 'alice', username: 'alice', password: 'pw'});
        expect(calendars.find((c) => c.id === 'plain')).toMatchObject({displayName: 'plain', components: ['VEVENT', 'VTODO']});
    });

    it('extended MKCOL needs the calendar resource type', async () => {
        const {request} = setup();
        const ok = await request('MKCOL', `${HOME}ext/`, {
            body: mkcol('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Ext</d:displayname>'),
        });
        expect(ok.status).toBe(201);
        const plain = await request('MKCOL', `${HOME}folder/`, {body: mkcol('<d:resourcetype><d:collection/></d:resourcetype>')});
        expect(plain.status).toBe(403);
        expect(plain.body).toContain('valid-resourcetype');
        expect((await request('MKCOL', `${HOME}folder/`)).status).toBe(403);
    });

    it('fails as a whole if a property cannot be set', async () => {
        const {request, provider} = setup();
        const res = await request('MKCALENDAR', `${HOME}bad/`, {
            body: mkcalendar('<d:displayname>Bad</d:displayname><c:supported-calendar-component-set><c:comp name="VJOURNAL"/></c:supported-calendar-component-set>'),
        });
        expect(res.status).toBe(403);
        expect(xml(res).localName).toBe('mkcalendar-response');
        expect(propStatuses(res)).toEqual({displayname: 424, 'supported-calendar-component-set': 403});
        const calendars = await provider.listCalendars({id: 'alice', username: 'alice', password: 'pw'});
        expect(calendars.some((c) => c.id === 'bad')).toBe(false);

        const col = await request('MKCOL', `${HOME}bad/`, {
            body: mkcol('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><a:calendar-color>blue</a:calendar-color>'),
        });
        expect(col.status).toBe(403);
        expect(xml(col).localName).toBe('mkcol-response');
        expect(propStatuses(col)).toEqual({resourcetype: 424, 'calendar-color': 409});
    });

    it('rejects existing ids, wrong places and other principals', async () => {
        const {request} = setup();
        const exists = await request('MKCALENDAR', CAL);
        expect(exists.status).toBe(405);
        expect(exists.body).toContain('resource-must-be-null');
        expect((await request('MKCALENDAR', HOME)).status).toBe(403);
        expect((await request('MKCALENDAR', `${CAL}nested/`)).status).toBe(403);
        expect((await request('MKCALENDAR', '/dav/calendars/bob/x/')).status).toBe(403);
    });

    it('passes provider errors through', async () => {
        const {request, provider} = setup();
        provider.createCalendar = async () => {
            throw new CalDavError(507, 'too many calendars');
        };
        expect((await request('MKCALENDAR', `${HOME}x/`)).status).toBe(507);
    });

    it('shows up in the home sync-collection', async () => {
        const {request} = setup();
        const sync = (token: string) =>
            request('REPORT', HOME, {
                headers: {depth: '1'},
                body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:prop><d:displayname/></d:prop></d:sync-collection>`,
            });
        const initial = await sync('');
        const token = xml(initial).getElementsByTagNameNS('DAV:', 'sync-token')[0]!.textContent!;
        await request('MKCALENDAR', `${HOME}fresh/`, {body: mkcalendar('<d:displayname>Fresh</d:displayname>')});
        expect(Object.keys(props(await sync(token)))).toEqual([`${HOME}fresh/`]);
    });
});

describe('DELETE of a calendar', () => {
    it('deletes through deleteCalendar', async () => {
        const {request} = setup();
        expect((await request('DELETE', CAL)).status).toBe(204);
        expect((await request('PROPFIND', CAL, {headers: {depth: '0'}})).status).toBe(404);
    });

    it('answers 403 for read-only calendars', async () => {
        const {request} = setup();
        expect((await request('DELETE', '/dav/calendars/bob/team/', {user: 'bob'})).status).toBe(403);
    });
});

describe('MOVE and COPY of calendars', () => {
    it('renames a calendar with MOVE', async () => {
        const {request} = setup();
        await request('PUT', `${CAL}a.ics`, {body: ics('VEVENT', 'a', 'DTSTART:20260601T100000Z')});
        const res = await request('MOVE', CAL, {headers: {destination: `https://cal.example.com${HOME}work/`}});
        expect(res.status).toBe(201);
        expect(res.headers.Location).toBe(`${HOME}work/`);
        expect((await request('GET', `${HOME}work/a.ics`)).status).toBe(200);
        expect((await request('PROPFIND', CAL, {headers: {depth: '0'}})).status).toBe(404);
    });

    it('duplicates a calendar with COPY', async () => {
        const {request} = setup();
        await request('PUT', `${CAL}a.ics`, {body: ics('VEVENT', 'a', 'DTSTART:20260601T100000Z')});
        expect((await request('COPY', CAL, {headers: {destination: `${HOME}copy/`}})).status).toBe(201);
        expect((await request('GET', `${HOME}copy/a.ics`)).status).toBe(200);
        expect((await request('GET', `${CAL}a.ics`)).status).toBe(200);
    });

    it('keeps the rules', async () => {
        const {request, provider} = setup();
        expect((await request('MOVE', CAL, {headers: {destination: `${HOME}todos/`, overwrite: 'F'}})).status).toBe(412);
        expect((await request('MOVE', CAL, {headers: {destination: `${HOME}todos/`}})).status).toBe(403);
        expect((await request('MOVE', CAL, {headers: {destination: '/dav/calendars/bob/x/'}})).status).toBe(403);
        expect((await request('MOVE', CAL, {headers: {destination: `${HOME}x/y/`}})).status).toBe(403);
        expect((await request('MOVE', '/dav/calendars/bob/team/', {user: 'bob', headers: {destination: '/dav/calendars/bob/t2/'}})).status).toBe(403);
        // A read-only calendar can still be copied.
        expect((await request('COPY', '/dav/calendars/bob/team/', {user: 'bob', headers: {destination: '/dav/calendars/bob/t2/'}})).status).toBe(201);
        Object.assign(provider, {moveCalendar: undefined, copyCalendar: undefined});
        expect((await request('MOVE', CAL, {headers: {destination: `${HOME}x/`}})).status).toBe(403);
        expect((await request('COPY', CAL, {headers: {destination: `${HOME}x/`}})).status).toBe(403);
    });
});

describe('without the hooks', () => {
    it('answers 403 for MKCALENDAR, MKCOL and DELETE of calendars', async () => {
        const {request} = setup({calendarHooks: false});
        expect((await request('MKCALENDAR', `${HOME}x/`)).status).toBe(403);
        expect((await request('MKCOL', `${HOME}x/`, {body: mkcol('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>')})).status).toBe(403);
        expect((await request('DELETE', CAL)).status).toBe(403);
        const home = props(await request('PROPFIND', HOME, {body: PROPFIND('<d:current-user-privilege-set/>'), headers: {depth: '0'}}))[HOME]!;
        expect(home['current-user-privilege-set']).not.toContain('bind');
    });
});
