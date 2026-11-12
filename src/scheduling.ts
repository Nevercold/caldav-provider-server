import {type Context, normalizeAddress} from './context.ts';
import {CalDavError} from './errors.ts';
import {header, type CalDavResponse, type ParsedRequest as CalDavRequest, xmlResponse} from './http.ts';
import {type Component, ICAL, IcsError, parseIcs, type Property, TimeResolver} from './ical.ts';
import {busyOfCalendar, freeBusyLines, icsUtc, type Period, PRODID} from './freebusy.ts';
import type {Range} from './timerange.ts';
import type {ScheduleStatus, SchedulingMessage} from './types.ts';
import {cal, d} from './xml.ts';

/** Properties whose change makes the organizer send a new REQUEST. */
const SIGNIFICANT = ['dtstart', 'dtend', 'duration', 'due', 'rrule', 'rdate', 'exdate', 'summary', 'location', 'description', 'status'];

const clone = (c: Component): Component => new ICAL.Component(structuredClone(c.toJSON()));

const components = (vcal: Component): Component[] => vcal.getAllSubcomponents().filter((c) => c.name !== 'vtimezone');

const address = (p: Property): string => normalizeAddress(String(p.getFirstValue() ?? ''));

function organizerOf(comps: Component[]): string | undefined {
    for (const c of comps) {
        const p = c.getFirstProperty('organizer');
        if (p) return address(p);
    }
    return undefined;
}

/** True if the server, not the client, schedules for this calendar user (RFC 6638 7.1). */
function serverSchedules(p: Property): boolean {
    const agent = p.getParameter('schedule-agent');
    return agent === undefined || agent === null || String(agent).toUpperCase() === 'SERVER';
}

/** Attendees the server schedules for, without the organizer. */
function attendees(comps: Component[], organizer: string): Set<string> {
    const out = new Set<string>();
    for (const c of comps) {
        for (const p of c.getAllProperties('attendee')) {
            const a = address(p);
            if (a && a !== organizer && serverSchedules(p)) out.add(a);
        }
    }
    return out;
}

function fingerprint(comps: Component[]): string {
    return comps
        .map((c) => {
            const parts = [String(c.getFirstPropertyValue('recurrence-id') ?? '')];
            for (const name of SIGNIFICANT) parts.push(c.getAllProperties(name).map((p) => p.toICALString()).join('|'));
            parts.push(
                c
                    .getAllProperties('attendee')
                    .map(address)
                    .sort()
                    .join(','),
            );
            return parts.join('\n');
        })
        .sort()
        .join('\n--\n');
}

function forceSend(comps: Component[], value: 'REQUEST' | 'REPLY'): Set<string> {
    const out = new Set<string>();
    for (const c of comps) {
        for (const p of [...c.getAllProperties('attendee'), ...c.getAllProperties('organizer')]) {
            if (String(p.getParameter('schedule-force-send') ?? '').toUpperCase() === value) out.add(address(p));
        }
    }
    return out;
}

function stripScheduleParams(c: Component) {
    for (const p of [...c.getAllProperties('attendee'), ...c.getAllProperties('organizer')]) {
        p.removeParameter('schedule-status');
        p.removeParameter('schedule-agent');
        p.removeParameter('schedule-force-send');
    }
}

function utcNow(): InstanceType<typeof ICAL.Time> {
    return ICAL.Time.fromJSDate(new Date(), true);
}

/** Builds an iTIP VCALENDAR from components of a stored object. */
function buildItip(method: SchedulingMessage['method'], comps: Component[], timezones: Component[]): string {
    const out = new ICAL.Component('vcalendar');
    out.addPropertyWithValue('prodid', PRODID);
    out.addPropertyWithValue('version', '2.0');
    out.addPropertyWithValue('method', method);
    for (const tz of timezones) out.addSubcomponent(clone(tz));
    for (const c of comps) {
        for (const alarm of c.getAllSubcomponents('valarm')) c.removeSubcomponent(alarm);
        stripScheduleParams(c);
        c.updatePropertyWithValue('dtstamp', utcNow());
        out.addSubcomponent(c);
    }
    return out.toString();
}

function timezonesOf(vcal: Component): Component[] {
    return vcal.getAllSubcomponents('vtimezone');
}

