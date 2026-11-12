import {createCipheriv, createECDH, createHash, createPrivateKey, createSign, generateKeyPairSync, hkdfSync, randomBytes, randomUUID} from 'node:crypto';
import {syncTokenUri} from './context.ts';
import type {Calendar} from './types.ts';

/*
 * WebDAV-Push (draft-bitfire-webdav-push) over Web Push: VAPID (RFC 8292) and
 * aes128gcm message encryption (RFC 8291), with node:crypto only.
 */

export const PUSH_NS = 'https://bitfire.at/webdav-push';

export type PushDepth = '0' | '1' | 'infinity';

/** A registered Web Push subscription of one collection. */
export interface PushRegistration {
    /** URL-safe id; part of the registration URL `<basePath>/push/<id>`. */
    id: string;
    /** Push topic of the subscribed collection. */
    topic: string;
    /** Id of the principal who registered it; only they can remove it. */
    principal: string;
    /** Push resource (the push service endpoint). */
    pushResource: string;
    /** User agent public key (p256dh), base64url. */
    publicKey: string;
    /** Authentication secret, base64url. */
    authSecret: string;
    /** Requested triggers, as far as supported. */
    contentUpdate?: PushDepth;
    propertyUpdate?: PushDepth;
    expires: Date;
}

/** Where registrations live; shared by all server instances. */
export interface PushStore {
    /** Insert or replace by `id`. */
    save(registration: PushRegistration): Promise<void>;
    remove(id: string): Promise<void>;
    get(id: string): Promise<PushRegistration | null>;
    /** Unexpired registrations of a topic. */
    list(topic: string): Promise<PushRegistration[]>;
    /** The registration of a principal for a topic and push resource, to update it in place. */
    find(principal: string, topic: string, pushResource: string): Promise<PushRegistration | null>;
}

/** Registrations in memory, for a single server instance. */
export class MemoryPushStore implements PushStore {
    private readonly items = new Map<string, PushRegistration>();

    private live(): PushRegistration[] {
        const now = Date.now();
        for (const [id, r] of this.items) if (r.expires.getTime() <= now) this.items.delete(id);
        return [...this.items.values()];
    }

    async save(registration: PushRegistration): Promise<void> {
        this.items.set(registration.id, {...registration});
    }

    async remove(id: string): Promise<void> {
        this.items.delete(id);
    }

    async get(id: string): Promise<PushRegistration | null> {
        return this.live().find((r) => r.id === id) ?? null;
    }

    async list(topic: string): Promise<PushRegistration[]> {
        return this.live().filter((r) => r.topic === topic);
    }

    async find(principal: string, topic: string, pushResource: string): Promise<PushRegistration | null> {
        return this.live().find((r) => r.principal === principal && r.topic === topic && r.pushResource === pushResource) ?? null;
    }
}

export interface VapidKeys {
    /** Uncompressed P-256 public key, base64url (65 bytes). */
    publicKey: string;
    /** Private key `d`, base64url (32 bytes). */
    privateKey: string;
}

/** A new VAPID key pair; store it, clients bind their subscriptions to it. */
export function generateVapidKeys(): VapidKeys {
    const {publicKey, privateKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    const jwk = privateKey.export({format: 'jwk'});
    const pub = publicKey.export({format: 'jwk'});
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]);
    return {publicKey: raw.toString('base64url'), privateKey: jwk.d!};
}

const b64 = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');

/** An opaque topic; it is sent to push services, so it mustn't reveal ids. */
const opaque = (value: string): string => createHash('sha256').update(value).digest('base64url').slice(0, 22);

/** Push topic of a calendar: the same for everybody with `globalId`, else per principal. */
export function calendarTopic(principalId: string, calendar: Pick<Calendar, 'id' | 'globalId'>): string {
    return opaque(calendar.globalId ? `calendar:${calendar.globalId}` : `calendar:${principalId}/${calendar.id}`);
}

/** Push topic of a principal's calendar home. */
export function homeTopic(principalId: string): string {
    return opaque(`home:${principalId}`);
}

/** RFC 8291: encrypts a payload for a subscription (aes128gcm, one record). */
export function encryptPayload(payload: Uint8Array, publicKey: string, authSecret: string): Buffer {
    const uaPublic = Buffer.from(publicKey, 'base64url');
    const auth = Buffer.from(authSecret, 'base64url');
    const ecdh = createECDH('prime256v1');
    const asPublic = ecdh.generateKeys();
    const ecdhSecret = ecdh.computeSecret(uaPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, auth, keyInfo, 32));
    const salt = randomBytes(16);
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    // A single record: payload plus the last-record delimiter 0x02.
    const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, encrypted]);
}

export interface WebDavPushOptions {
    store: PushStore;
    vapid: VapidKeys;
    /** Contact for push services, `mailto:` or `https:` (VAPID `sub`). */
    subject: string;
    /** Longest registration in seconds. Default 7 days. */
    maxExpiration?: number;
    /** Registrations without `expires` last this long, in seconds. Default 3 days. */
    defaultExpiration?: number;
    /** HTTP client, for tests or proxies. Default `fetch`. */
    fetch?: typeof fetch;
    /** Called when a push message could not be delivered. */
    onError?: (error: unknown, registration: PushRegistration) => void;
}

