import {type Component, DAY_MS, durationMs, ICAL, type Time, type TimeResolver} from './ical.ts';

/** Upper bound of expanded occurrences per object, protects against runaway rules. */
export const MAX_OCCURRENCES = 20_000;

export interface Range {
    /** Inclusive start in ms, -Infinity if open. */
    start: number;
    /** Exclusive end in ms, +Infinity if open. */
    end: number;
}

/** One occurrence with the time properties RFC 4791 9.9 looks at, in ms. */
interface Instance {
    dtstart?: number;
    dtstartIsDate?: boolean;
    dtend?: number;
    duration?: number;
    due?: number;
    completed?: number;
    created?: number;
    status?: string;
    transparent?: boolean;
}

/** RFC 4791 9.9, table for VEVENT. */
function eventOverlaps(i: Instance, {start: S, end: E}: Range): boolean {
    if (i.dtstart === undefined) return false;
    const start = i.dtstart;
    if (i.dtend !== undefined) return S < i.dtend && E > start;
    if (i.duration !== undefined && i.duration > 0) return S < start + i.duration && E > start;
    if (i.duration === undefined && i.dtstartIsDate) return S < start + DAY_MS && E > start;
    return S <= start && E > start;
}

/** RFC 4791 9.9, table for VTODO. */
function todoOverlaps(i: Instance, {start: S, end: E}: Range): boolean {
    const {dtstart, duration, due, completed, created} = i;
    if (dtstart !== undefined) {
        if (duration !== undefined) {
            const endTime = dtstart + duration;
            return S <= endTime && (E > dtstart || E >= endTime);
        }
        if (due !== undefined) return (S < due || S <= dtstart) && (E > dtstart || E >= due);
        return S <= dtstart && E > dtstart;
    }
    if (due !== undefined) return S < due && E >= due;
    if (completed !== undefined && created !== undefined) {
        return (S <= created || S <= completed) && (E >= created || E >= completed);
    }
    if (completed !== undefined) return S <= completed && E >= completed;
    if (created !== undefined) return E > created;
    return true;
}

function baseInstance(comp: Component, tr: TimeResolver): Instance {
    const dtstartValue = comp.getFirstPropertyValue('dtstart');
    return {
        dtstart: tr.propMs(comp, 'dtstart'),
        dtstartIsDate: dtstartValue instanceof ICAL.Time ? dtstartValue.isDate : undefined,
        dtend: tr.propMs(comp, 'dtend'),
        duration: durationMs(comp),
        due: tr.propMs(comp, 'due'),
        completed: tr.propMs(comp, 'completed'),
        created: tr.propMs(comp, 'created'),
        status: String(comp.getFirstPropertyValue('status') ?? '').toUpperCase() || undefined,
        transparent: String(comp.getFirstPropertyValue('transp') ?? '').toUpperCase() === 'TRANSPARENT',
    };
}

function shift(i: Instance, delta: number): Instance {
    const add = (v?: number) => (v === undefined ? undefined : v + delta);
    return {...i, dtstart: add(i.dtstart), dtend: add(i.dtend), due: add(i.due)};
}

/**
 * All occurrences of a recurrence set (master plus overridden instances with
 * RECURRENCE-ID) that could matter for `range`. Stops once occurrences start
 * after the range.
 */
export function* instances(comps: Component[], tr: TimeResolver, range: Range): Generator<Instance> {
    const master = comps.find((c) => !c.hasProperty('recurrence-id'));
    const overrides = comps.filter((c) => c.hasProperty('recurrence-id'));
    const overridden = new Set<number>();
    for (const o of overrides) {
        const rid = tr.propMs(o, 'recurrence-id');
        if (rid !== undefined) overridden.add(rid);
        yield baseInstance(o, tr);
    }
    if (!master) return;

    const base = baseInstance(master, tr);
    const isRecurring = master.hasProperty('rrule') || master.hasProperty('rdate');
    const dtstart = master.getFirstPropertyValue('dtstart');
    if (!isRecurring || !(dtstart instanceof ICAL.Time) || base.dtstart === undefined) {
        yield base;
        return;
    }

    const tzid = tr.tzidOf(master, 'dtstart');
    const expansion = new ICAL.RecurExpansion({component: master, dtstart});
    for (let n = 0; n < MAX_OCCURRENCES; n++) {
        const next: Time | undefined = expansion.next();
        if (!next) return;
        const startMs = tr.toMs(next, tzid);
        if (startMs >= range.end) return;
        if (overridden.has(startMs)) continue;
        yield shift(base, startMs - base.dtstart);
    }
}

/** Does any occurrence of the recurrence set overlap the range? */
export function setOverlaps(comps: Component[], tr: TimeResolver, range: Range): boolean {
    const type = comps[0]?.name;
    const test = type === 'vtodo' ? todoOverlaps : eventOverlaps;
    for (const i of instances(comps, tr, range)) if (test(i, range)) return true;
    return false;
}

/**
 * VALARM time-range (RFC 4791 9.9): trigger times of the alarm for every
 * occurrence of the parent.
 */
export function alarmOverlaps(alarm: Component, parents: Component[], tr: TimeResolver, range: Range): boolean {
    const trigger = alarm.getFirstProperty('trigger');
    if (!trigger) return false;
    const value = trigger.getFirstValue();
    const hits = (t: number) => range.start <= t && t < range.end;
    if (value instanceof ICAL.Time) return hits(tr.toMs(value, trigger.getParameter('tzid') as string | undefined));
    if (!(value instanceof ICAL.Duration)) return false;
    const offset = value.toSeconds() * 1000;
    const relatedEnd = trigger.getParameter('related') === 'END';
    // Without an end bound, look at occurrences shifted by the offset.
    const searchRange = {start: range.start - Math.abs(offset), end: range.end + Math.abs(offset)};
    for (const i of instances(parents, tr, searchRange)) {
        let anchor = i.dtstart;
        if (relatedEnd) {
            anchor = i.dtend ?? i.due ?? (i.dtstart !== undefined && i.duration !== undefined ? i.dtstart + i.duration : i.dtstart);
        }
        if (anchor !== undefined && hits(anchor + offset)) return true;
    }
    return false;
}

/** Busy periods of VEVENTs for free-busy (RFC 4791 7.10, RFC 6638 free-busy). */
export interface BusyPeriod {
    start: number;
    end: number;
    type: 'BUSY' | 'BUSY-TENTATIVE';
}

export function busyPeriods(comps: Component[], tr: TimeResolver, range: Range): BusyPeriod[] {
    const out: BusyPeriod[] = [];
    for (const i of instances(comps, tr, range)) {
        if (i.dtstart === undefined || i.transparent || i.status === 'CANCELLED') continue;
        let end = i.dtend ?? (i.duration !== undefined ? i.dtstart + i.duration : undefined);
        if (end === undefined) end = i.dtstartIsDate ? i.dtstart + DAY_MS : i.dtstart;
        if (end <= i.dtstart) continue;
        if (eventOverlaps(i, range)) out.push({
                start: Math.max(i.dtstart, range.start),
                end: Math.min(end, range.end),
                type: i.status === 'TENTATIVE' ? 'BUSY-TENTATIVE' : 'BUSY',
            });
    }
    return out;
}
