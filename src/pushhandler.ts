import type {Context, Resource} from './context.ts';
import {CalDavError} from './errors.ts';
import {type CalDavResponse, header, type ParsedRequest} from './http.ts';
import {calendarTopic, homeTopic, PUSH_NS, type PushDepth, type PushRegistration, type WebDavPush} from './push.ts';
import {syncTokenUri} from './context.ts';
import type {Calendar} from './types.ts';
import {child, d, el, NS, textOf, type XmlElement, type XNode} from './xml.ts';

/* WebDAV-Push on the server side: properties, registration and notifications after changes. */

const pushError = (status: number, name: string, message: string) => new CalDavError(status, message, {ns: PUSH_NS, name});
const p = (name: string, ...kids: Parameters<typeof el>[2][]): XNode => el(PUSH_NS, name, ...kids);

/** Push topic of a collection, if it supports push. */
export function topicOf(ctx: Context, r: Resource): string | undefined {
    if (!ctx.push) return undefined;
    if (r.kind === 'calendar') return calendarTopic(ctx.principal.id, r.calendar);
    if (r.kind === 'home') return homeTopic(ctx.principal.id);
    return undefined;
}

export function transportsProperty(ctx: Context, r: Resource): XNode[] | undefined {
    if (!ctx.push || !topicOf(ctx, r)) return undefined;
    return [p('web-push', {...p('vapid-public-key', ctx.push.vapidPublicKey), attrs: {type: 'p256ecdsa'}})];
}

export function supportedTriggersProperty(ctx: Context, r: Resource): XNode[] | undefined {
    if (!topicOf(ctx, r)) return undefined;
    const triggers = [p('content-update', d('depth', '1'))];
    if (r.kind === 'calendar') triggers.push(p('property-update', d('depth', '0')));
    return triggers;
}

function parseDepth(el: XmlElement | undefined): PushDepth | undefined {
    if (!el) return undefined;
    const v = textOf(child(el, NS.DAV, 'depth')).toLowerCase();
    return v === '0' || v === 'infinity' ? v : '1';
}

/** POST push-register to a calendar or the calendar home. */
export async function handlePushRegister(ctx: Context, r: Resource, root: XmlElement): Promise<CalDavResponse> {
    const push = ctx.push;
    const topic = topicOf(ctx, r);
    if (!push || !topic) throw pushError(403, 'push-not-available', 'WebDAV-Push is not available here');

    const sub = child(child(root, PUSH_NS, 'subscription'), PUSH_NS, 'web-push-subscription');
    const pushResource = textOf(child(sub, PUSH_NS, 'push-resource'));
    const keyEl = child(sub, PUSH_NS, 'subscription-public-key');
    const publicKey = textOf(keyEl);
    const authSecret = textOf(child(sub, PUSH_NS, 'auth-secret'));
    const encoding = textOf(child(sub, PUSH_NS, 'content-encoding')) || 'aes128gcm';
    let valid = false;
    try {
        valid = /^https?:$/.test(new URL(pushResource).protocol);
    } catch {
        valid = false;
    }
    // Message encryption is required for Web Push (draft 5.3).
    const keyType = keyEl?.getAttribute('type') || 'p256dh';
    if (!valid || !publicKey || !authSecret || encoding !== 'aes128gcm' || keyType !== 'p256dh') {
        throw pushError(403, 'invalid-subscription', 'a Web Push subscription with aes128gcm keys is required');
    }
    if (Buffer.from(publicKey, 'base64url').length !== 65 || Buffer.from(authSecret, 'base64url').length !== 16) {
        throw pushError(403, 'invalid-subscription', 'invalid subscription keys');
    }

    // Unsupported triggers are downgraded or ignored (draft 4.1).
    const trigger = child(root, PUSH_NS, 'trigger');
    const content = parseDepth(child(trigger, PUSH_NS, 'content-update'));
    const property = r.kind === 'calendar' ? parseDepth(child(trigger, PUSH_NS, 'property-update')) : undefined;
    if (!content && !property) throw pushError(403, 'no-supported-trigger', 'no supported trigger');

    const now = Date.now();
    const requested = Date.parse(textOf(child(root, PUSH_NS, 'expires')));
    const until = Number.isFinite(requested) ? requested : now + push.defaultExpiration * 1000;
    const expires = new Date(Math.min(Math.max(until, now + 60_000), now + push.maxExpiration * 1000));

    const existing = await push.store.find(ctx.user.id, topic, pushResource);
    const registration: PushRegistration = {
        id: existing?.id ?? push.newRegistrationId(),
        topic,
        principal: ctx.user.id,
        pushResource,
        publicKey,
        authSecret,
        contentUpdate: content ? (content === '0' ? '0' : '1') : undefined,
        propertyUpdate: property ? '0' : undefined,
        expires,
    };
    await push.store.save(registration);
    return {
        status: existing ? 204 : 201,
        headers: {Location: registrationUrl(ctx, registration.id), Expires: expires.toUTCString()},
    };
}

