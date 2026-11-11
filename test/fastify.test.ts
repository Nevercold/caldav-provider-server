import Fastify from 'fastify';
import {describe, expect, it} from 'vitest';
import {caldav} from '../src/fastify.ts';
import {ics, PROPFIND, setup} from './helpers.ts';

const auth = {authorization: `Basic ${btoa('alice:pw')}`};

async function app() {
    const {provider} = setup();
    const fastify = Fastify();
    // A JSON route of the host application must keep working.
    fastify.post('/api/echo', async (req) => req.body);
    await fastify.register(caldav, {provider});
    await fastify.ready();
    return fastify;
}

describe('Fastify plugin', () => {
    it('routes WebDAV methods and passes XML bodies through', async () => {
        const f = await app();
        const res = await f.inject({
            method: 'PROPFIND',
            url: '/dav/calendars/alice/',
            headers: {...auth, depth: '1', 'content-type': 'application/xml; charset=utf-8'},
            payload: PROPFIND('<d:displayname/>'),
        });
        expect(res.statusCode).toBe(207);
        expect(res.body).toContain('<d:displayname>Personal</d:displayname>');
    });

    it('accepts bodies without content type and with text/xml', async () => {
        const f = await app();
        for (const headers of [{}, {'content-type': 'text/xml'}]) {
            const res = await f.inject({
                method: 'REPORT',
                url: '/dav/calendars/alice/personal/',
                headers: {...auth, depth: '1', ...headers},
                payload: '<d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:prop><d:getetag/></d:prop></d:sync-collection>',
            });
            expect(res.statusCode).toBe(207);
        }
    });

    it('PUT, GET and HEAD of calendar objects', async () => {
        const f = await app();
        const body = ics('VTODO', 't1', 'SUMMARY:Test');
        const put = await f.inject({
            method: 'PUT',
            url: '/dav/calendars/alice/todos/t1.ics',
            headers: {...auth, 'content-type': 'text/calendar; charset=utf-8'},
            payload: body,
        });
        expect(put.statusCode).toBe(201);
        const get = await f.inject({method: 'GET', url: '/dav/calendars/alice/todos/t1.ics', headers: auth});
        expect(get.body).toBe(body);
        expect(get.headers.etag).toBe(put.headers.etag);
        const head = await f.inject({method: 'HEAD', url: '/dav/calendars/alice/todos/t1.ics', headers: auth});
        expect(head.statusCode).toBe(200);
        expect(head.body).toBe('');
    });

    it('well-known redirect, OPTIONS and 401', async () => {
        const f = await app();
        const wk = await f.inject({method: 'PROPFIND', url: '/.well-known/caldav'});
        expect(wk.statusCode).toBe(301);
        expect(wk.headers.location).toBe('/dav/');
        const opt = await f.inject({method: 'OPTIONS', url: '/dav/'});
        expect(opt.headers.dav).toContain('calendar-access');
        const unauth = await f.inject({method: 'PROPFIND', url: '/dav/'});
        expect(unauth.statusCode).toBe(401);
        expect(unauth.headers['www-authenticate']).toContain('Basic');
    });

    it('does not touch the content type parsers of the host app', async () => {
        const f = await app();
        const res = await f.inject({method: 'POST', url: '/api/echo', payload: {a: 1}});
        expect(res.json()).toEqual({a: 1});
    });
});
