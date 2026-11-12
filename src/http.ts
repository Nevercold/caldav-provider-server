import {CalDavError} from './errors.ts';
import {d, el, parseXml, serialize, type XmlElement, XmlParseError, type XNode} from './xml.ts';

export interface CalDavRequest {
    method: string;
    /** Path with optional query string, e.g. `/dav/calendars/jane/`. */
    url: string;
    headers: Record<string, string | string[] | undefined>;
    /** Raw bytes or UTF-8 text. Bytes are needed for attachment uploads. */
    body?: string | Uint8Array;
}

export interface CalDavResponse {
    status: number;
    headers: Record<string, string>;
    /** Text, or bytes for attachment downloads. */
    body?: string | Uint8Array;
}

/** A request as the handler works with it: text body, raw bytes alongside. */
export interface ParsedRequest extends CalDavRequest {
    body?: string;
    bytes?: Uint8Array;
}

export function normalizeRequest(req: CalDavRequest): ParsedRequest {
    if (typeof req.body === 'string' || req.body === undefined) {
        return {...req, body: req.body, bytes: req.body === undefined ? undefined : Buffer.from(req.body, 'utf8')};
    }
    return {...req, body: Buffer.from(req.body).toString('utf8'), bytes: req.body};
}

export function header(req: CalDavRequest, name: string): string | undefined {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : v;
}

export function xmlResponse(status: number, root: XNode, extra: Record<string, string> = {}): CalDavResponse {
    return {status, headers: {'Content-Type': 'application/xml; charset=utf-8', ...extra}, body: serialize(root)};
}

export function multistatus(responses: XNode[], ...extra: XNode[]): CalDavResponse {
    return xmlResponse(207, d('multistatus', ...responses, ...extra));
}

export function errorResponse(e: CalDavError): CalDavResponse {
    if (e.precondition) return xmlResponse(e.status, d('error', el(e.precondition.ns, e.precondition.name)));
    return {status: e.status, headers: {'Content-Type': 'text/plain; charset=utf-8'}, body: e.message};
}

export function parseBody(req: ParsedRequest): XmlElement | null {
    try {
        return parseXml(req.body);
    } catch (e) {
        if (e instanceof XmlParseError) throw new CalDavError(400, `invalid XML: ${e.message}`);
        throw e;
    }
}

