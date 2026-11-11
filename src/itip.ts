import {normalizeAddress} from './context.ts';
import {type Component, ICAL, parseIcs, type Property} from './ical.ts';

export interface ProcessedMessage {
    /** Method of the processed message. */
    method: string;
    uid: string;
    /**
     * New content of the recipient's copy, without METHOD. null means: there
     * is nothing to store (e.g. a CANCEL or REPLY for an unknown event).
     */
    ics: string | null;
}

const clone = (c: Component): Component => new ICAL.Component(structuredClone(c.toJSON()));
const ridOf = (c: Component): string => String(c.getFirstPropertyValue('recurrence-id') ?? '');
const address = (p: Property): string => normalizeAddress(String(p.getFirstValue() ?? ''));
const items = (vcal: Component): Component[] => vcal.getAllSubcomponents().filter((c) => c.name !== 'vtimezone');

function withoutMethod(vcal: Component): Component {
    const out = clone(vcal);
    out.removeAllProperties('method');
    return out;
}

function addMissingTimezones(target: Component, source: Component) {
    const have = new Set(target.getAllSubcomponents('vtimezone').map((t) => t.getFirstPropertyValue('tzid')));
    for (const tz of source.getAllSubcomponents('vtimezone')) {
        if (!have.has(tz.getFirstPropertyValue('tzid'))) target.addSubcomponent(clone(tz));
    }
}

/**
 * Applies an incoming iTIP message (RFC 5546) to the recipient's copy of the
 * object, the way a server with automatic processing does it (RFC 6638 3.2.3):
 *
 * - REQUEST: creates or updates the copy; the recipient's own PARTSTAT and
 *   alarms survive updates that do not change the SEQUENCE.
 * - CANCEL: marks the event (or the cancelled instances) as CANCELLED.
 * - REPLY: copies the sender's PARTSTAT into the organizer's copy.
 *
 * Use it in `SchedulingProvider.deliver` for recipients that are local users.
 */
export function processSchedulingMessage(itip: string, existing: string | null, recipient: string): ProcessedMessage {
    const message = parseIcs(itip);
    const method = String(message.getFirstPropertyValue('method') ?? '').toUpperCase();
    const incoming = items(message);
    const uid = String(incoming[0]?.getFirstPropertyValue('uid') ?? '');
    const current = existing ? parseIcs(existing) : null;
    const me = normalizeAddress(recipient);

    if (method === 'REQUEST' || method === 'ADD' || method === 'PUBLISH') {
        const next = withoutMethod(message);
        if (current) {
            const old = new Map(items(current).map((c) => [ridOf(c), c]));
            for (const c of items(next)) {
                const before = old.get(ridOf(c));
                if (!before) continue;
                // Keep alarms of the recipient.
                for (const alarm of before.getAllSubcomponents('valarm')) c.addSubcomponent(clone(alarm));
                const sameSequence = Number(before.getFirstPropertyValue('sequence') ?? 0) === Number(c.getFirstPropertyValue('sequence') ?? 0);
                if (!sameSequence) continue;
                const oldMine = before.getAllProperties('attendee').find((p) => address(p) === me);
                const newMine = c.getAllProperties('attendee').find((p) => address(p) === me);
                const partstat = oldMine?.getParameter('partstat');
                if (newMine && partstat) newMine.setParameter('partstat', String(partstat));
            }
            if (method === 'ADD') {
                const merged = clone(current);
                for (const c of items(next)) merged.addSubcomponent(c);
                addMissingTimezones(merged, next);
                return {method, uid, ics: merged.toString()};
            }
        }
        return {method, uid, ics: next.toString()};
    }

    if (!current) return {method, uid, ics: null};
    const next = clone(current);
    const comps = items(next);

    if (method === 'CANCEL') {
        const master = comps.find((c) => !c.hasProperty('recurrence-id'));
        for (const c of incoming) {
            const rid = ridOf(c);
            if (!rid) {
                for (const x of comps) x.updatePropertyWithValue('status', 'CANCELLED');
                continue;
            }
            const instance = comps.find((x) => ridOf(x) === rid);
            if (instance) instance.updatePropertyWithValue('status', 'CANCELLED');
            else if (master) {
                const exdate = ICAL.Property.fromString(c.getFirstProperty('recurrence-id')!.toICALString().replace(/^RECURRENCE-ID/i, 'EXDATE'));
                master.addProperty(exdate);
            }
        }
        return {method, uid, ics: next.toString()};
    }

    if (method === 'REPLY') {
        let changed = false;
        for (const c of incoming) {
            const target = comps.find((x) => ridOf(x) === ridOf(c)) ?? comps.find((x) => !x.hasProperty('recurrence-id'));
            if (!target) continue;
            for (const reply of c.getAllProperties('attendee')) {
                const a = address(reply);
                const partstat = reply.getParameter('partstat');
                const own = target.getAllProperties('attendee').find((p) => address(p) === a);
                if (own && partstat) {
                    own.setParameter('partstat', String(partstat));
                    own.removeParameter('schedule-status');
                    changed = true;
                }
            }
        }
        return {method, uid, ics: changed ? next.toString() : null};
    }

    return {method, uid, ics: null};
}
