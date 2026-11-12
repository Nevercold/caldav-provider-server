import {describe, expect, it} from 'vitest';
import {ics, props, setup} from './helpers.ts';

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

describe('partial calendar-data', () => {
    const BERLIN = [
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'DTSTART:19701025T030000',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:19700329T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
    ];
    const weekly = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//test//EN',
        ...BERLIN,
        'BEGIN:VEVENT',
        'UID:w',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;TZID=Europe/Berlin:20260320T100000',
        'DTEND;TZID=Europe/Berlin:20260320T110000',
        'RRULE:FREQ=WEEKLY;COUNT=4',
        'SUMMARY:Weekly',
        'DESCRIPTION:Long text',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:w',
        'DTSTAMP:20260101T000000Z',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260403T100000',
        'DTSTART;TZID=Europe/Berlin:20260403T120000',
        'DTEND;TZID=Europe/Berlin:20260403T130000',
        'SUMMARY:Moved',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
    ].join('\r\n');

    async function query(calendarData: string): Promise<string> {
        const {request} = setup();
        await request('PUT', `${CAL}w.ics`, {body: weekly});
        const res = await request('REPORT', CAL, {
            headers: {depth: '1'},
            body: `<c:calendar-multiget ${C}><d:prop>${calendarData}</d:prop><d:href>${CAL}w.ics</d:href></c:calendar-multiget>`,
        });
        expect(res.status).toBe(207);
        return props(res)[`${CAL}w.ics`]!['calendar-data']!;
    }

    it('returns the full object without children', async () => {
        expect(await query('<c:calendar-data/>')).toBe(weekly);
    });

    it('expands recurrences into UTC instances', async () => {
        const data = await query('<c:calendar-data><c:expand start="20260325T000000Z" end="20260410T000000Z"/></c:calendar-data>');
        expect(data).not.toContain('VTIMEZONE');
        expect(data).not.toContain('RRULE');
        const starts = [...data.matchAll(/^DTSTART:(\S+)$/gm)].map((m) => m[1]);
        // 27 March: still +01:00; 3 April is the moved instance (+02:00 after the DST switch).
        expect(starts).toEqual(['20260403T100000Z', '20260327T090000Z']);
        expect(data).toContain('RECURRENCE-ID:20260327T090000Z');
        expect(data).toContain('RECURRENCE-ID:20260403T080000Z');
        expect(data).toContain('SUMMARY:Moved');
    });

    it('limit-recurrence-set keeps the master and overrides in range', async () => {
        const inRange = await query('<c:calendar-data><c:limit-recurrence-set start="20260401T000000Z" end="20260410T000000Z"/></c:calendar-data>');
        expect(inRange).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
        expect(inRange).toContain('SUMMARY:Moved');
        expect(inRange).toContain('BEGIN:VTIMEZONE');
        const outside = await query('<c:calendar-data><c:limit-recurrence-set start="20260501T000000Z" end="20260510T000000Z"/></c:calendar-data>');
        expect(outside).toContain('RRULE');
        expect(outside).not.toContain('SUMMARY:Moved');
    });

    it('selects components and properties', async () => {
        const data = await query(
            '<c:calendar-data><c:comp name="VCALENDAR"><c:prop name="VERSION"/><c:comp name="VEVENT"><c:prop name="UID"/><c:prop name="SUMMARY"/><c:prop name="DESCRIPTION" novalue="yes"/></c:comp></c:comp></c:calendar-data>',
        );
        expect(data).toContain('VERSION:2.0');
        expect(data).not.toContain('PRODID');
        expect(data).not.toContain('VTIMEZONE');
        expect(data).toContain('SUMMARY:Weekly');
        expect(data).not.toContain('DTSTART');
        expect(data).not.toContain('Long text');
        expect(data).toMatch(/^DESCRIPTION:\r$/m);
    });

    it('rejects other content types and broken ranges', async () => {
        const {request} = setup();
        const res = await request('REPORT', CAL, {
            body: `<c:calendar-multiget ${C}><d:prop><c:calendar-data content-type="application/calendar+json"/></d:prop><d:href>${CAL}x.ics</d:href></c:calendar-multiget>`,
        });
        expect(res.status).toBe(403);
        expect(res.body).toContain('supported-calendar-data');
        const bad = await request('REPORT', CAL, {
            body: `<c:calendar-multiget ${C}><d:prop><c:calendar-data><c:expand start="20260101T000000Z"/></c:calendar-data></d:prop><d:href>${CAL}x.ics</d:href></c:calendar-multiget>`,
        });
        expect(bad.status).toBe(400);
    });
});