export const registrationUrl = (ctx: Context, id: string): string => `${ctx.origin}${ctx.base}/push/${encodeURIComponent(id)}`;

/** DELETE of a registration URL. */
export async function handlePushUnregister(ctx: Context, id: string): Promise<CalDavResponse> {
    const push = ctx.push;
    if (!push) throw CalDavError.notFound();
    const registration = await push.store.get(id);
    if (!registration) throw CalDavError.notFound();
    if (registration.principal !== ctx.user.id) throw CalDavError.forbidden('not your registration');
    await push.store.remove(id);
    return {status: 204, headers: {}};
}

/** Registration ids of the Push-Dont-Notify header; null for `*` (notify nobody). */
function dontNotify(ctx: Context, req: ParsedRequest): Set<string> | null {
    const value = header(req, 'push-dont-notify');
    if (!value) return new Set();
    if (value.trim() === '*') return null;
    const ids = new Set<string>();
    for (const m of value.matchAll(/"([^"]+)"/g)) {
        const id = /\/push\/([^/?#]+)$/.exec(m[1]!)?.[1];
        if (id) ids.add(decodeURIComponent(id));
    }
    return ids;
}

/** What a successful request changed, for notifications. */
interface Changed {
    calendars: {id: string; content: boolean; properties: boolean}[];
    home: boolean;
}

function changedBy(ctx: Context, method: string, path: string, destination: string | undefined): Changed {
    const changed: Changed = {calendars: [], home: false};
    const add = (p: string | undefined, content: boolean, properties: boolean) => {
        const segs = p ? ctx.segments(p) : null;
        if (!segs || segs[0] !== 'calendars' || segs[1] !== ctx.principal.id) return;
        if (segs.length === 3) {
            if (content || properties) changed.calendars.push({id: segs[2]!, content, properties});
        } else if (segs.length === 4) {
            changed.calendars.push({id: segs[2]!, content: true, properties: false});
        }
    };
    const segs = ctx.segments(path);
    const isCalendar = segs?.[0] === 'calendars' && segs.length === 3;
    switch (method) {
        case 'PUT':
        case 'POST':
            add(path, true, false);
            break;
        case 'DELETE':
            if (isCalendar) changed.home = true;
            else add(path, true, false);
            break;
        case 'PROPPATCH':
            if (isCalendar) add(path, false, true);
            break;
        case 'MKCALENDAR':
        case 'MKCOL':
            changed.home = true;
            break;
        case 'MOVE':
        case 'COPY':
            if (isCalendar) changed.home = true;
            else {
                if (method === 'MOVE') add(path, true, false);
                add(destination, true, false);
            }
            break;
    }
    return changed;
}

/**
 * Sends notifications for a successful change, in the background (draft: asynchronously).
 * Sync tokens come from a fresh `listCalendars`.
 */
export function notifyAfterChange(ctx: Context, req: ParsedRequest, method: string, path: string, onError: (e: unknown) => void): void {
    const push = ctx.push;
    if (!push) return;
    // Of the POSTs only attachments change a calendar's content.
    if (method === 'POST' && !new URL(req.url, 'http://x').searchParams.get('action')?.startsWith('attachment-')) return;
    const exclude = dontNotify(ctx, req);
    if (exclude === null) return;
    let destination: string | undefined;
    try {
        const value = header(req, 'destination');
        destination = value ? new URL(value, 'http://x').pathname : undefined;
    } catch {
        destination = undefined;
    }
    const changed = changedBy(ctx, method, path, destination);
    if (!changed.home && !changed.calendars.length) return;
    void (async () => {
        if (changed.home) await push.notify(homeTopic(ctx.principal.id), {content: true}, exclude);
        if (!changed.calendars.length) return;
        const calendars: Calendar[] = await ctx.provider.listCalendars(ctx.principal);
        for (const c of changed.calendars) {
            const calendar = calendars.find((x) => x.id === c.id);
            if (!calendar) continue;
            await push.notify(
                calendarTopic(ctx.principal.id, calendar),
                {content: c.content, properties: c.properties, syncToken: c.content ? syncTokenUri(calendar.syncToken) : undefined},
                exclude,
            );
        }
    })().catch(onError);
}
