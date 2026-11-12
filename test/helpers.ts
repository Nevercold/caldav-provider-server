import {MemoryProvider} from '../example/memory-provider.ts';
import {type CalDavHandler, createCalDavHandler, type CalDavResponse} from '../src/index.ts';
import {parseXml, type XmlElement} from '../src/xml.ts';

export type Request = (
    method: string,
    url: string,
    init?: {user?: string | null; body?: string; headers?: Record<string, string>},
) => Promise<CalDavResponse>;

export interface Setup {
    provider: MemoryProvider;
    handle: CalDavHandler;
    request: Request;
}

export function setup(options: {scheduling?: boolean; calendarHooks?: boolean} = {}): Setup {
    const provider = new MemoryProvider()
        .addUser({id: 'alice', username: 'alice', password: 'pw', displayName: 'Alice', addresses: ['alice@example.com']})
        .addUser({id: 'bob', username: 'bob', password: 'pw', displayName: 'Bob', addresses: ['mailto:bob@example.com']})
        .addCalendar({id: 'personal', displayName: 'Personal', components: ['VEVENT'], color: '#FF0000FF', order: 1}, {alice: 'write'})
        .addCalendar({id: 'bobcal', displayName: 'Bob', components: ['VEVENT']}, {bob: 'write'})
        .addCalendar({id: 'team', displayName: 'Team', components: ['VEVENT'], description: 'Shared'}, {alice: 'write', bob: 'read'})
        .addCalendar({id: 'todos', displayName: 'To-dos', components: ['VTODO']}, {alice: 'write', bob: 'write'});
    if (options.scheduling === false) (provider as {scheduling?: unknown}).scheduling = undefined;
    if (options.calendarHooks === false) {
        Object.assign(provider, {updateCalendar: undefined, createCalendar: undefined, deleteCalendar: undefined});
    }
    const handle = createCalDavHandler({provider, onError: (e) => console.error(e)});

    async function request(
        method: string,
        url: string,
        init: {user?: string | null; body?: string; headers?: Record<string, string>} = {},
    ): Promise<CalDavResponse> {
        const headers: Record<string, string> = {...init.headers};
        const user = init.user === undefined ? 'alice' : init.user;
        if (user) headers.authorization = `Basic ${Buffer.from(`${user}:pw`).toString('base64')}`;
        return handle({method, url, headers, body: init.body});
    }

    return {provider, handle, request};
}

export function xml(res: CalDavResponse): XmlElement {
    return parseXml(res.body)!;
}

/** Map of href → {prop local name → text} for the 200 propstats of a multistatus. */
export function props(res: CalDavResponse): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    const doc = xml(res);
    for (const response of Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))) {
        const href = response.getElementsByTagNameNS('DAV:', 'href')[0]!.textContent!;
        out[href] = {};
        for (const propstat of Array.from(response.getElementsByTagNameNS('DAV:', 'propstat'))) {
            const status = propstat.getElementsByTagNameNS('DAV:', 'status')[0]!.textContent!;
            if (!status.includes('200')) continue;
            const prop = propstat.getElementsByTagNameNS('DAV:', 'prop')[0]!;
            for (let n = prop.firstChild; n; n = n.nextSibling) {
                if (n.nodeType === 1) out[href]![(n as XmlElement).localName!] = serializeInner(n as XmlElement);
            }
        }
    }
    return out;
}

function serializeInner(el: XmlElement): string {
    const kids = Array.from(el.childNodes);
    if (kids.every((k) => k.nodeType === 3)) return el.textContent ?? '';
    return kids
        .filter((k) => k.nodeType === 1)
        .map((k) => {
            const e = k as XmlElement;
            const inner = serializeInner(e);
            const name = e.getAttribute('name');
            return `${e.localName}${name ? `[${name}]` : ''}${inner ? `(${inner})` : ''}`;
        })
        .join(' ');
}

/** Status code per property local name, from every propstat of the body (multistatus or mk*-response). */
export function propStatuses(res: CalDavResponse): Record<string, number> {
    const out: Record<string, number> = {};
    for (const propstat of Array.from(xml(res).getElementsByTagNameNS('DAV:', 'propstat'))) {
        const status = Number(/ (\d{3})/.exec(propstat.getElementsByTagNameNS('DAV:', 'status')[0]!.textContent!)![1]);
        const prop = propstat.getElementsByTagNameNS('DAV:', 'prop')[0]!;
        for (let n = prop.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1) out[(n as XmlElement).localName!] = status;
        }
    }
    return out;
}

/** Status per href (responses without propstat). */
export function statuses(res: CalDavResponse): Record<string, string> {
    const out: Record<string, string> = {};
    for (const response of Array.from(xml(res).getElementsByTagNameNS('DAV:', 'response'))) {
        const href = response.getElementsByTagNameNS('DAV:', 'href')[0]!.textContent!;
        const direct = Array.from(response.childNodes).find((n) => n.nodeType === 1 && (n as XmlElement).localName === 'status');
        if (direct) out[href] = direct.textContent!;
    }
    return out;
}

export function ics(kind: 'VEVENT' | 'VTODO', uid: string, ...props: string[]): string {
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//test//EN',
        `BEGIN:${kind}`,
        `UID:${uid}`,
        'DTSTAMP:20260101T000000Z',
        ...props,
        `END:${kind}`,
        'END:VCALENDAR',
        '',
    ].join('\r\n');
}

export const PROPFIND = (props: string): string =>
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`;
