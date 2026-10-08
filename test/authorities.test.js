'use strict';
/**
 * server/authorities/index.js against the REAL pinned openvibe-contracts (v0.113.0): the registry is
 * derived from the released service manifests — every non-placeholder service whose manifest lists an
 * active <id>.resource.read — and never hand-maintained. The four authorities of the pin, their manifest
 * loopback origins and their audiences; Services itself (read in process: server/registry/self-authority.js),
 * Codes (retired codes.resource.read at 0.113.0, when its portal moved here), placeholders and services without
 * the capability are not authorities.
 *
 *   node test/authorities.test.js
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { loadConfig } = require('../server/config');
const { createAuthorities } = require('../server/authorities');
const { check, done } = require('./helpers/app');

const quiet = { warn() {}, log() {}, error() {} };

async function main() {
    await check('the pin lists five active <id>.resource.read capabilities, four of them authorities', () => {
        const ids = contracts.capabilities.manifests.filter((c) => /^([a-z][a-z0-9-]{0,31})\.resource\.read$/.test(c.id) && c.status === 'active').map((c) => c.id).sort();
        assert.deepStrictEqual(ids, ['events.resource.read', 'host.resource.read', 'media.resource.read', 'network.resource.read', 'services.resource.read']);
        assert.strictEqual(contracts.capabilities.get('codes.resource.read').status, 'retired', 'Codes owns no resources since 0.113.0');
        // services.resource.read is Services' own id; Services is never its own authority (the next check).
        assert.ok(!createAuthorities(loadConfig({}), { log: quiet }).ids().includes('services'));
    });

    await check('the registry is built from those manifests, with the manifest origins and audiences', () => {
        const registry = createAuthorities(loadConfig({}), { log: quiet });
        assert.deepStrictEqual(registry.ids(), ['events', 'host', 'media', 'network']);
        const expected = {
            network: 'http://127.0.0.1:4000',
            media: 'http://127.0.0.1:4100',
            events: 'http://127.0.0.1:4300',
            host: 'http://127.0.0.1:4910',
        };
        for (const [id, origin] of Object.entries(expected)) {
            const a = registry.get(id);
            assert.ok(a, `${id} is an authority`);
            assert.strictEqual(a.internalOrigin, origin);
            assert.strictEqual(a.audience, `openvibe.${id}`);
            assert.strictEqual(a.capability, `${id}.resource.read`);
            assert.strictEqual(a.name, contracts.services.get(id).name);
            assert.strictEqual(a.manifestVersion, contracts.services.get(id).version);
            assert.strictEqual(a.publicOrigin, contracts.services.get(id).publicOrigin);
        }
        assert.strictEqual(registry.get('nope'), null);
        assert.strictEqual(registry.size(), 4);
    });

    await check('Services, placeholders and services without the capability are not authorities', () => {
        const registry = createAuthorities(loadConfig({}), { log: quiet });
        for (const id of ['services', 'codes', 'run', 'actor', 'watch', 'actor-console', 'sites']) {
            if (!contracts.services.get(id)) continue;
            assert.strictEqual(registry.get(id), null, `${id} must not be an authority`);
        }
        // Services' own resources are read in process (server/registry/self-authority.js), never over HTTP.
        assert.ok(!registry.ids().includes('services'));
    });

    await check('SERVICES_<ID>_URL overrides one origin, and never invents an authority', () => {
        const registry = createAuthorities(loadConfig({ SERVICES_MEDIA_URL: 'http://127.0.0.1:4999', SERVICES_RUN_URL: 'http://127.0.0.1:4888' }), { log: quiet });
        assert.strictEqual(registry.get('media').internalOrigin, 'http://127.0.0.1:4999');
        assert.strictEqual(registry.get('run'), null, 'an override for a service without the capability changes nothing');
        assert.deepStrictEqual(registry.ids(), ['events', 'host', 'media', 'network']);
    });

    await check('every registry entry satisfies the rule the registry claims', () => {
        for (const a of createAuthorities(loadConfig({}), { log: quiet }).list()) {
            const service = contracts.services.get(a.id);
            assert.ok(service.capabilities.includes(a.capability), `${a.id} lists its capability`);
            assert.strictEqual(contracts.capabilities.get(a.capability).status, 'active');
            assert.ok(service.internalOrigin, `${a.id} has a loopback origin`);
            assert.ok(!['retired', 'placeholder'].includes(service.status), `${a.id} is served`);
        }
    });

    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
