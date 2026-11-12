import {describe, expect, it} from 'vitest';
import {ics, PROPFIND, props, propStatuses, setup} from './helpers.ts';

const BOB_HOME = '/dav/calendars/bob/';
const BOBCAL = '/dav/calendars/bob/bobcal/';

describe('delegation', () => {
    it('lists the owners on the user principal, with expand-property as Apple asks', async () => {
        const {request, provider} = setup();
        provider.addDelegate('bob', 'alice', true);
        const p = props(
            await request('PROPFIND', '/dav/principals/alice/', {
                headers: {depth: '0'},
                body: PROPFIND('<cs:calendar-proxy-write-for/><cs:calendar-proxy-read-for/><d:group-membership/>'),
            }),
        )['/dav/principals/alice/']!;
        expect(p['calendar-proxy-write-for']).toBe('href(/dav/principals/bob/)');
        expect(p['calendar-proxy-read-for']).toBe('');
        expect(p['group-membership']).toBe('href(/dav/principals/bob/calendar-proxy-write/)');

        const res = await request('REPORT', '/dav/principals/alice/', {
            body: `<A:expand-property xmlns:A="DAV:">
  <A:property name="calendar-proxy-write-for" namespace="http://calendarserver.org/ns/">
    <A:property name="calendar-user-address-set" namespace="urn:ietf:params:xml:ns:caldav"/>
    <A:property name="displayname" namespace="DAV:"/>
  </A:property>
</A:expand-property>`,
        });
        expect(res.status).toBe(207);
        expect(res.body).toContain(
            '<cs:calendar-proxy-write-for><d:response><d:href>/dav/principals/bob/</d:href><d:propstat><d:prop><cal:calendar-user-address-set><d:href>mailto:bob@example.com</d:href>',
        );
        expect(res.body).toContain('<d:displayname>Bob</d:displayname>');
    });

    it('a write delegate works in the owner calendars as the owner', async () => {
        const {request, provider} = setup();
        provider.addDelegate('bob', 'alice', true);
        const principal = props(
            await request('PROPFIND', '/dav/principals/bob/', {
                headers: {depth: '0'},
                body: PROPFIND('<c:calendar-home-set/><d:current-user-principal/><d:principal-URL/>'),
            }),
        )['/dav/principals/bob/']!;
        expect(principal).toEqual({
            'calendar-home-set': `href(${BOB_HOME})`,
            'current-user-principal': 'href(/dav/principals/alice/)',
            'principal-URL': 'href(/dav/principals/bob/)',
        });
        const home = props(await request('PROPFIND', BOB_HOME, {headers: {depth: '1'}, body: PROPFIND('<d:displayname/>')}));
        expect(Object.keys(home)).toContain(BOBCAL);

        expect((await request('PUT', `${BOBCAL}x.ics`, {body: ics('VEVENT', 'x', 'DTSTART:20260601T100000Z')})).status).toBe(201);
        expect((await request('GET', `${BOBCAL}x.ics`, {user: 'bob'})).status).toBe(200);
        // Bob's read-only access to the team calendar stays read-only for his delegate.
        expect((await request('PUT', '/dav/calendars/bob/team/y.ics', {body: ics('VEVENT', 'y', 'DTSTART:20260601T100000Z')})).status).toBe(403);
    });

    it('a read delegate can only read', async () => {
        const {request, provider} = setup();
        provider.seed('bobcal', 'a.ics', ics('VEVENT', 'a', 'DTSTART:20260601T100000Z'));
        provider.addDelegate('bob', 'alice', false);
        expect((await request('GET', `${BOBCAL}a.ics`)).status).toBe(200);
        expect((await request('PUT', `${BOBCAL}x.ics`, {body: ics('VEVENT', 'x', 'DTSTART:20260601T100000Z')})).status).toBe(403);
        expect((await request('DELETE', `${BOBCAL}a.ics`)).status).toBe(403);
        expect((await request('MKCALENDAR', `${BOB_HOME}new/`)).status).toBe(403);
        const privileges = props(await request('PROPFIND', BOBCAL, {headers: {depth: '0'}, body: PROPFIND('<d:current-user-privilege-set/>')}))[BOBCAL]!;
        expect(privileges['current-user-privilege-set']).not.toContain('write');
        const outbox = await request('POST', '/dav/outbox/bob/', {body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', headers: {'content-type': 'text/calendar'}});
        expect(outbox.status).toBe(403);
    });

    it('other users stay out', async () => {
        const {request, provider} = setup();
        provider.addDelegate('bob', 'alice', true);
        expect((await request('PROPFIND', '/dav/calendars/alice/', {user: 'bob', headers: {depth: '0'}})).status).toBe(403);
        Object.assign(provider, {delegations: undefined});
        expect((await request('PROPFIND', BOB_HOME, {headers: {depth: '0'}})).status).toBe(403);
    });

    it('shows and changes the delegates in the proxy groups', async () => {
        const {request, provider} = setup();
        provider.addDelegate('alice', 'bob', false);
        const groups = props(
            await request('PROPFIND', '/dav/principals/alice/', {headers: {depth: '1'}, body: PROPFIND('<d:resourcetype/><d:group-member-set/>')}),
        );
        expect(groups['/dav/principals/alice/calendar-proxy-read/']).toEqual({
            resourcetype: 'principal calendar-proxy-read',
            'group-member-set': 'href(/dav/principals/bob/)',
        });
        expect(groups['/dav/principals/alice/calendar-proxy-write/']!['group-member-set']).toBe('');

        const patch = await request('PROPPATCH', '/dav/principals/alice/calendar-proxy-write/', {
            body: '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:group-member-set><d:href>/dav/principals/bob/</d:href></d:group-member-set></d:prop></d:set></d:propertyupdate>',
        });
        expect(propStatuses(patch)).toEqual({'group-member-set': 200});
        expect(await provider.delegates({id: 'alice', username: 'alice', password: 'pw'})).toEqual([
            {id: 'bob', displayName: 'Bob', addresses: ['mailto:bob@example.com'], write: true},
        ]);
        expect((await request('PROPFIND', '/dav/calendars/alice/', {user: 'bob', headers: {depth: '0'}})).status).toBe(207);

        const bad = await request('PROPPATCH', '/dav/principals/alice/calendar-proxy-write/', {
            body: '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:group-member-set><d:href>/dav/calendars/bob/</d:href></d:group-member-set></d:prop></d:set></d:propertyupdate>',
        });
        expect(propStatuses(bad)).toEqual({'group-member-set': 409});
        // A delegate can't change the owner's delegates.
        const asBob = await request('PROPPATCH', '/dav/principals/alice/calendar-proxy-write/', {
            user: 'bob',
            body: '<d:propertyupdate xmlns:d="DAV:"><d:remove><d:prop><d:group-member-set/></d:prop></d:remove></d:propertyupdate>',
        });
        expect(propStatuses(asBob)).toEqual({'group-member-set': 403});
    });
});
