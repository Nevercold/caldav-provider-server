import type {Context} from './context.ts';
import {CalDavError} from './errors.ts';
import {FilterError, parseTimeRange} from './filter.ts';
import type {CalDavResponse} from './http.ts';
import {parseIcs, TimeResolver} from './ical.ts';
import {busyPeriods, type Range} from './timerange.ts';
import type {CalDavProvider, Calendar, Principal} from './types.ts';
import {child, NS, type XmlElement} from './xml.ts';

export const PRODID = '-//caldav-provider-server//EN';

export interface Period {
    start: number;
    end: number;
    type: string;
}

/** A UTC date-time in iCalendar form, e.g. 20260101T120000Z. */
export const icsUtc = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** TZID of the VTIMEZONE in calendar-timezone, used for floating times. */
export function floatingZoneOf(timezone: string | undefined): string | undefined {
    return timezone ? /^TZID:(.+)$/m.exec(timezone)?.[1]?.trim() : undefined;
}

/** Busy periods of the events of one calendar, read through the provider. */
export async function busyOfCalendar<P extends Principal>(
    provider: CalDavProvider<P>,
    principal: P,
    calendar: Calendar,
    range: Range,
    maskUid?: string,
): Promise<Period[]> {
    const periods: Period[] = [];
    if (!calendar.components.includes('VEVENT')) return periods;
    const query = {componentType: 'VEVENT' as const, timeRange: {start: new Date(range.start), end: new Date(range.end)}};
    const floating = floatingZoneOf(calendar.timezone);
    for (const object of await provider.listObjects(principal, calendar, query)) {
        let vcal;
        try {
            vcal = parseIcs(object.ics);
        } catch {
            continue;
        }
        const events = vcal.getAllSubcomponents('vevent');
        if (!events.length || (maskUid && events[0]!.getFirstPropertyValue('uid') === maskUid)) continue;
        periods.push(...busyPeriods(events, new TimeResolver(vcal, floating), range));
    }
    return periods;
}

/** FREEBUSY lines, sorted by start. */
export function freeBusyLines(periods: Period[]): string[] {
    return [...periods]
        .sort((a, b) => a.start - b.start)
        .map((p) => `FREEBUSY;FBTYPE=${p.type}:${icsUtc(p.start)}/${icsUtc(p.end)}`);
}

/** free-busy-query REPORT (RFC 4791 7.10) on a calendar: a VFREEBUSY of its events. */
export async function freeBusyQuery(ctx: Context, root: XmlElement, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind !== 'calendar') throw CalDavError.dav(403, 'supported-report', 'free-busy-query only works on calendars');
    let range: Range | undefined;
    try {
        range = parseTimeRange(child(root, NS.CALDAV, 'time-range'));
    } catch (e) {
        if (e instanceof FilterError) throw new CalDavError(400, e.message);
        throw e;
    }
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
        throw new CalDavError(400, 'free-busy-query needs a time-range with start and end');
    }
    const periods = await busyOfCalendar(ctx.provider, ctx.principal, r.calendar, range);
    const body = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:${PRODID}`,
        'BEGIN:VFREEBUSY',
        `DTSTAMP:${icsUtc(Date.now())}`,
        `DTSTART:${icsUtc(range.start)}`,
        `DTEND:${icsUtc(range.end)}`,
        ...freeBusyLines(periods),
        'END:VFREEBUSY',
        'END:VCALENDAR',
        '',
    ].join('\r\n');
    return {status: 200, headers: {'Content-Type': 'text/calendar; charset=utf-8'}, body};
}
