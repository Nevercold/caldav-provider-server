/**
 * Example server with an in-memory provider.
 *
 *   npm run example
 *
 * Environment:
 *   PORT      default 5232
 *   HOST      default 0.0.0.0 (so phones in the same network can connect)
 *   RECORD    directory; every request and response is written there as JSON,
 *             handy for recording fixtures from real clients
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import Fastify from 'fastify';
import {caldav} from '../src/fastify.ts';
import {generateVapidKeys, MemoryPushStore, WebDavPush} from '../src/index.ts';
import {MemoryProvider} from './memory-provider.ts';

const port = Number(process.env.PORT ?? 5232);
const host = process.env.HOST ?? '0.0.0.0';
const record = process.env.RECORD;

const provider = new MemoryProvider()
    .addUser({id: 'alice', username: 'alice', password: 'alice', displayName: 'Alice', addresses: ['mailto:alice@example.com']})
    .addUser({id: 'bob', username: 'bob', password: 'bob', displayName: 'Bob', addresses: ['mailto:bob@example.com']})
    .addCalendar({id: 'personal', displayName: 'Personal', components: ['VEVENT'], color: '#1E88E5FF', order: 1}, {alice: 'write'})
    .addCalendar({id: 'bob', displayName: 'Bob', components: ['VEVENT'], color: '#43A047FF', order: 1}, {bob: 'write'})
    .addCalendar({id: 'team', displayName: 'Team (read-only for Bob)', components: ['VEVENT'], color: '#E53935FF', order: 2}, {alice: 'write', bob: 'read'})
    .addCalendar({id: 'todos', displayName: 'Team to-dos', components: ['VTODO'], color: '#FB8C00FF', order: 3}, {alice: 'write', bob: 'write'})
    // Alice may read Bob's calendars (Apple Calendar: "Delegates" in the account settings).
    .addDelegate('bob', 'alice', false);

const now = new Date();
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const at = (days: number, hours: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, hours));

provider.seed(
    'team',
    'team-standup.ics',
    [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//caldav-provider-server//example//EN',
        'BEGIN:VEVENT',
        'UID:team-standup',
        `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(at(0, 8))}`,
        `DTEND:${stamp(at(0, 8.25))}`,
        'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        'SUMMARY:Stand-up',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
    ].join('\r\n'),
);
provider.seed(
    'todos',
    'todo-1.ics',
    [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//caldav-provider-server//example//EN',
        'BEGIN:VTODO',
        'UID:todo-1',
        `DTSTAMP:${stamp(now)}`,
        `DUE:${stamp(at(2, 15))}`,
        'SUMMARY:Try caldav-provider-server',
        'STATUS:NEEDS-ACTION',
        'END:VTODO',
        'END:VCALENDAR',
        '',
    ].join('\r\n'),
);

const app = Fastify({logger: {level: process.env.LOG_LEVEL ?? 'info'}});

if (record) {
    mkdirSync(record, {recursive: true});
    let n = 0;
    app.addHook('onSend', async (request, reply, payload) => {
        const {authorization: _, ...headers} = request.headers;
        const file = join(record, `${String(++n).padStart(4, '0')}-${request.method}.json`);
        const entry = {
            request: {method: request.method, url: request.url, headers, body: typeof request.body === 'string' ? request.body : undefined},
            response: {status: reply.statusCode, headers: reply.getHeaders(), body: typeof payload === 'string' ? payload : undefined},
        };
        writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
        return payload;
    });
}

// WebDAV-Push for DAVx⁵. The VAPID keys are new on every start here; keep them in a real setup.
const push = new WebDavPush({store: new MemoryPushStore(), vapid: generateVapidKeys(), subject: 'mailto:admin@example.com'});

await app.register(caldav, {
    provider,
    basePath: '/dav',
    realm: 'caldav-provider-server example',
    push,
    onError: (error) => app.log.error(error),
});

await app.listen({port, host});
app.log.info(`CalDAV server: http://localhost:${port}/dav/ (users alice/alice and bob/bob)`);
