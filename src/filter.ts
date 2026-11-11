import {type Component, ICAL, type Property, TimeResolver} from './ical.ts';
import {alarmOverlaps, type Range, setOverlaps} from './timerange.ts';
import type {ComponentType, ObjectQuery} from './types.ts';
import {child, children, is, NS, type XmlElement} from './xml.ts';

export interface TextMatch {
    value: string;
    negate: boolean;
    collation: string;
}

export interface ParamFilter {
    name: string;
    isNotDefined: boolean;
    textMatch?: TextMatch;
}

export interface PropFilter {
    name: string;
    isNotDefined: boolean;
    timeRange?: Range;
    textMatch?: TextMatch;
    params: ParamFilter[];
}

export interface CompFilter {
    name: string;
    isNotDefined: boolean;
    timeRange?: Range;
    props: PropFilter[];
    comps: CompFilter[];
}

export class FilterError extends Error {
    constructor(
        message: string,
        /** CalDAV precondition to report, e.g. supported-collation. */
        readonly precondition = 'valid-filter',
    ) {
        super(message);
    }
}

const COLLATIONS = new Set(['i;ascii-casemap', 'i;octet', 'i;unicode-casemap']);

/** Parses a UTC date-time like 20260101T000000Z. */
export function parseUtc(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim());
    if (!m) throw new FilterError(`invalid time-range value ${value}`);
    const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
    return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
}

export function parseTimeRange(el: XmlElement | undefined): Range | undefined {
    if (!el) return undefined;
    const start = parseUtc(el.getAttribute('start'));
    const end = parseUtc(el.getAttribute('end'));
    if (start === undefined && end === undefined) throw new FilterError('time-range needs start or end');
    return {start: start ?? -Infinity, end: end ?? Infinity};
}

function parseTextMatch(el: XmlElement | undefined): TextMatch | undefined {
    if (!el) return undefined;
    const collation = el.getAttribute('collation') || 'i;ascii-casemap';
    if (!COLLATIONS.has(collation)) throw new FilterError(`unsupported collation ${collation}`, 'supported-collation');
    return {value: el.textContent ?? '', negate: el.getAttribute('negate-condition') === 'yes', collation};
}

function nameAttr(el: XmlElement): string {
    const name = el.getAttribute('name');
    if (!name) throw new FilterError(`${el.localName} without name`);
    return name.toLowerCase();
}

function parseParamFilter(el: XmlElement): ParamFilter {
    return {
        name: nameAttr(el),
        isNotDefined: !!child(el, NS.CALDAV, 'is-not-defined'),
        textMatch: parseTextMatch(child(el, NS.CALDAV, 'text-match')),
    };
}

function parsePropFilter(el: XmlElement): PropFilter {
    return {
        name: nameAttr(el),
        isNotDefined: !!child(el, NS.CALDAV, 'is-not-defined'),
        timeRange: parseTimeRange(child(el, NS.CALDAV, 'time-range')),
        textMatch: parseTextMatch(child(el, NS.CALDAV, 'text-match')),
        params: children(el)
            .filter((c) => is(c, NS.CALDAV, 'param-filter'))
            .map(parseParamFilter),
    };
}

export function parseCompFilter(el: XmlElement): CompFilter {
    return {
        name: nameAttr(el),
        isNotDefined: !!child(el, NS.CALDAV, 'is-not-defined'),
        timeRange: parseTimeRange(child(el, NS.CALDAV, 'time-range')),
        props: children(el)
            .filter((c) => is(c, NS.CALDAV, 'prop-filter'))
            .map(parsePropFilter),
        comps: children(el)
            .filter((c) => is(c, NS.CALDAV, 'comp-filter'))
            .map(parseCompFilter),
    };
}

