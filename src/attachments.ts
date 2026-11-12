import type {Context, Resource} from './context.ts';
import {quoteEtag, unquoteEtag} from './context.ts';
import {CalDavError} from './errors.ts';
import {type CalDavResponse, header, type ParsedRequest} from './http.ts';
import {type Component, ICAL, inspectObject, IcsError, parseIcs, type Property} from './ical.ts';
import type {AttachmentInput, CalendarObject} from './types.ts';

/*
 * Managed attachments (RFC 8607): the client POSTs the file to the calendar object
 * with ?action=attachment-add|attachment-update|attachment-remove, the server stores it
 * through the provider and maintains the ATTACH properties of the object.
 */

type ObjectResource = Extract<Resource, {kind: 'object'}>;

/** Components the request addresses: `rid` lists RECURRENCE-IDs, `M` is the master (RFC 8607 3.5). */
function targets(vcal: Component, rid: string | null): Component[] {
    const comps = vcal.getAllSubcomponents().filter((c) => c.name !== 'vtimezone');
    if (!rid) return comps;
    const wanted = rid.split(',').map((r) => r.trim().toUpperCase());
    const out = comps.filter((c) => {
        const id = c.getFirstProperty('recurrence-id');
        if (!id) return wanted.includes('M');
        return wanted.includes(String(id.getFirstValue()).replace(/[-:]/g, '').toUpperCase());
    });
    if (out.length !== wanted.length) throw CalDavError.caldav(403, 'valid-rid', 'unknown recurrence id');
    return out;
}

function managedAttachments(comp: Component, managedId?: string): Property[] {
    return comp.getAllProperties('attach').filter((p) => {
        const id = p.getParameter('managed-id');
        return id !== undefined && (managedId === undefined || id === managedId);
    });
}

