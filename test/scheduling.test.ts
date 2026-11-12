import {describe, expect, it} from 'vitest';
import {processSchedulingMessage} from '../src/index.ts';
import {ics, PROPFIND, props, setup} from './helpers.ts';

const meeting = (...extra: string[]) =>
    ics(
        'VEVENT',
        'm1',
        'DTSTART:20260310T100000Z',
        'DTEND:20260310T110000Z',
        'SUMMARY:Meeting',
        'SEQUENCE:0',
        'ORGANIZER;CN=Alice:mailto:alice@example.com',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@example.com',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:carol@external.example',
        ...extra,
    );

const unfold = (s: string) => s.replace(/\r\n[ \t]/g, '');

const aliceUrl = '/dav/calendars/alice/personal/m1.ics';
const bobUrl = '/dav/calendars/bob/bobcal/m1.ics';

describe('implicit scheduling', () => {
    it('organizer PUT sends REQUEST and stores SCHEDULE-STATUS', async () => {
        const {provider, request} = setup();
        const res = await request('PUT', aliceUrl, {body: meeting()});
        expect(res.status).toBe(201);
        // the stored data differs from the request, so no ETag
        expect(res.headers.ETag).toBeUndefined();

        expect(provider.outbox).toHaveLength(1);
        expect(provider.outbox[0]!.method).toBe('REQUEST');
        expect(provider.outbox[0]!.recipients).toEqual(['mailto:bob@example.com', 'mailto:carol@external.example']);
        expect(provider.outbox[0]!.ics).toContain('METHOD:REQUEST');

        const stored = unfold((await request('GET', aliceUrl)).body!);
        expect(stored).toContain('SCHEDULE-STATUS=1.2:mailto:bob@example.com');
        expect(stored).toContain('SCHEDULE-STATUS=3.7:mailto:carol@external.example');

        // delivered into Bob's calendar
        const bob = await request('GET', bobUrl, {user: 'bob'});
        expect(bob.status).toBe(200);
        expect(bob.body).not.toContain('METHOD');
        expect(bob.body).toContain('SUMMARY:Meeting');
    });

    it('does not resend for insignificant changes, but for significant ones', async () => {
        const {provider, request} = setup();
        await request('PUT', aliceUrl, {body: meeting()});
        await request('PUT', aliceUrl, {body: meeting('X-SOMETHING:1')});
        expect(provider.outbox).toHaveLength(1);
        await request('PUT', aliceUrl, {body: meeting().replace('SUMMARY:Meeting', 'SUMMARY:Moved').replace('SEQUENCE:0', 'SEQUENCE:1')});
        expect(provider.outbox).toHaveLength(2);
        expect((await request('GET', bobUrl, {user: 'bob'})).body).toContain('SUMMARY:Moved');
    });

    it('sends CANCEL to removed attendees and on delete', async () => {
        const {provider, request} = setup();
        await request('PUT', aliceUrl, {body: meeting()});
        await request('PUT', aliceUrl, {body: meeting().replace('ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:carol@external.example\r\n', '')});
        // the remaining attendees get the changed attendee list
        expect(provider.outbox.slice(1).map((m) => `${m.method} ${m.recipients}`)).toEqual([
            'CANCEL mailto:carol@external.example',
            'REQUEST mailto:bob@example.com',
        ]);

        expect((await request('DELETE', aliceUrl)).status).toBe(204);
        expect(provider.outbox.at(-1)).toMatchObject({method: 'CANCEL', recipients: ['mailto:bob@example.com']});
        expect((await request('GET', bobUrl, {user: 'bob'})).body).toContain('STATUS:CANCELLED');
    });

    it('attendee PUT with new PARTSTAT sends REPLY to the organizer', async () => {
        const {provider, request} = setup();
        await request('PUT', aliceUrl, {body: meeting()});
        const bobCopy = (await request('GET', bobUrl, {user: 'bob'})).body!;
        const accepted = bobCopy.replace(/ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com/, 'ATTENDEE;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:bob@example.com');
        expect(accepted).not.toBe(bobCopy);
        const res = await request('PUT', bobUrl, {user: 'bob', body: accepted});
        expect(res.status).toBe(204);
        const reply = provider.outbox.at(-1)!;
        expect(reply.method).toBe('REPLY');
        expect(reply.recipients).toEqual(['mailto:alice@example.com']);
        expect(reply.ics).toContain('PARTSTAT=ACCEPTED');
        expect(reply.ics).not.toContain('carol');
        expect(unfold((await request('GET', aliceUrl)).body!)).toMatch(/PARTSTAT=ACCEPTED[^\r\n]*:mailto:bob@example.com/);
    });

    it('attendee DELETE declines unless Schedule-Reply: F', async () => {
        const {provider, request} = setup();
        await request('PUT', aliceUrl, {body: meeting()});
        await request('DELETE', bobUrl, {user: 'bob'});
        expect(provider.outbox.at(-1)!.method).toBe('REPLY');
        expect(provider.outbox.at(-1)!.ics).toContain('PARTSTAT=DECLINED');

        const s = setup();
        await s.request('PUT', aliceUrl, {body: meeting()});
        const before = s.provider.outbox.length;
        await s.request('DELETE', bobUrl, {user: 'bob', headers: {'schedule-reply': 'F'}});
        expect(s.provider.outbox).toHaveLength(before);
    });

    it('leaves SCHEDULE-AGENT=CLIENT attendees alone', async () => {
        const {provider, request} = setup();
        await request('PUT', aliceUrl, {body: meeting().replace('ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:carol', 'ATTENDEE;SCHEDULE-AGENT=CLIENT;PARTSTAT=NEEDS-ACTION:mailto:carol')});
        expect(provider.outbox[0]!.recipients).toEqual(['mailto:bob@example.com']);
    });

    it('supports If-Schedule-Tag-Match', async () => {
        const {request} = setup();
        await request('PUT', aliceUrl, {body: meeting()});
        const tag = (await request('GET', bobUrl, {user: 'bob'})).headers['Schedule-Tag']!;
        const body = (await request('GET', bobUrl, {user: 'bob'})).body!;
        expect((await request('PUT', bobUrl, {user: 'bob', body, headers: {'if-schedule-tag-match': '"x"'}})).status).toBe(412);
        expect((await request('PUT', bobUrl, {user: 'bob', body, headers: {'if-schedule-tag-match': tag}})).status).toBe(204);
    });

    it('no scheduling without organizer or without scheduling provider', async () => {
        const {provider, request} = setup();
        await request('PUT', aliceUrl, {body: ics('VEVENT', 'm1', 'DTSTART:20260310T100000Z', 'ATTENDEE:mailto:bob@example.com')});
        expect(provider.outbox).toHaveLength(0);
        const s = setup({scheduling: false});
        await s.request('PUT', aliceUrl, {body: meeting()});
        expect(s.provider.outbox).toHaveLength(0);
        expect((await s.request('PROPFIND', '/dav/inbox/alice/', {headers: {depth: '0'}})).status).toBe(404);
    });
});

