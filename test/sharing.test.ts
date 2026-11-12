import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {ics, PROPFIND, props, setup, xml} from './helpers.ts';

const fixture = (file: string) => readFileSync(join(import.meta.dirname, 'fixtures', file), 'utf8');
const CAL = '/dav/calendars/alice/personal/';
const CS = 'xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"';

const share = (ops: string) => `<?xml version="1.0" encoding="UTF-8"?><cs:share ${CS}>${ops}</cs:share>`;
const invite = share(
    '<cs:set><d:href>mailto:bob@example.com</d:href><cs:common-name>Bob</cs:common-name><cs:summary>Our plans</cs:summary><cs:read-write/></cs:set>',
);

async function invitationId(request: ReturnType<typeof setup>['request']): Promise<string> {
    const list = await request('PROPFIND', '/dav/notifications/bob/', {
        user: 'bob',
        headers: {depth: '1'},
        body: fixture('apple-calendar/23-propfind-notifications-depth1.xml'),
    });
    const href = Object.keys(props(list)).find((h) => h.endsWith('.xml'))!;
    return decodeURIComponent(href.split('/').at(-1)!.replace(/\.xml$/, ''));
}

describe('sharing', () => {
    it('the owner shares a calendar and sees the sharees', async () => {
        const {request} = setup();
        const res = await request('POST', CAL, {body: invite, headers: {'content-type': 'application/xml'}});
        expect(res.status).toBe(200);
        const p = props(
            await request('PROPFIND', CAL, {headers: {depth: '0'}, body: PROPFIND('<d:resourcetype/><cs:invite/><cs:allowed-sharing-modes/>')}),
        )[CAL]!;
        expect(p.resourcetype).toBe('collection calendar shared-owner');
        expect(p.invite).toBe(
            'organizer(href(/dav/principals/alice/) common-name(Alice)) user(href(mailto:bob@example.com) common-name(Bob) invite-noresponse access(read-write))',
        );
        expect(p['allowed-sharing-modes']).toBe('can-be-shared');
    });

    it('the sharee gets a notification, accepts it as Apple does and uses the calendar', async () => {
        const {request} = setup();
        await request('POST', CAL, {body: invite});
        const principal = props(await request('PROPFIND', '/dav/principals/bob/', {user: 'bob', headers: {depth: '0'}, body: PROPFIND('<cs:notification-URL/>')}));
        expect(principal['/dav/principals/bob/']!['notification-URL']).toBe('href(/dav/notifications/bob/)');

        const id = await invitationId(request);
        const list = props(
            await request('PROPFIND', '/dav/notifications/bob/', {user: 'bob', headers: {depth: '1'}, body: fixture('apple-calendar/23-propfind-notifications-depth1.xml')}),
        );
        expect(list[`/dav/notifications/bob/${id}.xml`]!.notificationtype).toBe('invite-notification');

        const note = await request('GET', `/dav/notifications/bob/${id}.xml`, {user: 'bob'});
        expect(note.status).toBe(200);
        const n = xml(note);
        const text = (name: string) => n.getElementsByTagNameNS('http://calendarserver.org/ns/', name)[0]?.textContent;
        expect(text('uid')).toBe(id);
        expect(text('hosturl')).toBe(CAL);
        expect(text('organizer')).toContain('mailto:alice@example.com');
        expect(text('summary')).toBe('Our plans');
        expect(n.getElementsByTagNameNS('http://calendarserver.org/ns/', 'invite-noresponse').length).toBe(1);

        const reply = fixture('apple-calendar/24-post-invite-reply.xml').replace('d2683fa9-7a50-4390-82bb-cbcea5e0fa86', id);
        const accepted = await request('POST', '/dav/calendars/bob/', {user: 'bob', body: reply, headers: {'content-type': 'text/xml'}});
        expect(accepted.status).toBe(200);
        expect(xml(accepted).localName).toBe('shared-as');
        expect(accepted.body).toContain('<d:href>/dav/calendars/bob/personal/</d:href></cs:shared-as>');

        const bobCal = '/dav/calendars/bob/personal/';
        const p = props(await request('PROPFIND', bobCal, {user: 'bob', headers: {depth: '0'}, body: PROPFIND('<d:resourcetype/><d:owner/><cs:invite/><cs:allowed-sharing-modes/>')}))[bobCal]!;
        expect(p.resourcetype).toBe('collection calendar shared');
        expect(p.owner).toBe('href(/dav/principals/alice/)');
        expect(p.invite).toBe('organizer(href(/dav/principals/alice/) common-name(Alice))');
        expect(p['allowed-sharing-modes']).toBe('');
        expect((await request('PUT', `${bobCal}x.ics`, {user: 'bob', body: ics('VEVENT', 'x', 'DTSTART:20260601T100000Z')})).status).toBe(201);
        // A sharee can't share further.
        expect((await request('POST', bobCal, {user: 'bob', body: invite})).status).toBe(403);
    });

    it('sync-collection reports changed and dismissed notifications', async () => {
        const {request} = setup();
        await request('POST', CAL, {body: invite});
        const sync = (token: string) =>
            request('REPORT', '/dav/notifications/bob/', {
                user: 'bob',
                headers: {depth: '1'},
                body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
            });
        const first = await sync('');
        const id = await invitationId(request);
        expect(Object.keys(props(first))).toEqual([`/dav/notifications/bob/${id}.xml`]);
        const token = xml(first).getElementsByTagNameNS('DAV:', 'sync-token')[0]!.textContent!;
        expect(Object.keys(props(await sync(token)))).toEqual([]);

        await request('POST', CAL, {body: share('<cs:set><d:href>mailto:bob@example.com</d:href><cs:read/></cs:set>')});
        expect(Object.keys(props(await sync(token)))).toEqual([`/dav/notifications/bob/${id}.xml`]);

        expect((await request('DELETE', `/dav/notifications/bob/${id}.xml`, {user: 'bob'})).status).toBe(204);
        const after = await sync(token);
        expect(after.body).toContain('404 Not Found');
    });

    it('declining and removing take the calendar away', async () => {
        const {request} = setup();
        await request('POST', CAL, {body: invite});
        const id = await invitationId(request);
        const decline = `<cs:invite-reply ${CS}><d:href>mailto:bob@example.com</d:href><cs:invite-declined/><cs:hosturl><d:href>${CAL}</d:href></cs:hosturl><cs:in-reply-to>${id}</cs:in-reply-to></cs:invite-reply>`;
        expect((await request('POST', '/dav/calendars/bob/', {user: 'bob', body: decline})).status).toBe(200);
        expect((await request('PROPFIND', '/dav/calendars/bob/personal/', {user: 'bob', headers: {depth: '0'}})).status).toBe(404);

        await request('POST', CAL, {body: share('<cs:remove><d:href>mailto:bob@example.com</d:href></cs:remove>')});
        const p = props(await request('PROPFIND', CAL, {headers: {depth: '0'}, body: PROPFIND('<d:resourcetype/><cs:invite/>')}))[CAL]!;
        expect(p.resourcetype).toBe('collection calendar');
        expect(p.invite).toBe('');
    });

    it('rejects unknown invitations, unknown users and missing support', async () => {
        const {request, provider} = setup();
        const reply = fixture('apple-calendar/24-post-invite-reply.xml');
        expect((await request('POST', '/dav/calendars/bob/', {user: 'bob', body: reply})).status).toBe(404);
        const nobody = await request('POST', CAL, {body: share('<cs:set><d:href>mailto:nobody@example.com</d:href><cs:read/></cs:set>')});
        expect(nobody.status).toBe(409);
        Object.assign(provider, {sharing: undefined});
        expect((await request('POST', CAL, {body: invite})).status).toBe(403);
        expect((await request('PROPFIND', '/dav/notifications/bob/', {user: 'bob', headers: {depth: '0'}})).status).toBe(404);
    });
});
