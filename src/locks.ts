import {randomUUID} from 'node:crypto';
import type {Context} from './context.ts';
import {CalDavError} from './errors.ts';
import {type CalDavResponse, header, type ParsedRequest, parseBody, xmlResponse} from './http.ts';
import type {Lock, LockProvider} from './types.ts';
import {child, children, d, is, NS, textOf, type XNode} from './xml.ts';

/*
 * WebDAV locking (RFC 4918 6, 9.10, 9.11). Locks are stored by the provider so that
 * every instance sees them; this module checks them before changes.
 */

const DEFAULT_TIMEOUT = 3600;
const MAX_TIMEOUT = 24 * 3600;

/** Locks in memory, for a single server instance. */
export class MemoryLocks implements LockProvider {
    private readonly locks = new Map<string, Lock>();

    private live(): Lock[] {
        const now = Date.now();
        for (const [token, lock] of this.locks) if (lock.expires.getTime() <= now) this.locks.delete(token);
        return [...this.locks.values()];
    }

    async find(paths: string[]): Promise<Lock[]> {
        return this.live().filter((l) => paths.includes(l.path));
    }

    async findBelow(path: string): Promise<Lock[]> {
        return this.live().filter((l) => l.path.startsWith(path));
    }

    async save(lock: Lock): Promise<void> {
        this.locks.set(lock.token, {...lock});
    }

    async remove(token: string): Promise<void> {
        this.locks.delete(token);
    }
}

/** Request path in the encoding hrefs use, so locks match however a client encodes a URL. */
export function canonicalPath(ctx: Context, path: string): string {
    const segs = ctx.segments(path);
    if (!segs) return path;
    const joined = segs.map((s) => encodeURIComponent(s)).join('/');
    return `${ctx.base}/${joined}${joined && path.endsWith('/') ? '/' : ''}`;
}

/** The path and its parent collections. */
function withAncestors(path: string): string[] {
    const out = [path];
    let p = path.endsWith('/') ? path.slice(0, -1) : path;
    while (p.lastIndexOf('/') > 0) {
        p = p.slice(0, p.lastIndexOf('/'));
        out.push(`${p}/`);
    }
    return out;
}

/**
 * The key a lock is stored under: the URL path, or `calendar:<globalId>/<name>` inside a
 * calendar with a `globalId`, so that every URL of a shared calendar meets the same lock.
 */
interface LockTarget {
    /** Key of the resource itself. */
    key: string;
    /** Keys of the collections above it. */
    parents: string[];
    /** Its URL path, for lockroot. */
    href: string;
}

async function lockTarget(ctx: Context, path: string): Promise<LockTarget> {
    const href = canonicalPath(ctx, path);
    const urls = withAncestors(href);
    const segs = ctx.segments(path);
    if (segs && segs[0] === 'calendars' && segs.length >= 3 && segs[1] === ctx.principal.id) {
        const calendar = await ctx.calendar(segs[2]!).catch(() => undefined);
        if (calendar?.globalId) {
            const calKey = `calendar:${encodeURIComponent(calendar.globalId)}/`;
            const name = segs[3];
            const above = urls.filter((u) => u.length < ctx.calendarHref(calendar).length);
            return name === undefined
                ? {key: calKey, parents: above, href}
                : {key: `${calKey}${encodeURIComponent(name)}`, parents: [calKey, ...above], href};
        }
    }
    return {key: href, parents: urls.slice(1), href};
}

/** Locks that cover a resource: on itself, or Depth infinity on a parent. */
async function covering(locks: LockProvider, target: LockTarget): Promise<Lock[]> {
    const found = await locks.find([target.key, ...target.parents]);
    return found.filter((l) => l.path === target.key || l.depth === 'infinity');
}

/** The URL a lock was taken on, as seen from `target`. */
function rootHref(lock: Lock, target: LockTarget): string {
    if (lock.path.startsWith('/')) return lock.path;
    if (lock.path === target.key) return target.href;
    // A calendar lock seen from one of its objects.
    return target.href.slice(0, target.href.lastIndexOf('/') + 1);
}

/** Lock tokens in the If header (RFC 4918 10.4). */
function submittedTokens(req: ParsedRequest): Set<string> {
    const value = header(req, 'if') ?? '';
    return new Set([...value.matchAll(/<((?:urn:uuid|opaquelocktoken):[^>]+)>/gi)].map((m) => m[1]!));
}

/**
 * Throws 423 unless the request submits the tokens of all locks on the paths (and, with
 * `recursive`, below them). Only the lock's holder can use its token.
 */
export async function checkLocks(ctx: Context, req: ParsedRequest, paths: string[], recursive = false): Promise<void> {
    const locks = ctx.provider.locks;
    if (!locks) return;
    const tokens = submittedTokens(req);
    for (const path of paths) {
        const target = await lockTarget(ctx, path);
        const relevant = [...(await covering(locks, target)), ...(recursive ? await locks.findBelow(target.key) : [])];
        const byRoot = new Map<string, Lock[]>();
        for (const l of relevant) byRoot.set(l.path, [...(byRoot.get(l.path) ?? []), l]);
        for (const group of byRoot.values()) {
            // One token per locked resource is enough; shared locks share the resource.
            if (!group.some((l) => tokens.has(l.token) && l.principal === ctx.user.id)) {
                throw CalDavError.dav(423, 'lock-token-submitted', `${rootHref(group[0]!, target)} is locked`);
            }
        }
    }
}

