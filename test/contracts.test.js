'use strict';
/**
 * The released contracts (the pinned openvibe-contracts tag) describe what the code does: the services
 * service manifest's events are exactly what the outbox can produce, its capabilities are the ones
 * the API and the resource index guard with requireCapability, and the release API answers with the
 * contracts' problems.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { EVENT_TYPES } = require('../server/events/outbox');
const { MANAGE, READ } = require('../server/http/api');
const { RESOURCE_READ } = require('../server/registry/resource-index');
const { check, done } = require('./helpers/boot');

const CONTROL = 'services.resource.control';

(async () => {
    const manifest = contracts.services.get('services');

    await check('the services service manifest is released as alpha, with this code\'s events', async () => {
        assert.ok(manifest);
        assert.strictEqual(manifest.status, 'alpha');
        assert.deepStrictEqual(manifest.domains, ['openvibe.services']);
        assert.deepStrictEqual([...manifest.eventsProduced].sort(), [...EVENT_TYPES].sort());
        for (const e of manifest.eventsProduced) assert.strictEqual(e.split('.').length, 3, `${e} has three segments`);
        const range = manifest.contractRanges['openvibe-contracts'];
        assert.ok(require('openvibe-sdk/core').satisfiesRange(require('openvibe-contracts/package.json').version, range));
    });

    await check('its capabilities exist, are owned by services, and are the ones the API guards', async () => {
        // services.resource.read (ADR-048, the resource index) is released too. It stays 'planned' until the
        // contracts follow-up flips it after this ships, so only the two release capabilities are active.
        // Contracts 0.164 also lists three planned capabilities (recipe run, usage and cost reads): declared, not served
        // or guarded yet, so they stay planned here.
        const PLANNED = ['services.recipe.run', 'services.usage.read', 'services.cost.read'];
        assert.deepStrictEqual([...manifest.capabilities].sort(), [MANAGE, READ, RESOURCE_READ, CONTROL, ...PLANNED].sort());
        for (const id of PLANNED) assert.strictEqual(contracts.capabilities.get(id).status, 'planned', `${id} is not guarded by this code`);
        for (const id of [MANAGE, READ]) {
            const c = contracts.capabilities.get(id);
            assert.ok(c, id);
            assert.strictEqual(c.owner, 'services');
            assert.strictEqual(c.status, 'active');
        }
        const resource = contracts.capabilities.get(RESOURCE_READ);
        assert.ok(resource, RESOURCE_READ);
        assert.strictEqual(resource.owner, 'services');
        // services.resource.control (plan T13 step 10) is first-party and guards POST /api/v1/resources/control.
        const control = contracts.capabilities.get(CONTROL);
        assert.ok(control, CONTROL);
        assert.strictEqual(control.owner, 'services');
        assert.strictEqual(control.status, 'active');
        assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'auth', 'api.js'), 'utf8'), /resourceControl: 'services\.resource\.control'/);
        const api = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'api.js'), 'utf8');
        // The guards are serviceAuth.requireCapability built per request with the key the token names; api.js's
        // createCapabilityAccess is the one factory the release routes and the resource index both guard with.
        assert.match(api, /serviceAuth\.requireCapability\(cap,/);
        assert.match(api, /checked\('services\.release\.manage'/);
        assert.match(api, /guardFor\('services\.release\.read'\)/);
        const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'registry', 'resource-index.js'), 'utf8');
        assert.match(index, /RESOURCE_READ = 'services\.resource\.read'/, 'the resource index guards services.resource.read');
    });

    await check('no proposal left behind: everything proposed is released', async () => {
        const docs = path.join(__dirname, '..', 'docs');
        assert.ok(!fs.existsSync(path.join(docs, 'capabilities-proposal')));
        assert.ok(!fs.existsSync(path.join(docs, 'service-manifest-proposal.json')));
        assert.ok(!fs.existsSync(path.join(docs, 'contracts-proposal')));
        assert.ok(contracts.resolve('services.app-manifest@1'));
    });

    done();
})();