describe('scheduling collections', () => {
    it('inbox and outbox', async () => {
        const {request} = setup();
        const inbox = await request('PROPFIND', '/dav/inbox/alice/', {
            headers: {depth: '0'},
            body: PROPFIND('<d:resourcetype/><c:schedule-default-calendar-URL/><d:current-user-privilege-set/>'),
        });
        expect(props(inbox)['/dav/inbox/alice/']).toMatchObject({
            resourcetype: 'collection schedule-inbox',
            'schedule-default-calendar-URL': 'href(/dav/calendars/alice/personal/)',
        });
        const outbox = await request('PROPFIND', '/dav/outbox/alice/', {headers: {depth: '0'}, body: PROPFIND('<d:resourcetype/>')});
        expect(props(outbox)['/dav/outbox/alice/']!.resourcetype).toBe('collection schedule-outbox');
    });

    it('free-busy query via outbox POST', async () => {
        const {request} = setup();
        await request('PUT', '/dav/calendars/bob/bobcal/x.ics', {user: 'bob', body: ics('VEVENT', 'x', 'DTSTART:20260310T100000Z', 'DTEND:20260310T110000Z')});
        await request('PUT', '/dav/calendars/bob/bobcal/y.ics', {
            user: 'bob',
            body: ics('VEVENT', 'y', 'DTSTART:20260310T120000Z', 'DTEND:20260310T130000Z', 'TRANSP:TRANSPARENT'),
        });
        await request('PUT', '/dav/calendars/bob/bobcal/z.ics', {
            user: 'bob',
            body: ics('VEVENT', 'z', 'DTSTART:20260310T140000Z', 'DTEND:20260310T150000Z', 'STATUS:TENTATIVE'),
        });
        const body = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//test//EN',
            'METHOD:REQUEST',
            'BEGIN:VFREEBUSY',
            'UID:fb1',
            'DTSTAMP:20260301T000000Z',
            'DTSTART:20260310T000000Z',
            'DTEND:20260311T000000Z',
            'ORGANIZER:mailto:alice@example.com',
            'ATTENDEE:mailto:bob@example.com',
            'ATTENDEE:mailto:nobody@example.com',
            'END:VFREEBUSY',
            'END:VCALENDAR',
        ].join('\r\n');
        const res = await request('POST', '/dav/outbox/alice/', {
            body,
            headers: {'content-type': 'text/calendar', originator: 'mailto:alice@example.com', recipient: 'mailto:bob@example.com, mailto:nobody@example.com'},
        });
        expect(res.status).toBe(200);
        expect(res.body).toContain('<cal:schedule-response');
        expect(res.body).toContain('2.0;Success');
        expect(res.body).toContain('FREEBUSY;FBTYPE=BUSY:20260310T100000Z/20260310T110000Z');
        expect(res.body).toContain('FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260310T140000Z/20260310T150000Z');
        expect(res.body).not.toContain('20260310T120000Z/');
        expect(res.body).toContain('3.7;Invalid calendar user');
    });

    it('free-busy from the provider when it has freeBusy', async () => {
        const {provider, request} = setup();
        const asked: unknown[] = [];
        provider.scheduling!.freeBusy = async (requester, address, range, maskUid) => {
            asked.push([requester.id, address, range.start.toISOString(), maskUid]);
            if (address !== 'mailto:bob@example.com') return null;
            return [
                {start: new Date('2026-03-09T22:00:00Z'), end: new Date('2026-03-10T01:00:00Z')},
                {start: new Date('2026-03-10T14:00:00Z'), end: new Date('2026-03-10T15:00:00Z'), type: 'BUSY-TENTATIVE'},
                {start: new Date('2026-03-12T10:00:00Z'), end: new Date('2026-03-12T11:00:00Z')},
            ];
        };
        const body = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'METHOD:REQUEST', 'BEGIN:VFREEBUSY', 'UID:fb2',
            'DTSTAMP:20260301T000000Z', 'DTSTART:20260310T000000Z', 'DTEND:20260311T000000Z',
            'ORGANIZER:mailto:alice@example.com', 'ATTENDEE:mailto:bob@example.com', 'ATTENDEE:mailto:nobody@example.com',
            'X-CALENDARSERVER-MASK-UID:m1', 'END:VFREEBUSY', 'END:VCALENDAR',
        ].join('\r\n');
        const res = await request('POST', '/dav/outbox/alice/', {
            body,
            headers: {'content-type': 'text/calendar', originator: 'mailto:alice@example.com', recipient: 'mailto:bob@example.com, mailto:nobody@example.com'},
        });
        expect(res.status).toBe(200);
        expect(asked[0]).toEqual(['alice', 'mailto:bob@example.com', '2026-03-10T00:00:00.000Z', 'm1']);
        expect(res.body).toContain('FREEBUSY;FBTYPE=BUSY:20260310T000000Z/20260310T010000Z');
        expect(res.body).toContain('FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260310T140000Z/20260310T150000Z');
        expect(res.body).not.toContain('20260312');
        expect(res.body).toContain('3.7;Invalid calendar user');
    });

    it('refuses a foreign Originator', async () => {
        const {request} = setup();
        const res = await request('POST', '/dav/outbox/alice/', {
            body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nMETHOD:REQUEST\r\nBEGIN:VFREEBUSY\r\nUID:x\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T000000Z\r\nDTEND:20260102T000000Z\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n',
            headers: {originator: 'mailto:bob@example.com', recipient: 'mailto:bob@example.com'},
        });
        expect(res.status).toBe(403);
        expect(res.body).toContain('originator-allowed');
    });
});