function parseTimeout(value: string | undefined): number {
    for (const part of (value ?? '').split(',').map((p) => p.trim())) {
        if (/^infinite$/i.test(part)) return MAX_TIMEOUT;
        const m = /^Second-(\d+)$/i.exec(part);
        if (m) return Math.min(Math.max(Number(m[1]), 1), MAX_TIMEOUT);
    }
    return DEFAULT_TIMEOUT;
}

function activeLock(lock: Lock, root: string): XNode {
    return d(
        'activelock',
        d('locktype', d('write')),
        d('lockscope', d(lock.scope)),
        d('depth', lock.depth),
        lock.owner ? d('owner', /^[a-z][a-z0-9+.-]*:/i.test(lock.owner) ? d('href', lock.owner) : lock.owner) : null,
        d('timeout', `Second-${Math.max(0, Math.round((lock.expires.getTime() - Date.now()) / 1000))}`),
        d('locktoken', d('href', lock.token)),
        d('lockroot', d('href', root)),
    );
}

/** DAV:lockdiscovery of a path. */
export async function lockDiscovery(ctx: Context, path: string): Promise<XNode[] | undefined> {
    const locks = ctx.provider.locks;
    if (!locks) return undefined;
    const target = await lockTarget(ctx, path);
    return (await covering(locks, target)).map((l) => activeLock(l, rootHref(l, target)));
}

export function supportedLock(): XNode[] {
    const entry = (scope: string) => d('lockentry', d('lockscope', d(scope)), d('locktype', d('write')));
    return [entry('exclusive'), entry('shared')];
}

/** LOCK: a new lock with a lockinfo body, a refresh without one. */
export async function handleLock(ctx: Context, req: ParsedRequest, path: string, exists: boolean): Promise<CalDavResponse> {
    const locks = ctx.provider.locks;
    if (!locks) throw new CalDavError(405, 'locking is not supported');
    const target = await lockTarget(ctx, path);
    const href = target.href;
    const timeoutSeconds = parseTimeout(header(req, 'timeout'));
    const root = parseBody(req);

    if (!root) {
        const tokens = submittedTokens(req);
        const lock = (await covering(locks, target)).find((l) => tokens.has(l.token) && l.principal === ctx.user.id);
        if (!lock) throw CalDavError.preconditionFailed('no lock to refresh');
        const refreshed = {...lock, timeoutSeconds, expires: new Date(Date.now() + timeoutSeconds * 1000)};
        await locks.save(refreshed);
        return xmlResponse(200, d('prop', d('lockdiscovery', activeLock(refreshed, rootHref(refreshed, target)))));
    }

    if (!is(root, NS.DAV, 'lockinfo')) throw new CalDavError(400, 'expected DAV:lockinfo');
    // Locking an unmapped URL would have to create an empty resource, which a calendar can't hold.
    if (!exists) throw new CalDavError(409, 'only existing resources can be locked');
    const scope = child(child(root, NS.DAV, 'lockscope'), NS.DAV, 'shared') ? 'shared' : 'exclusive';
    const ownerEl = child(root, NS.DAV, 'owner');
    const owner = ownerEl ? textOf(child(ownerEl, NS.DAV, 'href')) || textOf(ownerEl) || undefined : undefined;
    const depthHeader = header(req, 'depth')?.trim().toLowerCase();
    if (depthHeader !== undefined && depthHeader !== '0' && depthHeader !== 'infinity') throw new CalDavError(400, 'Depth must be 0 or infinity');
    const depth = href.endsWith('/') && depthHeader !== '0' ? 'infinity' : '0';
    if (!children(child(root, NS.DAV, 'locktype')).some((c) => is(c, NS.DAV, 'write'))) throw new CalDavError(400, 'only write locks exist');

    const existing = [...(await covering(locks, target)), ...(depth === 'infinity' ? await locks.findBelow(target.key) : [])];
    if (existing.some((l) => l.scope === 'exclusive') || (scope === 'exclusive' && existing.length)) {
        throw CalDavError.dav(423, 'no-conflicting-lock', 'the resource is locked');
    }
    const lock: Lock = {
        token: `urn:uuid:${randomUUID()}`,
        path: target.key,
        principal: ctx.user.id,
        scope,
        depth,
        owner,
        timeoutSeconds,
        expires: new Date(Date.now() + timeoutSeconds * 1000),
    };
    await locks.save(lock);
    return xmlResponse(200, d('prop', d('lockdiscovery', activeLock(lock, href))), {'Lock-Token': `<${lock.token}>`});
}

export async function handleUnlock(ctx: Context, req: ParsedRequest, path: string): Promise<CalDavResponse> {
    const locks = ctx.provider.locks;
    if (!locks) throw new CalDavError(405, 'locking is not supported');
    const token = /<([^>]+)>/.exec(header(req, 'lock-token') ?? '')?.[1];
    if (!token) throw new CalDavError(400, 'UNLOCK needs a Lock-Token header');
    const lock = (await covering(locks, await lockTarget(ctx, path))).find((l) => l.token === token);
    if (!lock) throw CalDavError.dav(409, 'lock-token-matches-request-uri', 'no such lock on this resource');
    if (lock.principal !== ctx.user.id) throw CalDavError.forbidden('the lock belongs to somebody else');
    await locks.remove(token);
    return {status: 204, headers: {}};
}
