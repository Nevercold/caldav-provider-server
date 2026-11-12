import {CalDavError} from './errors.ts';
import {FilterError, parseUtc} from './filter.ts';
import {type Component, ICAL, parseIcs, type Time, TimeResolver} from './ical.ts';
import {MAX_OCCURRENCES, type Range, setOverlaps} from './timerange.ts';
import {child, children, is, NS, type XmlElement} from './xml.ts';

/*
 * Partial calendar data in REPORT responses (RFC 4791 9.6): component and
 * property selection, expand and limit-recurrence-set.
 */

interface CompSpec {
    allprop: boolean;
    props: Map<string, {novalue: boolean}>;
    allcomp: boolean;
    comps: Map<string, CompSpec>;
}

export interface CalendarDataRequest {
    comp?: CompSpec;
    expand?: Range;
    limitRecurrenceSet?: Range;
}

function parseComp(el: XmlElement): CompSpec {
    const spec: CompSpec = {allprop: false, props: new Map(), allcomp: false, comps: new Map()};
    for (const c of children(el)) {
        const name = (c.getAttribute('name') ?? '').toUpperCase();
        if (is(c, NS.CALDAV, 'allprop')) spec.allprop = true;
        else if (is(c, NS.CALDAV, 'allcomp')) spec.allcomp = true;
        else if (is(c, NS.CALDAV, 'prop') && name) spec.props.set(name, {novalue: c.getAttribute('novalue') === 'yes'});
        else if (is(c, NS.CALDAV, 'comp') && name) spec.comps.set(name, parseComp(c));
    }
    return spec;
}

function parseRange(el: XmlElement): Range {
    let start: number | undefined;
    let end: number | undefined;
    try {
        start = parseUtc(el.getAttribute('start'));
        end = parseUtc(el.getAttribute('end'));
    } catch (e) {
        if (e instanceof FilterError) throw new CalDavError(400, e.message);
        throw e;
    }
    if (start === undefined || end === undefined || end <= start) {
        throw new CalDavError(400, `${el.localName} needs start and end`);
    }
    return {start, end};
}

/** Reads a requested `<C:calendar-data>` element. Returns undefined if it asks for the full object. */
export function parseCalendarDataRequest(el: XmlElement | undefined): CalendarDataRequest | undefined {
    if (!el) return undefined;
    const type = el.getAttribute('content-type');
    if (type && type.toLowerCase() !== 'text/calendar') throw CalDavError.caldav(403, 'supported-calendar-data');
    const comp = child(el, NS.CALDAV, 'comp');
    const expand = child(el, NS.CALDAV, 'expand');
    const limit = child(el, NS.CALDAV, 'limit-recurrence-set');
    // limit-freebusy-set only concerns VFREEBUSY, which calendars here don't hold.
    if (!comp && !expand && !limit) return undefined;
    return {
        comp: comp && (comp.getAttribute('name') ?? '').toUpperCase() === 'VCALENDAR' ? parseComp(comp) : undefined,
        expand: expand ? parseRange(expand) : undefined,
        limitRecurrenceSet: limit ? parseRange(limit) : undefined,
    };
}

const utcTime = (ms: number): Time => ICAL.Time.fromJSDate(new Date(ms), true);

/** Sets a date-time property to UTC; dates stay dates. */
function propToUtc(comp: Component, name: string, tr: TimeResolver) {
    for (const prop of comp.getAllProperties(name)) {
        const value = prop.getFirstValue();
        if (!(value instanceof ICAL.Time) || value.isDate) continue;
        const ms = tr.toMs(value, prop.getParameter('tzid') as string | undefined);
        prop.removeParameter('tzid');
        prop.setValue(utcTime(ms));
    }
}

const TIME_PROPS = ['dtstart', 'dtend', 'due', 'recurrence-id', 'exdate', 'rdate'];

function toUtc(comp: Component, tr: TimeResolver): Component {
    for (const name of TIME_PROPS) propToUtc(comp, name, tr);
    return comp;
}

const cloneComp = (c: Component): Component => new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())));

