import {describe, expect, it} from 'vitest';
import {ics, setup} from './helpers.ts';

const C = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
const CAL = '/dav/calendars/alice/personal/';

describe('free-busy-query', () => {
    async function seeded() {
        const s = setup();
        await s.request('PUT', `${CAL}a.ics`, {body: ics('VEVENT', 'a', 'DTSTART:20260310T100000Z', 'DTEND:20260310T110000Z')});
        await s.request('PUT', `${CAL}b.ics`, {
            body: ics('VEVENT', 'b', 'DTSTART:20260302T080000Z', 'DTEND:20260302T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'STATUS:TENTATIVE'),
        });
        await s.request('PUT', `${CAL}c.ics`, {body: ics('VEVENT', 'c', 'DTSTART:20260311T100000Z', 'DTEND:20260311T110000Z', 'TRANSP:TRANSPARENT')});
        return s;
    }

    it('answers a VFREEBUSY with the busy times of the calendar', async () => {
        const {request} = await seeded();
        const res = await request('REPORT', CAL, {
            headers: {depth: '1'},
            body: `<c:free-busy-query ${C}><c:time-range start="20260301T000000Z" end="20260315T000000Z"/></c:free-busy-query>`,
        });
        expect(res.status).toBe(200);
        expect(res.headers['Content-Type']).toBe('text/calendar; charset=utf-8');
        expect(res.body).toContain('DTSTART:20260301T000000Z\r\nDTEND:20260315T000000Z');
        const lines = res.body!.split('\r\n').filter((l) => l.startsWith('FREEBUSY'));
        expect(lines).toEqual([
            'FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260302T080000Z/20260302T090000Z',
            'FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260309T080000Z/20260309T090000Z',
            'FREEBUSY;FBTYPE=BUSY:20260310T100000Z/20260310T110000Z',
        ]);
    });

    it('needs a closed time-range and a calendar', async () => {
        const {request} = await seeded();
        const open = await request('REPORT', CAL, {body: `<c:free-busy-query ${C}><c:time-range start="20260301T000000Z"/></c:free-busy-query>`});
        expect(open.status).toBe(400);
        const home = await request('REPORT', '/dav/calendars/alice/', {
            body: `<c:free-busy-query ${C}><c:time-range start="20260301T000000Z" end="20260315T000000Z"/></c:free-busy-query>`,
        });
        expect(home.status).toBe(403);
    });
});