describe('processSchedulingMessage', () => {
    const request = (seq: number, summary = 'Meeting') =>
        [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:x',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            'UID:p1',
            'DTSTAMP:20260101T000000Z',
            'DTSTART:20260101T100000Z',
            `SEQUENCE:${seq}`,
            `SUMMARY:${summary}`,
            'ORGANIZER:mailto:alice@example.com',
            'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

    it('keeps own PARTSTAT and alarms on updates with the same SEQUENCE', () => {
        const first = processSchedulingMessage(request(0), null, 'bob@example.com').ics!;
        const mine = first
            .replace('PARTSTAT=NEEDS-ACTION', 'PARTSTAT=ACCEPTED')
            .replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nEND:VEVENT');
        const same = processSchedulingMessage(request(0, 'Renamed'), mine, 'mailto:bob@example.com').ics!;
        expect(same).toContain('PARTSTAT=ACCEPTED');
        expect(same).toContain('SUMMARY:Renamed');
        expect(same).toContain('BEGIN:VALARM');
        const bumped = processSchedulingMessage(request(1), mine, 'mailto:bob@example.com').ics!;
        expect(bumped).toContain('PARTSTAT=NEEDS-ACTION');
    });

    it('CANCEL of one instance adds an EXDATE', () => {
        const recurring = processSchedulingMessage(request(0).replace('SEQUENCE:0', 'SEQUENCE:0\r\nRRULE:FREQ=DAILY'), null, 'bob@example.com').ics!;
        const cancel = request(1)
            .replace('METHOD:REQUEST', 'METHOD:CANCEL')
            .replace('DTSTART:20260101T100000Z', 'RECURRENCE-ID:20260103T100000Z\r\nDTSTART:20260103T100000Z');
        const out = processSchedulingMessage(cancel, recurring, 'bob@example.com').ics!;
        expect(out).toContain('EXDATE:20260103T100000Z');
    });

    it('REPLY without an existing copy does nothing', () => {
        expect(processSchedulingMessage(request(0).replace('METHOD:REQUEST', 'METHOD:REPLY'), null, 'alice@example.com').ics).toBeNull();
    });
});