/** The occurrences of a recurrence set that overlap the range, as single components in UTC (RFC 4791 9.6.5). */
function expandSet(comps: Component[], tr: TimeResolver, range: Range): Component[] {
    const out: Component[] = [];
    const master = comps.find((c) => !c.hasProperty('recurrence-id'));
    const overrides = comps.filter((c) => c.hasProperty('recurrence-id'));
    const overridden = new Set<number>();
    for (const o of overrides) {
        const rid = tr.propMs(o, 'recurrence-id');
        if (rid !== undefined) overridden.add(rid);
        if (setOverlaps([o], tr, range)) out.push(toUtc(cloneComp(o), tr));
    }
    if (!master) return out;

    const dtstart = master.getFirstPropertyValue('dtstart');
    const recurring = master.hasProperty('rrule') || master.hasProperty('rdate');
    if (!recurring || !(dtstart instanceof ICAL.Time)) {
        if (setOverlaps([master], tr, range)) out.push(toUtc(cloneComp(master), tr));
        return out;
    }

    const tzid = tr.tzidOf(master, 'dtstart');
    const startMs = tr.toMs(dtstart, tzid);
    const endOffsets: Record<string, number> = {};
    for (const name of ['dtend', 'due']) {
        const ms = tr.propMs(master, name);
        if (ms !== undefined) endOffsets[name] = ms - startMs;
    }
    const expansion = new ICAL.RecurExpansion({component: master, dtstart});
    for (let n = 0; n < MAX_OCCURRENCES; n++) {
        const next: Time | undefined = expansion.next();
        if (!next) break;
        const occurrence = tr.toMs(next, tzid);
        if (occurrence >= range.end) break;
        if (overridden.has(occurrence)) continue;

        const inst = cloneComp(master);
        for (const name of ['rrule', 'rdate', 'exdate', 'exrule']) inst.removeAllProperties(name);
        for (const name of ['dtstart', 'dtend', 'due']) {
            const prop = inst.getFirstProperty(name);
            const value = prop?.getFirstValue();
            if (!prop || !(value instanceof ICAL.Time)) continue;
            prop.removeParameter('tzid');
            if (dtstart.isDate) {
                // All-day: shift by whole days, the values stay dates.
                const shifted = next.clone();
                shifted.addDuration(value.subtractDate(dtstart));
                prop.setValue(shifted);
            } else {
                prop.setValue(utcTime(occurrence + (name === 'dtstart' ? 0 : (endOffsets[name] ?? 0))));
            }
        }
        inst.addPropertyWithValue('recurrence-id', dtstart.isDate ? next.clone() : utcTime(occurrence));
        if (setOverlaps([inst], tr, range)) out.push(inst);
    }
    return out;
}

/** Master plus the overridden instances that overlap the range (RFC 4791 9.6.6). */
function limitSet(comps: Component[], tr: TimeResolver, range: Range): Component[] {
    return comps.filter((c) => {
        if (!c.hasProperty('recurrence-id')) return true;
        const rid = tr.propMs(c, 'recurrence-id');
        return setOverlaps([c], tr, range) || (rid !== undefined && rid >= range.start && rid < range.end);
    });
}

function select(comp: Component, spec: CompSpec) {
    if (!spec.allprop) {
        // Without a name ical.js returns its live list, so iterate over a copy.
        for (const prop of [...comp.getAllProperties()]) {
            const want = spec.props.get(prop.name.toUpperCase());
            if (!want) comp.removeProperty(prop);
            else if (want.novalue) {
                comp.removeProperty(prop);
                comp.addProperty(new ICAL.Property(prop.name));
            }
        }
    }
    if (spec.allcomp) return;
    for (const sub of [...comp.getAllSubcomponents()]) {
        const s = spec.comps.get(sub.name.toUpperCase());
        if (!s) comp.removeSubcomponent(sub);
        else select(sub, s);
    }
}

/** Applies a calendar-data request to stored ICS. Unparsable data is returned as it is. */
export function applyCalendarData(ics: string, req: CalendarDataRequest, floatingZone?: string): string {
    let vcal: Component;
    try {
        vcal = parseIcs(ics);
    } catch {
        return ics;
    }
    const range = req.expand ?? req.limitRecurrenceSet;
    if (range) {
        const tr = new TimeResolver(vcal, floatingZone);
        const comps = vcal.getAllSubcomponents().filter((c) => c.name !== 'vtimezone');
        const kept = req.expand ? expandSet(comps, tr, range) : limitSet(comps, tr, range);
        for (const c of [...vcal.getAllSubcomponents()]) {
            // Expanded data is in UTC and needs no VTIMEZONE.
            if (c.name !== 'vtimezone' || req.expand) vcal.removeSubcomponent(c);
        }
        for (const c of kept) vcal.addSubcomponent(c);
    }
    if (req.comp) select(vcal, req.comp);
    return vcal.toString().replace(/\r?\n/g, '\r\n') + '\r\n';
}
