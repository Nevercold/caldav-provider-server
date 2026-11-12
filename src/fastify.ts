import type {FastifyInstance, FastifyPluginAsync} from 'fastify';
import {CALDAV_METHODS, type CalDavOptions, createCalDavHandler} from './handler.ts';
import type {Principal} from './types.ts';

export interface FastifyCalDavOptions<P extends Principal = Principal> extends CalDavOptions<P> {
    /** Maximum request body size in bytes. Default 10 MiB. */
    bodyLimit?: number;
}

/**
 * Fastify plugin. Registers the CalDAV routes below `basePath` (default
 * `/dav`) and `/.well-known/caldav`. Register it without Fastify's `prefix`
 * option; the well-known URL has to stay at the root.
 *
 * ```ts
 * await app.register(caldav, {provider, basePath: '/dav'});
 * ```
 */
async function caldavPlugin(fastify: FastifyInstance, options: FastifyCalDavOptions): Promise<void> {
    const handle = createCalDavHandler(options);
    const base = (options.basePath ?? '/dav').replace(/\/+$/, '');

    for (const method of CALDAV_METHODS) {
        if (!fastify.supportedMethods.includes(method)) fastify.addHttpMethod(method, {hasBody: true});
    }

    // The plugin is encapsulated, so these parsers only apply to its routes.
    fastify.removeAllContentTypeParsers();
    // Bytes, not text: attachment uploads are binary. The handler decodes the rest as UTF-8.
    fastify.addContentTypeParser('*', {parseAs: 'buffer', bodyLimit: options.bodyLimit ?? 10 * 1024 * 1024}, (_req, body, done) => {
        done(null, body);
    });

    const methods = CALDAV_METHODS.filter((m) => m !== 'HEAD');
    for (const url of ['/.well-known/caldav', '/.well-known/caldav/', base || '/', `${base}/*`]) {
        fastify.route({
            method: methods,
            url,
            exposeHeadRoute: true,
            handler: async (request, reply) => {
                const res = await handle({
                    method: request.method,
                    url: request.url,
                    headers: request.headers,
                    body: request.body instanceof Uint8Array || typeof request.body === 'string' ? request.body : undefined,
                });
                reply.code(res.status).headers(res.headers);
                return reply.send(res.body ?? '');
            },
        });
    }
}

export const caldav: FastifyPluginAsync<FastifyCalDavOptions> = caldavPlugin;
export default caldav;
