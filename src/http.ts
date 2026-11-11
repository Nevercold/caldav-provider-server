import {CalDavError} from './errors.ts';
import {d, el, parseXml, serialize, type XmlElement, XmlParseError, type XNode} from './xml.ts';

export interface CalDavRequest {
    method: string;
    /** Path with optional query string, e.g. `/dav/calendars/jane/`. */
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body?: string;
}

export interface CalDavResponse {
    status: number;
    headers: Record<string, string>;
    body?: string;
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

export function parseBody(req: CalDavRequest): XmlElement | null {
    try {
        return parseXml(req.body);
    } catch (e) {
        if (e instanceof XmlParseError) throw new CalDavError(400, `invalid XML: ${e.message}`);
        throw e;
    }
}