function filenameOf(req: ParsedRequest): string {
    const disposition = header(req, 'content-disposition') ?? '';
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    if (star) {
        try {
            return decodeURIComponent(star[1]!.trim());
        } catch {
            // fall through to the plain filename
        }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
    return plain?.[1]?.trim() || 'attachment';
}

function inputOf(ctx: Context, req: ParsedRequest): AttachmentInput {
    const data = req.bytes ?? new Uint8Array();
    const max = ctx.provider.attachments!.maxSize;
    if (max !== undefined && data.byteLength > max) throw CalDavError.caldav(413, 'max-attachment-size', 'attachment too large');
    return {filename: filenameOf(req), contentType: header(req, 'content-type')?.split(';')[0]?.trim() || 'application/octet-stream', data};
}

function setAttach(prop: Property, ctx: Context, managedId: string, input: AttachmentInput) {
    prop.setValue(`${ctx.origin}${ctx.attachmentHref(managedId)}`);
    prop.setParameter('managed-id', managedId);
    prop.setParameter('filename', input.filename);
    prop.setParameter('size', String(input.data.byteLength));
    prop.setParameter('fmttype', input.contentType);
    prop.removeParameter('value');
    prop.removeParameter('encoding');
}

async function store(ctx: Context, r: ObjectResource, vcal: Component, current: CalendarObject): Promise<Record<string, string>> {
    const ics = vcal.toString().replace(/\r?\n/g, '\r\n') + '\r\n';
    let info;
    try {
        info = inspectObject(vcal);
    } catch (e) {
        if (e instanceof IcsError) throw CalDavError.caldav(403, 'valid-calendar-object-resource', e.message);
        throw e;
    }
    const result = await ctx.provider.putObject!(ctx.principal, r.calendar, {
        name: r.name,
        uid: info.uid,
        ics,
        componentType: info.componentType,
        isNew: false,
        ifMatch: unquoteEtag(current.etag),
    });
    return result.storedAsIs && result.etag ? {ETag: quoteEtag(result.etag)} : {};
}

/** POST ?action=attachment-* on a calendar object. */
export async function handleAttachmentPost(ctx: Context, req: ParsedRequest, r: Resource, query: URLSearchParams): Promise<CalDavResponse> {
    const provider = ctx.provider.attachments;
    if (!provider) throw CalDavError.forbidden('attachments are not supported');
    if (r.kind !== 'object') throw CalDavError.forbidden('attachments belong to calendar objects');
    if (!r.object) throw CalDavError.notFound();
    if (!ctx.canWrite(r.calendar)) throw CalDavError.forbidden('calendar is read-only');
    const ifMatch = header(req, 'if-match');
    if (ifMatch !== undefined && ifMatch.trim() !== '*' && !ifMatch.split(',').map(unquoteEtag).includes(unquoteEtag(r.object.etag))) {
        throw CalDavError.preconditionFailed('ETag does not match');
    }
    let vcal: Component;
    try {
        vcal = parseIcs(r.object.ics);
    } catch {
        throw CalDavError.caldav(403, 'valid-calendar-object-resource', 'stored object cannot be parsed');
    }
    const action = query.get('action');
    const managedId = query.get('managed-id') ?? undefined;
    const comps = targets(vcal, query.get('rid'));

    if (action === 'attachment-add') {
        const max = provider.maxPerObject;
        const ids = new Set(vcal.getAllSubcomponents().flatMap((c) => managedAttachments(c).map((p) => p.getParameter('managed-id'))));
        if (max !== undefined && ids.size >= max) throw CalDavError.caldav(403, 'max-attachments-per-resource', 'too many attachments');
        const input = inputOf(ctx, req);
        const id = await provider.add(ctx.principal, r.calendar, r.name, input);
        for (const c of comps) {
            const prop = new ICAL.Property('attach', c);
            setAttach(prop, ctx, id, input);
            c.addProperty(prop);
        }
        const headers = await store(ctx, r, vcal, r.object);
        return {status: 201, headers: {...headers, 'Cal-Managed-ID': id, Location: `${ctx.origin}${ctx.attachmentHref(id)}`}};
    }

    if (!managedId) throw CalDavError.caldav(403, 'valid-managed-id', 'managed-id is missing');
    const existing = comps.flatMap((c) => managedAttachments(c, managedId).map((p) => ({c, p})));
    if (!existing.length) throw CalDavError.caldav(403, 'valid-managed-id', 'unknown managed-id');

    if (action === 'attachment-update') {
        const input = inputOf(ctx, req);
        const id = await provider.update(ctx.principal, r.calendar, r.name, managedId, input);
        // The update applies to every instance that references the attachment.
        for (const c of vcal.getAllSubcomponents()) for (const p of managedAttachments(c, managedId)) setAttach(p, ctx, id, input);
        const headers = await store(ctx, r, vcal, r.object);
        return {status: 204, headers: {...headers, 'Cal-Managed-ID': id}};
    }

    if (action === 'attachment-remove') {
        for (const {c, p} of existing) c.removeProperty(p);
        const headers = await store(ctx, r, vcal, r.object);
        const stillUsed = vcal.getAllSubcomponents().some((c) => managedAttachments(c, managedId).length);
        if (!stillUsed) await provider.remove(ctx.principal, r.calendar, r.name, managedId);
        return {status: 204, headers};
    }
    throw new CalDavError(400, `unknown action ${action}`);
}

/** Managed ids an object references; to clean up after a DELETE. */
export function managedIdsOf(ics: string): string[] {
    try {
        const vcal = parseIcs(ics);
        return [...new Set(vcal.getAllSubcomponents().flatMap((c) => managedAttachments(c).map((p) => String(p.getParameter('managed-id')))))];
    } catch {
        return [];
    }
}

/** GET of an attachment. */
export async function getAttachment(ctx: Context, managedId: string, head: boolean): Promise<CalDavResponse> {
    const file = await ctx.provider.attachments!.get(ctx.principal, managedId);
    if (!file) throw CalDavError.notFound();
    const name = encodeURIComponent(file.filename);
    return {
        status: 200,
        headers: {
            'Content-Type': file.contentType,
            'Content-Length': String(file.data.byteLength),
            'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
        },
        body: head ? undefined : file.data,
    };
}
