import {DOMParser, type Element as XmlElement} from '@xmldom/xmldom';

export type {XmlElement};

export const NS = {
    DAV: 'DAV:',
    CALDAV: 'urn:ietf:params:xml:ns:caldav',
    CS: 'http://calendarserver.org/ns/',
    APPLE: 'http://apple.com/ns/ical/',
} as const;

const PREFIXES: Record<string, string> = {
    [NS.DAV]: 'd',
    [NS.CALDAV]: 'cal',
    [NS.CS]: 'cs',
    [NS.APPLE]: 'ical',
};

/** A property or element name: namespace URI plus local name. */
export interface QName {
    ns: string;
    name: string;
}

export const qname = (ns: string, name: string): QName => ({ns, name});
export const qkey = (q: QName): string => `{${q.ns}}${q.name}`;

export class XmlParseError extends Error {}

/**
 * Parses an XML request body. Returns null for an empty body.
 * xmldom does not resolve external entities, so there is no XXE risk.
 */
export function parseXml(body: string | undefined): XmlElement | null {
    if (!body || !body.trim()) return null;
    let failure: string | undefined;
    const parser = new DOMParser({
        onError: (level, message) => {
            if (level !== 'warning') failure ??= message;
        },
    });
    let doc;
    try {
        doc = parser.parseFromString(body, 'application/xml');
    } catch (e) {
        throw new XmlParseError((e as Error).message);
    }
    if (failure || !doc.documentElement) throw new XmlParseError(failure ?? 'no root element');
    return doc.documentElement;
}

export function is(el: XmlElement | null | undefined, ns: string, name: string): el is XmlElement {
    return !!el && el.namespaceURI === ns && el.localName === name;
}

export function children(el: XmlElement | null | undefined): XmlElement[] {
    const out: XmlElement[] = [];
    if (!el) return out;
    for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1) out.push(n as XmlElement);
    }
    return out;
}

export function child(el: XmlElement | null | undefined, ns: string, name: string): XmlElement | undefined {
    return children(el).find((c) => is(c, ns, name));
}

export function textOf(el: XmlElement | null | undefined): string {
    return el?.textContent?.trim() ?? '';
}

export function qnameOf(el: XmlElement): QName {
    return {ns: el.namespaceURI ?? '', name: el.localName ?? el.nodeName};
}

/** A node of the response tree. Text nodes are plain strings. */
export interface XNode {
    ns: string;
    name: string;
    attrs?: Record<string, string>;
    children?: (XNode | string)[];
}

export type Kid = XNode | string | null | undefined | false | (XNode | string)[];

/** Builds an element. Children that are null/undefined/false are dropped. */
export function el(ns: string, name: string, ...kids: Kid[]): XNode {
    const flat: (XNode | string)[] = [];
    for (const k of kids) {
        if (k === null || k === undefined || k === false) continue;
        if (Array.isArray(k)) flat.push(...k);
        else flat.push(k);
    }
    return {ns, name, children: flat};
}

export const d = (name: string, ...kids: Kid[]): XNode => el(NS.DAV, name, ...kids);
export const cal = (name: string, ...kids: Kid[]): XNode => el(NS.CALDAV, name, ...kids);

export function escapeXml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);
}

/**
 * Serializes a tree. All namespaces are declared on the root element, unknown
 * ones (e.g. properties of other clients echoed back in a 404 propstat) get
 * generated prefixes.
 */
export function serialize(root: XNode): string {
    const prefixes = new Map<string, string>();
    let generated = 0;
    const collect = (n: XNode) => {
        if (n.ns && !prefixes.has(n.ns)) prefixes.set(n.ns, PREFIXES[n.ns] ?? `x${generated++}`);
        for (const c of n.children ?? []) if (typeof c !== 'string') collect(c);
    };
    collect(root);

    const tag = (n: XNode) => (n.ns ? `${prefixes.get(n.ns)}:${n.name}` : n.name);
    const write = (n: XNode, isRoot: boolean): string => {
        let attrs = '';
        if (isRoot) for (const [uri, p] of prefixes) attrs += ` xmlns:${p}="${escapeXml(uri)}"`;
        for (const [k, v] of Object.entries(n.attrs ?? {})) attrs += ` ${k}="${escapeXml(v)}"`;
        const kids = n.children ?? [];
        if (!kids.length) return `<${tag(n)}${attrs}/>`;
        const inner = kids.map((c) => (typeof c === 'string' ? escapeXml(c) : write(c, false))).join('');
        return `<${tag(n)}${attrs}>${inner}</${tag(n)}>`;
    };
    return `<?xml version="1.0" encoding="utf-8"?>\n${write(root, true)}`;
}
