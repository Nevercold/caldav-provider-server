import {describe, expect, it} from 'vitest';
import {matchesFilter, parseFilter, queryFromFilter} from '../src/filter.ts';
import {parseIcs} from '../src/ical.ts';
import {parseXml} from '../src/xml.ts';

const C = 'xmlns:C="urn:ietf:params:xml:ns:caldav"';

function filter(inner: string) {
    return parseFilter(parseXml(`<C:filter ${C}><C:comp-filter name="VCALENDAR">${inner}</C:comp-filter></C:filter>`)!)!;
}

const range = (comp: string, start: string, end: string) =>
    filter(`<C:comp-filter name="${comp}"><C:time-range start="${start}" end="${end}"/></C:comp-filter>`);

function cal(body: string, extra = ''): string {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', extra, body, 'END:VCALENDAR']
        .filter(Boolean)
        .join('\r\n');
}

const BERLIN = [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Berlin',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
].join('\r\n');

const match = (f: ReturnType<typeof filter>, ics: string) => matchesFilter(f, parseIcs(ics));

describe('comp-filter time-range on VEVENT', () => {
    const event = cal(
        ['BEGIN:VEVENT', 'UID:a', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260310T100000Z', 'DTEND:20260310T110000Z', 'END:VEVENT'].join('\r\n'),
    );

    it('matches overlapping ranges only', () => {
        expect(match(range('VEVENT', '20260310T000000Z', '20260311T000000Z'), event)).toBe(true);
        expect(match(range('VEVENT', '20260310T110000Z', '20260311T000000Z'), event)).toBe(false);
        expect(match(range('VEVENT', '20260310T105959Z', '20260311T000000Z'), event)).toBe(true);
        expect(match(range('VTODO', '20260310T000000Z', '20260311T000000Z'), event)).toBe(false);
    });

    it('treats an all-day event as one day long', () => {
        const allDay = cal(['BEGIN:VEVENT', 'UID:b', 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20260310', 'END:VEVENT'].join('\r\n'));
        expect(match(range('VEVENT', '20260310T230000Z', '20260311T000000Z'), allDay)).toBe(true);
        expect(match(range('VEVENT', '20260311T000000Z', '20260312T000000Z'), allDay)).toBe(false);
    });

    it('resolves TZID through the VTIMEZONE and through IANA names', () => {
        const body = ['BEGIN:VEVENT', 'UID:c', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Berlin:20260710T100000', 'DURATION:PT1H', 'END:VEVENT'].join('\r\n');
        // 10:00 CEST is 08:00Z
        for (const ics of [cal(body, BERLIN), cal(body)]) {
            expect(match(range('VEVENT', '20260710T080000Z', '20260710T083000Z'), ics)).toBe(true);
            expect(match(range('VEVENT', '20260710T090000Z', '20260710T100000Z'), ics)).toBe(false);
        }
    });

    it('expands recurrences and respects EXDATE and overrides', () => {
        const ics = cal(
            [
                'BEGIN:VEVENT',
                'UID:r',
                'DTSTAMP:20260101T000000Z',
                'DTSTART;TZID=Europe/Berlin:20260105T090000',
                'DTEND;TZID=Europe/Berlin:20260105T100000',
                'RRULE:FREQ=WEEKLY',
                'EXDATE;TZID=Europe/Berlin:20260112T090000',
                'END:VEVENT',
                'BEGIN:VEVENT',
                'UID:r',
                'DTSTAMP:20260101T000000Z',
                'RECURRENCE-ID;TZID=Europe/Berlin:20260119T090000',
                'DTSTART;TZID=Europe/Berlin:20260120T150000',
                'DTEND;TZID=Europe/Berlin:20260120T160000',
                'END:VEVENT',
            ].join('\r\n'),
            BERLIN,
        );
        // occurrence far in the future, summer time: 09:00 CEST = 07:00Z
        expect(match(range('VEVENT', '20290702T070000Z', '20290702T073000Z'), ics)).toBe(true);
        // excluded date
        expect(match(range('VEVENT', '20260112T000000Z', '20260113T000000Z'), ics)).toBe(false);
        // moved instance: not on the 19th but on the 20th
        expect(match(range('VEVENT', '20260119T000000Z', '20260120T000000Z'), ics)).toBe(false);
        expect(match(range('VEVENT', '20260120T140000Z', '20260120T143000Z'), ics)).toBe(true);
    });
});

describe('comp-filter time-range on VTODO', () => {
    const todo = (...props: string[]) => cal(['BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', ...props, 'END:VTODO'].join('\r\n'));
    const r = range('VTODO', '20260301T000000Z', '20260302T000000Z');

    it('follows the RFC 4791 9.9 table', () => {
        expect(match(r, todo())).toBe(true);
        expect(match(r, todo('DUE:20260301T120000Z'))).toBe(true);
        expect(match(r, todo('DUE:20260305T120000Z'))).toBe(false);
        expect(match(r, todo('DTSTART:20260228T120000Z', 'DUE:20260305T120000Z'))).toBe(true);
        expect(match(r, todo('COMPLETED:20260301T050000Z'))).toBe(true);
        expect(match(r, todo('CREATED:20260310T050000Z'))).toBe(false);
    });
});

describe('prop-filter and param-filter', () => {
    const todo = (...props: string[]) => cal(['BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', ...props, 'END:VTODO'].join('\r\n'));

    it('is-not-defined and negated text-match (Apple Reminders style)', () => {
        const open = filter(
            '<C:comp-filter name="VTODO"><C:prop-filter name="COMPLETED"><C:is-not-defined/></C:prop-filter>' +
                '<C:prop-filter name="STATUS"><C:text-match negate-condition="yes">CANCELLED</C:text-match></C:prop-filter></C:comp-filter>',
        );
        expect(match(open, todo('STATUS:NEEDS-ACTION'))).toBe(true);
        expect(match(open, todo('STATUS:COMPLETED', 'COMPLETED:20260101T000000Z'))).toBe(false);
        expect(match(open, todo('STATUS:CANCELLED'))).toBe(false);
    });

    it('text-match on UID is case-insensitive by default, i;octet is not', () => {
        const ics = todo('SUMMARY:Hello World');
        expect(match(filter('<C:comp-filter name="VTODO"><C:prop-filter name="SUMMARY"><C:text-match>hello</C:text-match></C:prop-filter></C:comp-filter>'), ics)).toBe(true);
        expect(
            match(filter('<C:comp-filter name="VTODO"><C:prop-filter name="SUMMARY"><C:text-match collation="i;octet">hello</C:text-match></C:prop-filter></C:comp-filter>'), ics),
        ).toBe(false);
    });

    it('param-filter', () => {
        const ics = cal(
            ['BEGIN:VEVENT', 'UID:p', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260101T100000Z', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@example.com', 'END:VEVENT'].join('\r\n'),
        );
        const f = (s: string) =>
            filter(`<C:comp-filter name="VEVENT"><C:prop-filter name="ATTENDEE"><C:param-filter name="PARTSTAT">${s}</C:param-filter></C:prop-filter></C:comp-filter>`);
        expect(match(f('<C:text-match>ACCEPTED</C:text-match>'), ics)).toBe(true);
        expect(match(f('<C:text-match>DECLINED</C:text-match>'), ics)).toBe(false);
        expect(match(f('<C:is-not-defined/>'), ics)).toBe(false);
    });

    it('VALARM time-range relative to start', () => {
        const ics = cal(
            ['BEGIN:VEVENT', 'UID:al', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260101T100000Z', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT'].join('\r\n'),
        );
        const f = (s: string, e: string) =>
            filter(`<C:comp-filter name="VEVENT"><C:comp-filter name="VALARM"><C:time-range start="${s}" end="${e}"/></C:comp-filter></C:comp-filter>`);
        expect(match(f('20260101T094000Z', '20260101T095000Z'), ics)).toBe(true);
        expect(match(f('20260101T095000Z', '20260101T100000Z'), ics)).toBe(false);
    });
});

describe('queryFromFilter', () => {
    it('derives component type and range', () => {
        expect(queryFromFilter(range('VEVENT', '20260101T000000Z', '20260201T000000Z'))).toEqual({
            componentType: 'VEVENT',
            timeRange: {start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z')},
        });
        expect(queryFromFilter(filter(''))).toEqual({});
    });

    it('rejects unknown collations', () => {
        expect(() => filter('<C:comp-filter name="VTODO"><C:prop-filter name="UID"><C:text-match collation="x">a</C:text-match></C:prop-filter></C:comp-filter>')).toThrow(
            /collation/,
        );
    });
});
