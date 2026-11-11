import ICAL from 'ical.js';
import type {ComponentType} from './types.ts';

export type Component = InstanceType<typeof ICAL.Component>;
export type Property = InstanceType<typeof ICAL.Property>;
export type Time = InstanceType<typeof ICAL.Time>;
type Timezone = InstanceType<typeof ICAL.Timezone>;

export class IcsError extends Error {}

export function parseIcs(ics: string): Component {
    let jcal;
    try {
        jcal = ICAL.parse(ics);
    } catch (e) {
        throw new IcsError((e as Error).message);
    }
    // ICAL.parse returns an array of components if the text holds several.
    if (Array.isArray(jcal[0])) throw new IcsError('more than one top-level component');
    const comp = new ICAL.Component(jcal);
    if (comp.name !== 'vcalendar') throw new IcsError('not a VCALENDAR');
    return comp;
}

export interface ObjectInfo {
    uid: string;
    componentType: ComponentType;
}

/**
 * Validates a calendar object resource (RFC 4791 4.1): one component type,
 * one UID, no METHOD.
 */
export function inspectObject(vcal: Component): ObjectInfo {
    if (vcal.getFirstProperty('method')) throw new IcsError('METHOD is not allowed in a calendar object resource');
    const comps = vcal.getAllSubcomponents().filter((c) => c.name !== 'vtimezone');
    if (!comps.length) throw new IcsError('no calendar component');
    const types = new Set(comps.map((c) => c.name.toUpperCase()));
    if (types.size !== 1) throw new IcsError('more than one component type');
    const componentType = [...types][0]!;
    if (componentType !== 'VEVENT' && componentType !== 'VTODO') {
        throw new IcsError(`unsupported component ${componentType}`);
    }
    const uids = new Set(comps.map((c) => c.getFirstPropertyValue('uid')));
    if (uids.size !== 1) throw new IcsError('components must share one UID');
    const uid = [...uids][0];
    if (typeof uid !== 'string' || !uid) throw new IcsError('missing UID');
    return {uid, componentType};
}

/** Component type and UID without validation, for objects coming from the provider. */
export function peekObject(vcal: Component): Partial<ObjectInfo> {
    const comp = vcal.getAllSubcomponents().find((c) => c.name !== 'vtimezone');
    if (!comp) return {};
    const uid = comp.getFirstPropertyValue('uid');
    return {componentType: comp.name.toUpperCase() as ComponentType, uid: typeof uid === 'string' ? uid : undefined};
}

const intlCache = new Map<string, Intl.DateTimeFormat | null>();

function intlFormat(tzid: string): Intl.DateTimeFormat | null {
    if (!intlCache.has(tzid)) {
        let fmt: Intl.DateTimeFormat | null = null;
        try {
            fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: tzid,
                hourCycle: 'h23',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
            });
        } catch {
            // not an IANA name
        }
        intlCache.set(tzid, fmt);
    }
    return intlCache.get(tzid)!;
}

/** Offset of an IANA zone at a UTC instant, in ms. */
function intlOffset(fmt: Intl.DateTimeFormat, utcMs: number): number {
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(utcMs))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
    const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converts ICAL.Time values of one calendar to UTC milliseconds. Uses the
 * VTIMEZONEs of the calendar first, then IANA names via Intl (many clients
 * send TZID=Europe/Berlin without VTIMEZONE), and treats everything else as
 * floating, which is evaluated in `floatingZone` or UTC (RFC 4791 9.9).
 */
export class TimeResolver {
    private readonly zones = new Map<string, Timezone>();

    constructor(
        vcal: Component,
        private readonly floatingZone?: string,
    ) {
        for (const tz of vcal.getAllSubcomponents('vtimezone')) {
            const zone = new ICAL.Timezone(tz);
            if (zone.tzid) this.zones.set(zone.tzid, zone);
        }
    }

    /** Wall-clock value of a time in ms as if it were UTC. */
    private static wallClock(t: Time): number {
        return Date.UTC(t.year, t.month - 1, t.day, t.isDate ? 0 : t.hour, t.isDate ? 0 : t.minute, t.isDate ? 0 : t.second);
    }

    toMs(t: Time, tzid?: string | null): number {
        if (!t.isDate && t.zone?.tzid === 'UTC') return TimeResolver.wallClock(t);
        const id = t.isDate ? undefined : (tzid ?? undefined);
        if (id) {
            const zone = this.zones.get(id);
            if (zone) {
                const copy = t.clone();
                copy.zone = zone;
                return copy.toUnixTime() * 1000;
            }
        }
        return this.inZone(TimeResolver.wallClock(t), id ?? this.floatingZone);
    }

    private inZone(wall: number, tzid: string | undefined): number {
        const fmt = tzid ? intlFormat(tzid) : null;
        if (!fmt) return wall;
        // Two passes handle the DST switch around the instant.
        let utc = wall - intlOffset(fmt, wall);
        utc = wall - intlOffset(fmt, utc);
        return utc;
    }

    /** First value of a date/date-time property in ms, or undefined. */
    propMs(comp: Component, name: string): number | undefined {
        const prop = comp.getFirstProperty(name);
        if (!prop) return undefined;
        const value = prop.getFirstValue();
        if (!(value instanceof ICAL.Time)) return undefined;
        return this.toMs(value, prop.getParameter('tzid') as string | undefined);
    }

    tzidOf(comp: Component, name: string): string | undefined {
        return (comp.getFirstProperty(name)?.getParameter('tzid') as string | undefined) ?? undefined;
    }
}

export function durationMs(comp: Component): number | undefined {
    const value = comp.getFirstPropertyValue('duration');
    return value instanceof ICAL.Duration ? value.toSeconds() * 1000 : undefined;
}

export const DAY_MS = 86_400_000;

export {ICAL};
