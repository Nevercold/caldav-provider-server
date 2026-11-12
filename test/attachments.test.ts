import {describe, expect, it} from 'vitest';
import {ics, PROPFIND, props, setup} from './helpers.ts';

const CAL = '/dav/calendars/alice/personal/';
const OBJ = `${CAL}a.ics`;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);

async function seeded() {
    const s = setup();
    await s.request('PUT', OBJ, {
        body: ics('VEVENT', 'a', 'DTSTART:20260601T100000Z', 'DTEND:20260601T110000Z', 'RRULE:FREQ=DAILY;COUNT=3'),
    });
    return s;
}

const upload = (headers: Record<string, string> = {}) => ({
    body: PDF,
    headers: {
        host: 'cal.example.com',
        'x-forwarded-proto': 'https',
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="Agenda Q3.pdf"',
        ...headers,
    },
});

describe('managed attachments', () => {
    it('adds an attachment, writes ATTACH and serves the bytes', async () => {
        const {request} = await seeded();
        const res = await request('POST', `${OBJ}?action=attachment-add`, upload());
        expect(res.status).toBe(201);
        const id = res.headers['Cal-Managed-ID']!;
        expect(res.headers.Location).toBe(`https://cal.example.com/dav/attachments/alice/${id}`);

        const event = (await request('GET', OBJ)).body!;
        expect(event.replace(/\r\n /g, '')).toContain(
            `ATTACH;MANAGED-ID=${id};FILENAME=Agenda Q3.pdf;SIZE=8;FMTTYPE=application/pdf:https://cal.example.com/dav/attachments/alice/${id}`,
        );

        const file = await request('GET', `/dav/attachments/alice/${id}`);
        expect(file.status).toBe(200);
        expect(file.headers['Content-Type']).toBe('application/pdf');
        expect(file.headers['Content-Disposition']).toBe("attachment; filename*=UTF-8''Agenda%20Q3.pdf");
        expect(file.bytes).toEqual(PDF);
        // Others don't see it.
        expect((await request('GET', `/dav/attachments/bob/${id}`, {user: 'bob'})).status).toBe(404);
    });

    it('updates and removes by managed-id', async () => {
        const {request, provider} = await seeded();
        const id = (await request('POST', `${OBJ}?action=attachment-add`, upload())).headers['Cal-Managed-ID']!;
        const updated = await request('POST', `${OBJ}?action=attachment-update&managed-id=${id}`, upload({'content-disposition': 'attachment; filename=v2.pdf'}));
        expect(updated.status).toBe(204);
        const id2 = updated.headers['Cal-Managed-ID']!;
        expect(id2).not.toBe(id);
        const event = (await request('GET', OBJ)).body!;
        expect(event).toContain(`MANAGED-ID=${id2}`);
        expect(event).toContain('FILENAME=v2.pdf');
        expect(event).not.toContain(id);

        expect((await request('POST', `${OBJ}?action=attachment-remove&managed-id=${id2}`)).status).toBe(204);
        expect((await request('GET', OBJ)).body).not.toContain('ATTACH');
        expect(provider.files.size).toBe(0);
    });

    it('attaches to single instances with rid', async () => {
        const {request} = await seeded();
        const bad = await request('POST', `${OBJ}?action=attachment-add&rid=20260602T100000Z`, upload());
        expect(bad.status).toBe(403);
        expect(bad.body).toContain('valid-rid');
        expect((await request('POST', `${OBJ}?action=attachment-add&rid=M`, upload())).status).toBe(201);
    });

    it('checks preconditions, size, privileges and support', async () => {
        const {request, provider} = await seeded();
        expect((await request('POST', `${OBJ}?action=attachment-add`, upload({'if-match': '"nope"'}))).status).toBe(412);
        expect((await request('POST', `${OBJ}?action=attachment-update&managed-id=nope`, upload())).body).toContain('valid-managed-id');
        expect((await request('POST', `${CAL}missing.ics?action=attachment-add`, upload())).status).toBe(404);
        await request('PUT', '/dav/calendars/alice/team/t.ics', {body: ics('VEVENT', 't', 'DTSTART:20260601T100000Z')});
        expect((await request('POST', '/dav/calendars/bob/team/t.ics?action=attachment-add', {...upload(), user: 'bob'})).status).toBe(403);
        provider.attachments.maxSize = 4;
        const big = await request('POST', `${OBJ}?action=attachment-add`, upload());
        expect(big.status).toBe(413);
        expect(big.body).toContain('max-attachment-size');

        const home = props(await request('PROPFIND', '/dav/calendars/alice/', {headers: {depth: '0'}, body: PROPFIND('<c:max-attachment-size/><c:managed-attachments-server-URL/>')}));
        expect(home['/dav/calendars/alice/']).toEqual({'max-attachment-size': '4', 'managed-attachments-server-URL': ''});

        Object.assign(provider, {attachments: undefined});
        expect((await request('POST', `${OBJ}?action=attachment-add`, upload())).status).toBe(403);
    });

    it('deleting the object removes its attachments', async () => {
        const {request, provider} = await seeded();
        await request('POST', `${OBJ}?action=attachment-add`, upload());
        expect(provider.files.size).toBe(1);
        expect((await request('DELETE', OBJ)).status).toBe(204);
        expect(provider.files.size).toBe(0);
    });
});
