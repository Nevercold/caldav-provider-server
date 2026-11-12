import {describe, expect, it} from 'vitest';
import {MemoryLocks} from '../src/index.ts';
import {ics, PROPFIND, props, setup, xml} from './helpers.ts';

const CAL = '/dav/calendars/alice/personal/';
const OBJ = `${CAL}a.ics`;
const EVENT = ics('VEVENT', 'a', 'DTSTART:20260601T100000Z');
const lockinfo = (scope = 'exclusive') =>
    `<?xml version="1.0" encoding="utf-8"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:${scope}/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner><d:href>mailto:alice@example.com</d:href></d:owner></d:lockinfo>`;

async function locked() {
    const s = setup();
    Object.assign(s.provider, {locks: new MemoryLocks()});
    await s.request('PUT', OBJ, {body: EVENT});
    return s;
}

const tokenOf = (res: {headers: Record<string, string>}) => /<(.+)>/.exec(res.headers['Lock-Token']!)![1]!;

describe('locking', () => {
    it('locks an object, blocks others and accepts the token', async () => {
        const {request, provider} = await locked();
        const lock = await request('LOCK', OBJ, {body: lockinfo(), headers: {timeout: 'Second-600'}});
        expect(lock.status).toBe(200);
        const token = tokenOf(lock);
        expect(token).toMatch(/^urn:uuid:/);
        const active = xml(lock).getElementsByTagNameNS('DAV:', 'activelock')[0]!;
        expect(active.getElementsByTagNameNS('DAV:', 'lockroot')[0]!.textContent).toBe(OBJ);
        expect(active.getElementsByTagNameNS('DAV:', 'timeout')[0]!.textContent).toMatch(/^Second-(600|599)$/);

        const blocked = await request('PUT', OBJ, {body: EVENT});
        expect(blocked.status).toBe(423);
        expect(blocked.body).toContain('lock-token-submitted');
        expect((await request('PUT', OBJ, {body: EVENT, headers: {if: `(<${token}>)`}})).status).toBe(204);
        // Bob, a write delegate of Alice, can't use Alice's token.
        provider.addDelegate('alice', 'bob', true);
        expect((await request('PUT', OBJ, {user: 'bob', body: EVENT, headers: {if: `(<${token}>)`}})).status).toBe(423);

        const p = props(await request('PROPFIND', OBJ, {headers: {depth: '0'}, body: PROPFIND('<d:lockdiscovery/><d:supportedlock/>')}))[OBJ]!;
        expect(p.lockdiscovery).toContain(`locktoken(href(${token}))`);
        expect(p.supportedlock).toBe('lockentry(lockscope(exclusive) locktype(write)) lockentry(lockscope(shared) locktype(write))');

        expect((await request('UNLOCK', OBJ, {headers: {'lock-token': `<${token}>`}})).status).toBe(204);
        expect((await request('PUT', OBJ, {body: EVENT})).status).toBe(204);
    });

    it('a calendar lock covers its objects, deletes and new objects', async () => {
        const {request} = await locked();
        const token = tokenOf(await request('LOCK', CAL, {body: lockinfo()}));
        expect((await request('PUT', `${CAL}b.ics`, {body: ics('VEVENT', 'b', 'DTSTART:20260601T100000Z')})).status).toBe(423);
        expect((await request('DELETE', OBJ)).status).toBe(423);
        expect((await request('MOVE', OBJ, {headers: {destination: '/dav/calendars/alice/team/a.ics'}})).status).toBe(423);
        expect((await request('DELETE', OBJ, {headers: {if: `(<${token}>)`}})).status).toBe(204);
        // Conflicting locks.
        const second = await request('LOCK', `${CAL}b.ics`, {body: lockinfo()});
        expect(second.status).toBe(409);
        await request('PUT', `${CAL}c.ics`, {body: ics('VEVENT', 'c', 'DTSTART:20260601T100000Z'), headers: {if: `(<${token}>)`}});
        const conflict = await request('LOCK', `${CAL}c.ics`, {body: lockinfo()});
        expect(conflict.status).toBe(423);
        expect(conflict.body).toContain('no-conflicting-lock');
    });

    it('with globalId a lock covers every URL of a shared calendar', async () => {
        const {request} = await locked();
        await request('PUT', '/dav/calendars/alice/todos/t.ics', {body: ics('VTODO', 't')});
        const token = tokenOf(await request('LOCK', '/dav/calendars/alice/todos/', {body: lockinfo()}));
        // Bob reaches the same calendar under his own URL.
        const bobTodo = '/dav/calendars/bob/todos/t.ics';
        expect((await request('PUT', bobTodo, {user: 'bob', body: ics('VTODO', 't')})).status).toBe(423);
        const p = props(await request('PROPFIND', bobTodo, {user: 'bob', headers: {depth: '0'}, body: PROPFIND('<d:lockdiscovery/>')}))[bobTodo]!;
        expect(p.lockdiscovery).toContain('lockroot(href(/dav/calendars/bob/todos/))');
        expect((await request('PUT', '/dav/calendars/alice/todos/t.ics', {body: ics('VTODO', 't'), headers: {if: `(<${token}>)`}})).status).toBe(204);
        expect((await request('UNLOCK', '/dav/calendars/alice/todos/', {headers: {'lock-token': `<${token}>`}})).status).toBe(204);
        expect((await request('PUT', bobTodo, {user: 'bob', body: ics('VTODO', 't')})).status).toBe(204);
    });

    it('without globalId locks belong to the URL', async () => {
        const {request, provider} = await locked();
        const list = provider.listCalendars.bind(provider);
        Object.assign(provider, {listCalendars: async (u: Parameters<typeof list>[0]) => (await list(u)).map(({globalId: _g, ...c}) => c)});
        await request('PUT', '/dav/calendars/alice/todos/t.ics', {body: ics('VTODO', 't')});
        await request('LOCK', '/dav/calendars/alice/todos/', {body: lockinfo()});
        expect((await request('PUT', '/dav/calendars/alice/todos/t.ics', {body: ics('VTODO', 't')})).status).toBe(423);
        expect((await request('PUT', '/dav/calendars/bob/todos/t.ics', {user: 'bob', body: ics('VTODO', 't')})).status).toBe(204);
    });

    it('shared locks, refresh, UNLOCK errors and support', async () => {
        const {request, provider} = await locked();
        const a = tokenOf(await request('LOCK', OBJ, {body: lockinfo('shared')}));
        expect((await request('LOCK', OBJ, {body: lockinfo('shared'), user: 'alice'})).status).toBe(200);
        expect((await request('LOCK', OBJ, {body: lockinfo('exclusive')})).status).toBe(423);

        const refresh = await request('LOCK', OBJ, {headers: {if: `(<${a}>)`, timeout: 'Second-120'}});
        expect(refresh.status).toBe(200);
        expect((await request('LOCK', OBJ, {headers: {if: '(<urn:uuid:nope>)'}})).status).toBe(412);

        expect((await request('UNLOCK', OBJ, {headers: {'lock-token': '<urn:uuid:nope>'}})).status).toBe(409);
        expect((await request('UNLOCK', OBJ)).status).toBe(400);

        expect((await request('OPTIONS', '/dav/')).headers.DAV).toMatch(/^1, 2, 3,/);
        Object.assign(provider, {locks: undefined});
        expect((await request('LOCK', OBJ, {body: lockinfo()})).status).toBe(405);
        expect((await request('PUT', OBJ, {body: EVENT})).status).toBe(204);
    });
});
