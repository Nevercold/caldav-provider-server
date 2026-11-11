import {NS, type QName} from './xml.ts';

/**
 * Throw this from a provider (or anywhere in the server) to answer with a
 * specific status. `precondition` becomes the body
 * `<D:error><precondition/></D:error>` (RFC 4918 16).
 */
export class CalDavError extends Error {
    constructor(
        readonly status: number,
        message?: string,
        readonly precondition?: QName,
    ) {
        super(message ?? `HTTP ${status}`);
        this.name = 'CalDavError';
    }

    static forbidden(message?: string): CalDavError {
        return new CalDavError(403, message, {ns: NS.DAV, name: 'need-privileges'});
    }

    static notFound(message?: string): CalDavError {
        return new CalDavError(404, message);
    }

    static preconditionFailed(message?: string): CalDavError {
        return new CalDavError(412, message);
    }

    /** RFC 4791 5.3.2.1: another resource in the calendar has the same UID. */
    static uidConflict(message?: string): CalDavError {
        return new CalDavError(403, message, {ns: NS.CALDAV, name: 'no-uid-conflict'});
    }

    static caldav(status: number, precondition: string, message?: string): CalDavError {
        return new CalDavError(status, message, {ns: NS.CALDAV, name: precondition});
    }

    static dav(status: number, precondition: string, message?: string): CalDavError {
        return new CalDavError(status, message, {ns: NS.DAV, name: precondition});
    }
}