async function deliver(
    ctx: Context,
    method: SchedulingMessage['method'],
    uid: string,
    originator: string,
    recipients: string[],
    ics: string,
): Promise<Record<string, ScheduleStatus>> {
    if (!recipients.length) return {};
    const result = await ctx.provider.scheduling!.deliver({
        method,
        uid,
        originator,
        sender: ctx.principal,
        recipients,
        ics,
    });
    const statuses: Record<string, ScheduleStatus> = {};
    const normalized = new Map(Object.entries(result).map(([k, v]) => [normalizeAddress(k), v]));
    for (const r of recipients) statuses[r] = normalized.get(r) ?? '5.1';
    return statuses;
}

function cancelled(comps: Component[]): boolean {
    const master = comps.find((c) => !c.hasProperty('recurrence-id'));
    return String(master?.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function partstats(comps: Component[], me: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of comps) {
        const key = String(c.getFirstPropertyValue('recurrence-id') ?? '');
        for (const p of c.getAllProperties('attendee')) {
            if (me.includes(address(p))) out.set(key, String(p.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase());
        }
    }
    return out;
}

/** REPLY components: only what RFC 5546 3.2.3 needs plus the replying attendee. */
function replyComponents(comps: Component[], me: string[], partstatOverride?: string): Component[] {
    const out: Component[] = [];
    for (const c of comps) {
        const mine = c.getAllProperties('attendee').find((p) => me.includes(address(p)));
        if (!mine) continue;
        const r = new ICAL.Component(c.name);
        for (const name of ['uid', 'sequence', 'recurrence-id', 'dtstart', 'dtend', 'duration', 'due', 'summary', 'organizer']) {
            const p = c.getFirstProperty(name);
            if (p) r.addProperty(ICAL.Property.fromString(p.toICALString()));
        }
        const attendee = ICAL.Property.fromString(mine.toICALString());
        if (partstatOverride) attendee.setParameter('partstat', partstatOverride);
        r.addProperty(attendee);
        out.push(r);
    }
    return out;
}

function setStatus(props: Property[], statuses: Record<string, ScheduleStatus>): boolean {
    let changed = false;
    for (const p of props) {
        const s = statuses[address(p)];
        if (s) {
            p.setParameter('schedule-status', s);
            changed = true;
        }
    }
    return changed;
}

/**
 * Implicit scheduling on PUT (RFC 6638 3.2). Sends the iTIP messages and
 * returns the object with SCHEDULE-STATUS set, or undefined if the object
 * stays as it is.
 */
export async function schedulePut(ctx: Context, vcal: Component, previous: Component | null): Promise<string | undefined> {
    const comps = components(vcal);
    const organizer = organizerOf(comps);
    if (!organizer) return undefined;
    const me = ctx.addresses();
    const uid = String(comps[0]!.getFirstPropertyValue('uid'));
    const oldComps = previous ? components(previous) : [];
    let modified = false;

    if (me.includes(organizer)) {
        const now = attendees(comps, organizer);
        const before = previous ? attendees(oldComps, organizer) : new Set<string>();
        if (!now.size && !before.size) return undefined;
        const forced = forceSend(comps, 'REQUEST');
        const statuses: Record<string, ScheduleStatus> = {};

        const removed = [...before].filter((a) => !now.has(a));
        if (removed.length) {
            const cancelComps = oldComps.map(clone);
            for (const c of cancelComps) {
                c.updatePropertyWithValue('status', 'CANCELLED');
                for (const p of c.getAllProperties('attendee')) if (!removed.includes(address(p))) c.removeProperty(p);
            }
            Object.assign(statuses, await deliver(ctx, 'CANCEL', uid, organizer, removed, buildItip('CANCEL', cancelComps, timezonesOf(previous!))));
        }

        const becameCancelled = cancelled(comps) && !(previous && cancelled(oldComps));
        const significant = !previous || fingerprint(comps) !== fingerprint(oldComps);
        const recipients = [...now].filter((a) => becameCancelled || significant || !before.has(a) || forced.has(a));
        if (recipients.length) {
            const method = becameCancelled ? 'CANCEL' : 'REQUEST';
            const ics = buildItip(method, comps.map(clone), timezonesOf(vcal));
            Object.assign(statuses, await deliver(ctx, method, uid, organizer, recipients, ics));
        }
        for (const c of comps) {
            if (setStatus(c.getAllProperties('attendee'), statuses)) modified = true;
            for (const p of c.getAllProperties('attendee')) {
                if (p.getParameter('schedule-force-send')) {
                    p.removeParameter('schedule-force-send');
                    modified = true;
                }
            }
        }
        return modified ? vcal.toString() : undefined;
    }

    // Attendee: reply when the own participation status changed.
    const mine = partstats(comps, me);
    if (!mine.size) return undefined;
    const old = partstats(oldComps, me);
    const forced = forceSend(comps, 'REPLY');
    const changed = [...mine].some(([k, v]) => (old.get(k) ?? 'NEEDS-ACTION') !== v) || forced.size > 0;
    if (!changed) return undefined;
    const organizerProp = comps.map((c) => c.getFirstProperty('organizer')).find(Boolean);
    if (organizerProp && !serverSchedules(organizerProp)) return undefined;
    const from = comps.flatMap((c) => c.getAllProperties('attendee')).map(address).find((a) => me.includes(a))!;
    const ics = buildItip('REPLY', replyComponents(comps, me), timezonesOf(vcal));
    const statuses = await deliver(ctx, 'REPLY', uid, from, [organizer], ics);
    for (const c of comps) {
        if (setStatus(c.getAllProperties('organizer'), statuses)) modified = true;
        for (const p of c.getAllProperties('attendee')) {
            if (p.getParameter('schedule-force-send')) {
                p.removeParameter('schedule-force-send');
                modified = true;
            }
        }
    }
    return modified ? vcal.toString() : undefined;
}

/** Implicit scheduling on DELETE (RFC 6638 3.2.2.3 and 3.2.6). */
export async function scheduleDelete(ctx: Context, previous: Component, scheduleReply: boolean): Promise<void> {
    const comps = components(previous);
    const organizer = organizerOf(comps);
    if (!organizer) return;
    const me = ctx.addresses();
    const uid = String(comps[0]!.getFirstPropertyValue('uid'));

    if (me.includes(organizer)) {
        if (cancelled(comps)) return;
        const recipients = [...attendees(comps, organizer)];
        if (!recipients.length) return;
        const cancelComps = comps.map(clone);
        for (const c of cancelComps) c.updatePropertyWithValue('status', 'CANCELLED');
        await deliver(ctx, 'CANCEL', uid, organizer, recipients, buildItip('CANCEL', cancelComps, timezonesOf(previous)));
        return;
    }

    if (!scheduleReply) return;
    const mine = partstats(comps, me);
    if (!mine.size || [...mine.values()].every((v) => v === 'DECLINED')) return;
    const from = comps.flatMap((c) => c.getAllProperties('attendee')).map(address).find((a) => me.includes(a))!;
    const ics = buildItip('REPLY', replyComponents(comps, me, 'DECLINED'), timezonesOf(previous));
    await deliver(ctx, 'REPLY', uid, from, [organizer], ics);
}

const REQUEST_STATUS: Record<string, string> = {
    '1.0': 'Pending',
    '1.1': 'Sent',
    '1.2': 'Delivered',
    '2.0': 'Success',
    '3.7': 'Invalid calendar user',
    '3.8': 'No authority',
    '5.1': 'Could not deliver',
    '5.2': 'Invalid calendar service',
    '5.3': 'No scheduling support for user',
};

const requestStatus = (s: string) => `${s};${REQUEST_STATUS[s] ?? 'Unknown'}`;

async function freeBusyFor(ctx: Context, address: string, range: Range, maskUid: string | undefined): Promise<string | null> {
    const s = ctx.provider.scheduling!;
    const periods: Period[] = [];
    if (s.freeBusy) {
        const busy = await s.freeBusy(ctx.principal, address, {start: new Date(range.start), end: new Date(range.end)}, maskUid);
        if (!busy) return null;
        for (const period of busy) {
            // Clipped to the asked range (RFC 5545 3.6.4), empty ones dropped.
            const start = Math.max(period.start.getTime(), range.start);
            const end = Math.min(period.end.getTime(), range.end);
            if (end > start) periods.push({start, end, type: period.type ?? 'BUSY'});
        }
        return freeBusyLines(periods).join('\r\n');
    }
    const principal = s.findPrincipal ? await s.findPrincipal(address) : null;
    if (!principal) return null;
    for (const calendar of await ctx.provider.listCalendars(principal)) {
        // Transparent calendars don't make their owner busy (RFC 6638 9.1).
        if (calendar.transparent) continue;
        periods.push(...(await busyOfCalendar(ctx.provider, principal, calendar, range, maskUid)));
    }
    return freeBusyLines(periods).join('\r\n');
}

function freeBusyReply(request: Component, recipient: string, busy: string, range: Range): string {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:${PRODID}`,
        'METHOD:REPLY',
        'BEGIN:VFREEBUSY',
        `UID:${request.getFirstPropertyValue('uid') ?? crypto.randomUUID()}`,
        `DTSTAMP:${icsUtc(Date.now())}`,
        `DTSTART:${icsUtc(range.start)}`,
        `DTEND:${icsUtc(range.end)}`,
    ];
    const organizer = request.getFirstProperty('organizer');
    if (organizer) lines.push(organizer.toICALString());
    lines.push(`ATTENDEE:${recipient}`);
    if (busy) lines.push(busy);
    lines.push('END:VFREEBUSY', 'END:VCALENDAR', '');
    return lines.join('\r\n');
}

/** POST to the scheduling outbox (RFC 6638 5): free-busy queries and client-side scheduling. */
export async function handleOutboxPost(ctx: Context, req: CalDavRequest, path: string): Promise<CalDavResponse> {
    const r = await ctx.resolve(path);
    if (r.kind !== 'outbox') throw new CalDavError(405, 'POST is only supported on the scheduling outbox');
    if (!ctx.writable) throw CalDavError.forbidden('read-only delegates cannot schedule');

    let vcal;
    try {
        vcal = parseIcs(req.body ?? '');
    } catch (e) {
        if (e instanceof IcsError) throw CalDavError.caldav(400, 'valid-calendar-data', e.message);
        throw e;
    }
    const method = String(vcal.getFirstPropertyValue('method') ?? '').toUpperCase() as SchedulingMessage['method'];
    if (!method) throw CalDavError.caldav(400, 'valid-scheduling-message', 'METHOD is missing');
    const comps = components(vcal);
    if (!comps.length) throw CalDavError.caldav(400, 'valid-scheduling-message', 'no component');

    const me = ctx.addresses();
    const originator = normalizeAddress(header(req, 'originator') ?? organizerOf(comps) ?? '');
    if (!me.includes(originator)) throw CalDavError.caldav(403, 'originator-allowed', 'Originator is not the authenticated user');
    let recipients = (header(req, 'recipient') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalizeAddress);
    if (!recipients.length) {
        recipients = comps.flatMap((c) => c.getAllProperties('attendee')).map(address);
    }
    if (!recipients.length) throw CalDavError.caldav(400, 'recipient-specified', 'no recipient');

    const results: {recipient: string; status: string; data?: string}[] = [];
    const freeBusy = comps[0]!.name === 'vfreebusy';
    if (freeBusy && method === 'REQUEST') {
        const fb = comps[0]!;
        const tr = new TimeResolver(vcal);
        const start = tr.propMs(fb, 'dtstart');
        const end = tr.propMs(fb, 'dtend');
        if (start === undefined || end === undefined || end <= start) {
            throw CalDavError.caldav(400, 'valid-scheduling-message', 'VFREEBUSY needs DTSTART and DTEND');
        }
        const range = {start, end};
        const mask = fb.getFirstProperty('x-calendarserver-mask-uid')?.getFirstValue();
        for (const recipient of recipients) {
            const busy = await freeBusyFor(ctx, recipient, range, typeof mask === 'string' ? mask : undefined);
            if (busy === null) results.push({recipient, status: requestStatus('3.7')});
            else results.push({recipient, status: requestStatus('2.0'), data: freeBusyReply(fb, recipient, busy, range)});
        }
    } else {
        const uid = String(comps[0]!.getFirstPropertyValue('uid') ?? '');
        const statuses = await deliver(ctx, method, uid, originator, recipients, vcal.toString());
        for (const recipient of recipients) results.push({recipient, status: requestStatus(statuses[recipient]!)});
    }

    return xmlResponse(
        200,
        cal(
            'schedule-response',
            results.map((res) =>
                cal(
                    'response',
                    cal('recipient', d('href', res.recipient)),
                    cal('request-status', res.status),
                    res.data !== undefined ? cal('calendar-data', res.data) : null,
                ),
            ),
        ),
    );
}