/** Parses CALDAV:filter. Its single child must be the VCALENDAR comp-filter. */
export function parseFilter(el: XmlElement | undefined): CompFilter | undefined {
    if (!el) return undefined;
    const top = children(el).filter((c) => is(c, NS.CALDAV, 'comp-filter'));
    if (top.length !== 1 || top[0]!.getAttribute('name')?.toUpperCase() !== 'VCALENDAR') {
        throw new FilterError('filter must contain exactly one VCALENDAR comp-filter');
    }
    return parseCompFilter(top[0]!);
}

/** Derives a pre-filter hint for the provider. */
export function queryFromFilter(filter: CompFilter | undefined): ObjectQuery {
    const inner = filter?.comps.find((c) => !c.isNotDefined && (c.name === 'vevent' || c.name === 'vtodo'));
    if (!inner || filter!.comps.length !== 1) return {};
    const query: ObjectQuery = {componentType: inner.name.toUpperCase() as ComponentType};
    if (inner.timeRange) {
        query.timeRange = {};
        if (Number.isFinite(inner.timeRange.start)) query.timeRange.start = new Date(inner.timeRange.start);
        if (Number.isFinite(inner.timeRange.end)) query.timeRange.end = new Date(inner.timeRange.end);
    }
    return query;
}

function textMatches(tm: TextMatch, value: string): boolean {
    let hit: boolean;
    if (tm.collation === 'i;octet') hit = value.includes(tm.value);
    else if (tm.collation === 'i;ascii-casemap') {
        const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
        hit = lower(value).includes(lower(tm.value));
    } else hit = value.toLowerCase().includes(tm.value.toLowerCase());
    return tm.negate ? !hit : hit;
}

function propText(prop: Property): string {
    return prop
        .getValues()
        .map((v) => (typeof v === 'string' ? v : String(v)))
        .join(',');
}

class Evaluator {
    constructor(private readonly tr: TimeResolver) {}

    /** Does `parent` contain a component satisfying the filter? */
    comp(f: CompFilter, parent: Component, parentSet: Component[]): boolean {
        const candidates = parent.getAllSubcomponents(f.name);
        if (f.isNotDefined) return candidates.length === 0;
        if (!candidates.length) return false;

        if (f.timeRange) {
            if (f.name === 'valarm') {
                const range = f.timeRange;
                if (!candidates.some((a) => alarmOverlaps(a, parentSet, this.tr, range))) return false;
            } else if (!setOverlaps(candidates, this.tr, f.timeRange)) {
                return false;
            }
        }
        return candidates.some(
            (c) => f.props.every((p) => this.prop(p, c)) && f.comps.every((sub) => this.comp(sub, c, candidates)),
        );
    }

    prop(f: PropFilter, comp: Component): boolean {
        const props = comp.getAllProperties(f.name);
        if (f.isNotDefined) return props.length === 0;
        if (!props.length) return false;
        return props.some((p) => {
            if (f.timeRange) {
                const v = p.getFirstValue();
                if (!(v instanceof ICAL.Time)) return false;
                const ms = this.tr.toMs(v, p.getParameter('tzid') as string | undefined);
                if (!(f.timeRange.start <= ms && ms < f.timeRange.end)) return false;
            }
            if (f.textMatch && !textMatches(f.textMatch, propText(p))) return false;
            return f.params.every((pf) => this.param(pf, p));
        });
    }

    param(f: ParamFilter, prop: Property): boolean {
        const value = prop.getParameter(f.name);
        if (f.isNotDefined) return value === undefined || value === null;
        if (value === undefined || value === null) return false;
        if (!f.textMatch) return true;
        const values = Array.isArray(value) ? value : [value];
        return values.some((v) => textMatches(f.textMatch!, String(v)));
    }
}

/** Evaluates a parsed VCALENDAR comp-filter against a parsed object. */
export function matchesFilter(filter: CompFilter, vcal: Component, floatingZone?: string): boolean {
    const ev = new Evaluator(new TimeResolver(vcal, floatingZone));
    // The top-level filter applies to the VCALENDAR itself.
    return filter.props.every((p) => ev.prop(p, vcal)) && filter.comps.every((c) => ev.comp(c, vcal, [vcal]));
}

