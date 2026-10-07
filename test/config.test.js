'use strict';
/**
 * server/config.js: everything comes from the environment, loadConfig(env) is pure, and the defaults are
 * Services' own (port 4930, audience openvibe.services, the index's page size, concurrency and timeout).
 *
 *   node test/config.test.js
 */
const assert = require('assert');
const { loadConfig } = require('../server/config');
const { check, done } = require('./helpers/app');

async function main() {
    await check('defaults: port 4930, 127.0.0.1, audience openvibe.services, development', () => {
        const c = loadConfig({});
        assert.strictEqual(c.port, 4930);
        assert.strictEqual(c.host, '127.0.0.1');
        assert.strictEqual(c.nodeEnv, 'development');
        assert.strictEqual(c.isProduction, false);
        assert.strictEqual(c.baseUrl, 'http://localhost:4930');
        assert.strictEqual(c.audience, 'openvibe.services');
        assert.strictEqual(c.network.url, 'https://openvibe.network');
        assert.strictEqual(c.network.internalUrl, 'http://127.0.0.1:4000');
        assert.strictEqual(c.network.issuer, 'https://openvibe.network');
        assert.strictEqual(c.oauth.clientId, 'services');
        assert.strictEqual(c.oauth.clientSecret, '');
        assert.deepStrictEqual(c.index, { pageSize: 100, concurrency: 4, timeoutMs: 5000, defaultLimit: 100, maxLimit: 1000, networkTimeoutMs: 5000 });
        assert.deepStrictEqual(c.authorityOrigins, {});
        assert.strictEqual(c.events.enabled, true);
        assert.strictEqual(c.events.url, '');
        assert.strictEqual(c.db.url, '');
    });

    await check('the environment overrides every default', () => {
        const c = loadConfig({
            NODE_ENV: 'production', PORT: '5000', HOST: '0.0.0.0', BASE_URL: 'https://openvibe.services/',
            DATABASE_URL: 'postgres://runtime', DATABASE_DIRECT_URL: 'postgres://owner',
            OV_NETWORK_URL: 'https://network.example/', OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:4001/',
            OV_NETWORK_ISSUER: 'https://issuer.example', OV_NETWORK_PUBLIC_KEY: '-----BEGIN\\nKEY-----',
            OV_OAUTH_CLIENT_ID: 'svc', OV_OAUTH_CLIENT_SECRET: 'secret',
            SERVICES_INDEX_PAGE_SIZE: '2', SERVICES_INDEX_CONCURRENCY: '1', SERVICES_INDEX_TIMEOUT_MS: '250',
            SERVICES_INDEX_DEFAULT_LIMIT: '10', SERVICES_INDEX_MAX_LIMIT: '20', SERVICES_NETWORK_TIMEOUT_MS: '750',
            SERVICES_MEDIA_URL: 'http://127.0.0.1:4999/', SERVICES_NETWORK_URL: 'http://127.0.0.1:4010',
            EVENTS_URL: 'http://127.0.0.1:4300/', EVENTS_RELAY_INTERVAL_MS: '500', SERVICES_EVENTS_ENABLED: '0',
        });
        assert.strictEqual(c.isProduction, true);
        assert.strictEqual(c.port, 5000);
        assert.strictEqual(c.baseUrl, 'https://openvibe.services');            // a trailing slash is trimmed
        assert.strictEqual(c.db.url, 'postgres://runtime');
        assert.strictEqual(c.network.url, 'https://network.example');
        assert.strictEqual(c.network.internalUrl, 'http://127.0.0.1:4001');
        assert.strictEqual(c.network.issuer, 'https://issuer.example');
        assert.strictEqual(c.network.publicKey, '-----BEGIN\nKEY-----');        // \n escaped in the env
        assert.strictEqual(c.oauth.clientSecret, 'secret');
        assert.deepStrictEqual(c.index, { pageSize: 2, concurrency: 1, timeoutMs: 250, defaultLimit: 10, maxLimit: 20, networkTimeoutMs: 750 });
        assert.deepStrictEqual(c.authorityOrigins, { media: 'http://127.0.0.1:4999', network: 'http://127.0.0.1:4010' });
        assert.strictEqual(c.events.enabled, false);
        assert.strictEqual(c.events.url, 'http://127.0.0.1:4300');
        assert.strictEqual(c.events.intervalMs, 500);
    });

    await check('a production baseUrl defaults to the domain, and an unnamed authority is not invented', () => {
        const c = loadConfig({ NODE_ENV: 'production' });
        assert.strictEqual(c.baseUrl, 'https://openvibe.services');
        assert.deepStrictEqual(c.authorityOrigins, {});
        const dev = loadConfig({ SERVICES_MEDIA_URL: '' });
        assert.deepStrictEqual(dev.authorityOrigins, {}, 'an empty override is not an origin');
    });

    await check('loadConfig is pure: it never writes what it read', () => {
        const env = { PORT: '7000' };
        loadConfig(env);
        assert.deepStrictEqual(env, { PORT: '7000' });
    });

    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