export interface PushChange {
    /** Content of the collection changed; with the new sync token if known. */
    content?: boolean;
    /** Properties of the collection changed. */
    properties?: boolean;
    /** `DAV:sync-token` for the message, e.g. `syncTokenUri(calendar.syncToken)`. */
    syncToken?: string;
}

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);

/**
 * WebDAV-Push for the server: pass it as `push` option, and call `notifyCalendar` /
 * `notifyHome` when data changes outside of CalDAV. Changes made through CalDAV notify by
 * themselves.
 */
export class WebDavPush {
    readonly store: PushStore;
    readonly vapidPublicKey: string;
    readonly maxExpiration: number;
    readonly defaultExpiration: number;
    private readonly options: WebDavPushOptions;
    private readonly jwts = new Map<string, {token: string; until: number}>();

    constructor(options: WebDavPushOptions) {
        this.options = options;
        this.store = options.store;
        this.vapidPublicKey = options.vapid.publicKey;
        this.maxExpiration = options.maxExpiration ?? 7 * 86400;
        this.defaultExpiration = options.defaultExpiration ?? 3 * 86400;
    }

    /** VAPID JWT for an audience (origin of the push service), cached for an hour. */
    private vapidToken(audience: string): string {
        const cached = this.jwts.get(audience);
        if (cached && cached.until > Date.now()) return cached.token;
        const pub = Buffer.from(this.options.vapid.publicKey, 'base64url');
        const key = createPrivateKey({
            format: 'jwk',
            key: {kty: 'EC', crv: 'P-256', d: this.options.vapid.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65))},
        });
        const header = b64(Buffer.from(JSON.stringify({typ: 'JWT', alg: 'ES256'})));
        const claims = b64(Buffer.from(JSON.stringify({aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.options.subject})));
        const signature = createSign('SHA256').update(`${header}.${claims}`).sign({key, dsaEncoding: 'ieee-p1363'});
        const token = `${header}.${claims}.${b64(signature)}`;
        this.jwts.set(audience, {token, until: Date.now() + 3600_000});
        return token;
    }

    /** The push message of the draft. */
    static message(topic: string, change: PushChange): string {
        const content = change.content
            ? change.syncToken
                ? `<content-update><D:sync-token>${escapeXml(change.syncToken)}</D:sync-token></content-update>`
                : '<content-update/>'
            : '';
        return `<?xml version="1.0" encoding="utf-8"?>\n<push-message xmlns="${PUSH_NS}" xmlns:D="DAV:"><topic>${escapeXml(topic)}</topic>${content}${change.properties ? '<property-update/>' : ''}</push-message>`;
    }

    /** Sends a push message to one registration. Returns false if the push service rejected it. */
    async send(registration: PushRegistration, message: string): Promise<boolean> {
        const body = encryptPayload(Buffer.from(message, 'utf8'), registration.publicKey, registration.authSecret);
        const audience = new URL(registration.pushResource).origin;
        const res = await (this.options.fetch ?? fetch)(registration.pushResource, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/xml; charset="UTF-8"',
                'Content-Encoding': 'aes128gcm',
                TTL: '86400',
                Urgency: 'normal',
                Topic: opaque(registration.topic),
                Authorization: `vapid t=${this.vapidToken(audience)}, k=${this.vapidPublicKey}`,
            },
            body,
        });
        // 404/410: the subscription is gone (RFC 8030 7.3).
        if (res.status === 404 || res.status === 410) await this.store.remove(registration.id);
        return res.ok;
    }

    /**
     * Notifies all registrations of a topic whose triggers match the change. `exclude` holds
     * registration ids that must not be notified (Push-Dont-Notify).
     */
    async notify(topic: string, change: PushChange, exclude: ReadonlySet<string> = new Set()): Promise<void> {
        const registrations = await this.store.list(topic);
        const message = WebDavPush.message(topic, change);
        await Promise.all(
            registrations
                .filter((r) => !exclude.has(r.id))
                .filter((r) => (change.content && r.contentUpdate) || (change.properties && r.propertyUpdate))
                .map((r) =>
                    this.send(r, message).catch((e) => {
                        this.options.onError?.(e, r);
                        return false;
                    }),
                ),
        );
    }

    /** A calendar's objects or properties changed outside of CalDAV. */
    notifyCalendar(principalId: string, calendar: Calendar, change: {content?: boolean; properties?: boolean} = {content: true}): Promise<void> {
        return this.notify(calendarTopic(principalId, calendar), {...change, syncToken: change.content ? syncTokenUri(calendar.syncToken) : undefined});
    }

    /** Calendars were added or removed for a principal. */
    notifyHome(principalId: string): Promise<void> {
        return this.notify(homeTopic(principalId), {content: true});
    }

    newRegistrationId(): string {
        return randomUUID();
    }
}
