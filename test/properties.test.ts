import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {ics, PROPFIND, props, propStatuses, setup, xml} from './helpers.ts';

const fixture = (file: string) => readFileSync(join(import.meta.dirname, 'fixtures', file), 'utf8');
const HOME = '/dav/calendars/alice/';
const CAL = '/dav/calendars/alice/personal/';
const update = (ops: string) => `<d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:example">${ops}</d:propertyupdate>`;

describe('stored properties', () => {
    it("keeps Apple's default alarms on the calendar home", async () => {
        const {request} = setup();
        for (const file of ['25-proppatch-home-default-alarm-datetime.xml', '26-proppatch-home-default-alarm-date.xml']) {
            const res = await request('PROPPATCH', HOME, {body: fixture(`apple-calendar/${file}`), headers: {'content-type': 'text/xml'}});
            expect(Object.values(propStatuses(res))).toEqual([200]);
        }
        const res = await request('PROPFIND', HOME, {
            headers: {depth: '0'},
            body: PROPFIND('<c:default-alarm-vevent-date/><c:default-alarm-vevent-datetime/>'),
        });
        const p = props(res)[HOME]!;
        // CRLF line endings survive (as &#13; on the wire).
        expect(p['default-alarm-vevent-date']).toBe(
            'BEGIN:VALARM\r\nX-WR-ALARMUID:49F29226-D2D7-4464-AE22-0147EDEFB2B4\r\nUID:49F29226-D2D7-4464-AE22-0147EDEFB2B4\r\nTRIGGER:-PT15H\r\nATTACH;VALUE=URI:Basso\r\nACTION:AUDIO\r\nEND:VALARM\r\n',
        );
        expect(p['default-alarm-vevent-datetime']).toContain('TRIGGER;VALUE=DATE-TIME:19760401T005545Z');
    });

    it('stores XML values, lists them in allprop and removes them', async () => {
        const {request} = setup();
        const set = await request('PROPPATCH', CAL, {
            body: update('<d:set><d:prop><x:tags><x:tag kind="a">one</x:tag><d:href>/x</d:href></x:tags></d:prop></d:set>'),
        });
        expect(propStatuses(set)).toEqual({tags: 200});
        const all = await request('PROPFIND', CAL, {headers: {depth: '0'}});
        expect(props(all)[CAL]!.tags).toBe('tag(one) href(/x)');
        const tag = xml(all).getElementsByTagNameNS('urn:example', 'tag')[0]!;
        expect(tag.getAttribute('kind')).toBe('a');

        await request('PROPPATCH', CAL, {body: update('<d:remove><d:prop><x:tags/></d:prop></d:remove>')});
        expect(props(await request('PROPFIND', CAL, {headers: {depth: '0'}}))[CAL]!.tags).toBeUndefined();
    });

    it('mixes live and stored properties atomically and protects live ones', async () => {
        const {request} = setup();
        const res = await request('PROPPATCH', CAL, {
            body: update('<d:set><d:prop><d:displayname>Work</d:displayname><x:note>hi</x:note><d:getetag>"x"</d:getetag></d:prop></d:set>'),
        });
        expect(propStatuses(res)).toEqual({displayname: 424, note: 424, getetag: 403});
        const ok = await request('PROPPATCH', CAL, {body: update('<d:set><d:prop><d:displayname>Work</d:displayname><x:note>hi</x:note></d:prop></d:set>')});
        expect(propStatuses(ok)).toEqual({displayname: 200, note: 200});
        expect(props(await request('PROPFIND', CAL, {headers: {depth: '0'}, body: PROPFIND('<d:displayname/><x:note xmlns:x="urn:example"/>')}))[CAL]).toEqual({
            displayname: 'Work',
            note: 'hi',
        });
    });

    it('objects and read-only calendars', async () => {
        const {request} = setup();
        await request('PUT', `${CAL}a.ics`, {body: ics('VEVENT', 'a', 'DTSTART:20260601T100000Z')});
        expect(propStatuses(await request('PROPPATCH', `${CAL}a.ics`, {body: update('<d:set><d:prop><x:note>n</x:note></d:prop></d:set>')}))).toEqual({note: 200});
        const team = await request('PROPPATCH', '/dav/calendars/bob/team/', {user: 'bob', body: update('<d:set><d:prop><x:note>n</x:note></d:prop></d:set>')});
        expect(propStatuses(team)).toEqual({note: 403});
    });

    it('the user renames themselves with updatePrincipal', async () => {
        const {request, provider} = setup();
        const res = await request('PROPPATCH', '/dav/principals/alice/', {body: update('<d:set><d:prop><d:displayname>Alice A.</d:displayname></d:prop></d:set>')});
        expect(propStatuses(res)).toEqual({displayname: 200});
        expect(props(await request('PROPFIND', '/dav/principals/alice/', {headers: {depth: '0'}, body: PROPFIND('<d:displayname/>')}))['/dav/principals/alice/']!.displayname).toBe(
            'Alice A.',
        );
        Object.assign(provider, {updatePrincipal: undefined, properties: undefined});
        const without = await request('PROPPATCH', '/dav/principals/alice/', {body: update('<d:set><d:prop><d:displayname>X</d:displayname></d:prop></d:set>')});
        expect(propStatuses(without)).toEqual({displayname: 403});
        expect(propStatuses(await request('PROPPATCH', HOME, {body: update('<d:set><d:prop><x:note>n</x:note></d:prop></d:set>')}))).toEqual({note: 403});
    });
});
