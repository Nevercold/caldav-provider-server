import {createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {MemoryProvider} from '../example/memory-provider.ts';
import {createCalDavHandler, generateVapidKeys, MemoryPushStore, WebDavPush} from '../src/index.ts';
import {asText, ics, PROPFIND, props, setup} from './helpers.ts';

const fixture = (file: string) => readFileSync(join(import.meta.dirname, 'fixtures', file), 'utf8');

// The user agent key pair and auth secret the fixture was generated with.
const UA = {
    publicKey: 'BL2j-sR0a3thFJcmiRlLLjtospIJZE_dPXUWx7Kkf18BicS5SzPLROYPqR-wMbNfvztkhnu4L5rpxjrZ-XZLrfw',
    privateKey: '0C3Jf3JhVjF0MakoBBDHDp53U7DmBCxPuKbZyv79LRc',
    auth: 'tH-bsNctnKmZCkkPDYN5cw',
};
const ENDPOINT = 'https://push.example.com/up/AbC123';

/** RFC 8291 decryption, as the user agent does it. */
function decrypt(body: Uint8Array): string {
    const buf = Buffer.from(body);
    const salt = buf.subarray(0, 16);
    const idlen = buf[20]!;
    const asPublic = buf.subarray(21, 21 + idlen);
    const ciphertext = buf.subarray(21 + idlen);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(UA.privateKey, 'base64url'));
    const secret = ecdh.computeSecret(asPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(UA.publicKey, 'base64url'), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', secret, Buffer.from(UA.auth, 'base64url'), keyInfo, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    expect(plain.at(-1)).toBe(2);
    return plain.subarray(0, -1).toString('utf8');
}

function pushSetup(status = 201) {
    const s = setup();
    const vapid = generateVapidKeys();
    const sent: {url: string; headers: Record<string, string>; body: Uint8Array}[] = [];
    const fakeFetch = (async (url: string, init: {headers: Record<string, string>; body: Uint8Array}) => {
        sent.push({url, headers: init.headers, body: init.body});
        return new Response(null, {status});
    }) as unknown as typeof fetch;
    const push = new WebDavPush({store: new MemoryPushStore(), vapid, subject: 'mailto:admin@example.com', fetch: fakeFetch});
    const handle = createCalDavHandler({provider: s.provider, push, origin: 'https://cal.example.com', onError: (e) => console.error(e)});
    const request = async (method: string, url: string, init: {user?: string; body?: string; headers?: Record<string, string>} = {}) =>
        asText(
            await handle({
                method,
                url,
                body: init.body,
                headers: {authorization: `Basic ${Buffer.from(`${init.user ?? 'alice'}:pw`).toString('base64')}`, ...init.headers},
            }),
        );
    const register = (url: string, user = 'alice') =>
        request('POST', url, {user, body: fixture('davx5/17-post-push-register.xml'), headers: {'content-type': 'application/xml; charset=UTF-8'}});
    return {...s, push, vapid, sent, request, register};
}

const CAL = '/dav/calendars/alice/personal/';

describe('WebDAV-Push', () => {
    it('announces push in OPTIONS and on calendars and the home', async () => {
        const {request, vapid} = pushSetup();
        expect((await request('OPTIONS', '/dav/')).headers.DAV).toContain('webdav-push');
        const res = await request('PROPFIND', '/dav/calendars/alice/', {headers: {depth: '1'}, body: fixture('davx5/05-propfind-calendar-home-depth1.xml')});
        const p = props(res);
        expect(p[CAL]!.transports).toBe(`web-push(vapid-public-key(${vapid.publicKey}))`);
        expect(p[CAL]!.topic).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(res.body).toContain('type="p256ecdsa"');
        const triggers = props(await request('PROPFIND', CAL, {headers: {depth: '0'}, body: PROPFIND('<p:supported-triggers xmlns:p="https://bitfire.at/webdav-push"/>')}));
        expect(triggers[CAL]!['supported-triggers']).toBe('content-update(depth(1)) property-update(depth(0))');
    });

    it('registers DAVx⁵ and sends an encrypted, VAPID-signed message on changes', async () => {
        const {register, request, sent, vapid} = pushSetup();
        const res = await register(CAL);
        expect(res.status).toBe(201);
        expect(res.headers.Location).toMatch(/^https:\/\/cal\.example\.com\/dav\/push\/[0-9a-f-]+$/);
        // Requested 2030, capped at 7 days.
        const expires = Date.parse(res.headers.Expires!);
        expect(expires).toBeGreaterThan(Date.now() + 6 * 86400_000);
        expect(expires).toBeLessThanOrEqual(Date.now() + 7 * 86400_000);
        const again = await register(CAL);
        expect(again.status).toBe(204);
        expect(again.headers.Location).toBe(res.headers.Location);

        expect((await request('PUT', `${CAL}a.ics`, {body: ics('VEVENT', 'a', 'DTSTART:20260601T100000Z')})).status).toBe(201);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        const msg = sent[0]!;
        expect(msg.url).toBe(ENDPOINT);
        expect(msg.headers['Content-Encoding']).toBe('aes128gcm');
        expect(msg.headers.TTL).toBe('86400');

        const topic = props(await request('PROPFIND', CAL, {headers: {depth: '0'}, body: PROPFIND('<p:topic xmlns:p="https://bitfire.at/webdav-push"/>')}))[CAL]!.topic!;
        const token = props(await request('PROPFIND', CAL, {headers: {depth: '0'}, body: PROPFIND('<d:sync-token/>')}))[CAL]!['sync-token']!;
        const xml = decrypt(msg.body);
        expect(xml).toContain(`<topic>${topic}</topic>`);
        expect(xml).toContain(`<content-update><D:sync-token>${token}</D:sync-token></content-update>`);
        expect(xml).not.toContain('property-update');

        // VAPID: ES256 JWT for the push service origin, signed with the server key.
        const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(msg.headers.Authorization!)!;
        expect(k).toBe(vapid.publicKey);
        const [h, c, sig] = jwt!.split('.');
        expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({aud: 'https://push.example.com', sub: 'mailto:admin@example.com'});
        const pub = Buffer.from(vapid.publicKey, 'base64url');
        const key = createPublicKey({format: 'jwk', key: {kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url')}});
        expect(createVerify('SHA256').update(`${h}.${c}`).verify({key, dsaEncoding: 'ieee-p1363'}, Buffer.from(sig!, 'base64url'))).toBe(true);
    });

    it('respects Push-Dont-Notify', async () => {
        const {register, request, sent} = pushSetup();
        const location = (await register(CAL)).headers.Location!;
        await request('PUT', `${CAL}a.ics`, {body: ics('VEVENT', 'a', 'DTSTART:20260601T100000Z'), headers: {'push-dont-notify': `"${location}"`}});
        await request('PUT', `${CAL}b.ics`, {body: ics('VEVENT', 'b', 'DTSTART:20260601T100000Z'), headers: {'push-dont-notify': '*'}});
        await new Promise((r) => setTimeout(r, 20));
        expect(sent).toHaveLength(0);
    });

    it('notifies the home on new calendars and from the backend', async () => {
        const {register, request, sent, push, provider} = pushSetup();
        expect((await register('/dav/calendars/alice/')).status).toBe(201);
        await request('MKCALENDAR', '/dav/calendars/alice/new/');
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        await register(CAL);
        const [calendar] = (await provider.listCalendars({id: 'alice', username: 'alice', password: 'pw'})).filter((c) => c.id === 'personal');
        await push.notifyCalendar('alice', calendar!);
        expect(sent).toHaveLength(2);
        expect(decrypt(sent[1]!.body)).toContain('<D:sync-token>');
    });

    it('unregisters with DELETE and forgets subscriptions the push service rejects', async () => {
        const {register, request, sent, push} = pushSetup(410);
        const location = (await register(CAL)).headers.Location!;
        const path = new URL(location).pathname;
        expect((await request('DELETE', path, {user: 'bob'})).status).toBe(403);
        await request('PUT', `${CAL}a.ics`, {body: ics('VEVENT', 'a', 'DTSTART:20260601T100000Z')});
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        // 410 Gone removed it.
        await vi.waitFor(async () => expect(await push.store.get(path.split('/').at(-1)!)).toBeNull());
        expect((await request('DELETE', path)).status).toBe(404);
        const second = new URL((await register(CAL)).headers.Location!).pathname;
        expect((await request('DELETE', second)).status).toBe(204);
    });

    it('rejects invalid subscriptions and works without push', async () => {
        const {request} = pushSetup();
        const noKeys = fixture('davx5/17-post-push-register.xml').replace(/<n1:content-encoding>.*<\/n1:auth-secret>/, '');
        const bad = await request('POST', CAL, {body: noKeys});
        expect(bad.status).toBe(403);
        expect(bad.body).toContain('invalid-subscription');
        const onObject = await request('POST', `${CAL}x.ics`, {body: fixture('davx5/17-post-push-register.xml')});
        expect(onObject.body).toContain('push-not-available');

        const plain = createCalDavHandler({provider: new MemoryProvider().addUser({id: 'u', username: 'u', password: 'pw'})});
        const opt = await plain({method: 'OPTIONS', url: '/dav/', headers: {}});
        expect(opt.headers.DAV).not.toContain('webdav-push');
    });
});
