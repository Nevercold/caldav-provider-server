import {createHash} from 'node:crypto';
import {type Context, normalizeAddress, notificationName, type Resource} from './context.ts';
import {CalDavError} from './errors.ts';
import {type CalDavResponse, xmlResponse} from './http.ts';
import type {Invitation, ShareAccess, ShareChanges, ShareStatus} from './types.ts';
import {cal, child, children, d, el, is, NS, serialize, textOf, type XmlElement, type XNode} from './xml.ts';

/*
 * Calendar sharing in CalendarServer's model (caldav-sharing.txt), which Apple Calendar uses:
 * the owner POSTs CS:share to the calendar, sharees find the invitation in their notification
 * collection and POST CS:invite-reply to their calendar home.
 */

const cs = (name: string, ...kids: Parameters<typeof el>[2][]): XNode => el(NS.CS, name, ...kids);

const accessNode = (access: ShareAccess): XNode => cs('access', cs(access === 'read-write' ? 'read-write' : 'read'));

const statusNode = (status: ShareStatus): XNode =>
    cs(status === 'accepted' ? 'invite-accepted' : status === 'declined' ? 'invite-declined' : 'invite-noresponse');

const mailto = (address: string): string => normalizeAddress(address);

/** The CS:invite property of a shared calendar: organizer and sharees. */
export async function inviteProperty(ctx: Context, r: Resource): Promise<XNode[] | undefined> {
    const sharing = ctx.provider.sharing;
    if (!sharing || r.kind !== 'calendar') return undefined;
    const c = r.calendar;
    if (c.sharedBy) {
        const owner = c.sharedBy;
        return [cs('organizer', d('href', `${ctx.principalsHref()}${encodeURIComponent(owner.id)}/`), cs('common-name', owner.displayName ?? owner.id))];
    }
    if (!c.shared) return [];
    const sharees = await sharing.sharees(ctx.principal, c);
    return [
        cs('organizer', d('href', ctx.principalHref()), cs('common-name', ctx.principal.displayName ?? ctx.principal.id)),
        ...sharees.map((s) =>
            cs('user', d('href', mailto(s.address)), s.displayName ? cs('common-name', s.displayName) : null, statusNode(s.status), accessNode(s.access)),
        ),
    ];
}

/** ETag of a notification: changes with the invitation's status and access. */
export const notificationEtag = (i: Invitation): string =>
    createHash('sha1').update(JSON.stringify([i.id, i.status, i.access, i.summary ?? ''])).digest('base64url').slice(0, 16);

/** The XML body of an invitation (CS:invite-notification). */
export function notificationBody(ctx: Context, i: Invitation): string {
    const owner = i.owner;
    const ownerAddress = owner.addresses.find((a) => /^mailto:/i.test(a)) ?? owner.addresses[0];
    return serialize(
        cs(
            'notification',
            cs('dtstamp', (i.created ?? new Date(0)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')),
            {
                ...cs(
                    'invite-notification',
                    cs('uid', i.id),
                    d('href', mailto(i.address)),
                    statusNode(i.status),
                    accessNode(i.access),
                    cs('hosturl', d('href', `${ctx.base}/calendars/${encodeURIComponent(owner.id)}/${encodeURIComponent(i.calendarId)}/`)),
                    cs(
                        'organizer',
                        d('href', ownerAddress ? mailto(ownerAddress) : `${ctx.principalsHref()}${encodeURIComponent(owner.id)}/`),
                        cs('common-name', owner.displayName ?? owner.id),
                    ),
                    i.summary ? cs('summary', i.summary) : null,
                    i.components
                        ? cal('supported-calendar-component-set', ...i.components.map((name) => ({ns: NS.CALDAV, name: 'comp', attrs: {name}, children: []})))
                        : null,
                ),
                attrs: {'shared-type': 'calendar'},
            },
        ),
    );
}

/** Stateless sync token of the notification collection: ids and ETags of all invitations. */
export function notificationsSyncToken(list: Invitation[]): string {
    const map = Object.fromEntries(list.map((i) => [notificationName(i), notificationEtag(i)]));
    return `notif:${Buffer.from(JSON.stringify(map)).toString('base64url')}`;
}

export function parseNotificationsSyncToken(token: string): Record<string, string> | null {
    if (!token.startsWith('notif:')) return null;
    try {
        const map = JSON.parse(Buffer.from(token.slice(6), 'base64url').toString('utf8'));
        return map && typeof map === 'object' && !Array.isArray(map) ? (map as Record<string, string>) : null;
    } catch {
        return null;
    }
}

/** POST CS:share to a calendar: the owner invites, changes or removes sharees. */
export async function handleShare(ctx: Context, r: Extract<Resource, {kind: 'calendar'}>, root: XmlElement): Promise<CalDavResponse> {
    const sharing = ctx.provider.sharing;
    if (!sharing || !ctx.writable) throw CalDavError.forbidden('sharing is not allowed');
    if (r.calendar.sharedBy) throw CalDavError.forbidden('a shared calendar cannot be shared further');
    const changes: ShareChanges = {set: [], remove: []};
    for (const op of children(root)) {
        const address = textOf(child(op, NS.DAV, 'href'));
        if (!address) continue;
        if (is(op, NS.CS, 'set')) {
            changes.set.push({
                address: mailto(address),
                displayName: textOf(child(op, NS.CS, 'common-name')) || undefined,
                summary: textOf(child(op, NS.CS, 'summary')) || undefined,
                access: child(op, NS.CS, 'read-write') ? 'read-write' : 'read',
            });
        } else if (is(op, NS.CS, 'remove')) {
            changes.remove.push(mailto(address));
        }
    }
    await sharing.share(ctx.principal, r.calendar, changes);
    return {status: 200, headers: {}};
}

/** POST CS:invite-reply to the calendar home: the sharee accepts or declines. */
export async function handleInviteReply(ctx: Context, root: XmlElement): Promise<CalDavResponse> {
    const sharing = ctx.provider.sharing;
    if (!sharing?.replyToInvitation || !ctx.writable) throw CalDavError.forbidden('invitations cannot be answered here');
    const id = textOf(child(root, NS.CS, 'in-reply-to'));
    const accept = !!child(root, NS.CS, 'invite-accepted');
    if (!id || (!accept && !child(root, NS.CS, 'invite-declined'))) throw new CalDavError(400, 'invalid invite-reply');
    if (!(await ctx.invitations()).some((i) => i.id === id)) throw CalDavError.notFound('unknown invitation');
    const calendarId = await sharing.replyToInvitation(ctx.principal, id, accept);
    if (!accept || !calendarId) return {status: 200, headers: {}};
    return xmlResponse(200, cs('shared-as', d('href', ctx.calendarHref({id: calendarId}))));
}
