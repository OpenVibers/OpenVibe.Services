'use strict';
/**
 * server/authorities/index.js against the REAL pinned openvibe-contracts (v0.108.0): the registry is
 * derived from the released service manifests — every non-placeholder service whose manifest lists an
 * active <id>.resource.read — and never hand-maintained. The five authorities of the pin, their manifest
 * loopback origins and their audiences; Services itself, placeholders and services without the
 * capability are not authorities.
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
    await check('the pin lists exactly five active <id>.resource.read authorities', () => {
        const ids = contracts.capabilities.manifests.filter((c) => /^([a-z][a-z0-9-]{0,31})\.resource\.read$/.test(c.id)).map((c) => c.id).sort();
        assert.deepStrictEqual(ids, ['codes.resource.read', 'events.resource.read', 'host.resource.read', 'media.resource.read', 'network.resource.read']);
        for (const id of ids) assert.strictEqual(contracts.capabilities.get(id).status, 'active', id);
    });

    await check('the registry is built from those manifests, with the manifest origins and audiences', () => {
        const registry = createAuthorities(loadConfig({}), { log: quiet });
        assert.deepStrictEqual(registry.ids(), ['codes', 'events', 'host', 'media', 'network']);
        const expected = {
            network: 'http://127.0.0.1:4000',
            media: 'http://127.0.0.1:4100',
            events: 'http://127.0.0.1:4300',
            codes: 'http://127.0.0.1:4900',
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
        assert.strictEqual(registry.size(), 5);
    });

    await check('Services, placeholders and services without the capability are not authorities', () => {
        const registry = createAuthorities(loadConfig({}), { log: quiet });
        for (const id of ['services', 'run', 'actor', 'watch', 'actor-console', 'sites']) {
            if (!contracts.services.get(id)) continue;
            assert.strictEqual(registry.get(id), null, `${id} must not be an authority`);
        }
        // Services' own manifest is a placeholder today; even a live one would never index itself.
        assert.ok(!registry.ids().includes('services'));
    });

    await check('SERVICES_<ID>_URL overrides one origin, and never invents an authority', () => {
        const registry = createAuthorities(loadConfig({ SERVICES_MEDIA_URL: 'http://127.0.0.1:4999', SERVICES_RUN_URL: 'http://127.0.0.1:4888' }), { log: quiet });
        assert.strictEqual(registry.get('media').internalOrigin, 'http://127.0.0.1:4999');
        assert.strictEqual(registry.get('run'), null, 'an override for a service without the capability changes nothing');
        assert.deepStrictEqual(registry.ids(), ['codes', 'events', 'host', 'media', 'network']);
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
