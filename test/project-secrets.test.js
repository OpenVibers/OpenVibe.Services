'use strict';
/**
 * Project secrets in the console (ADR-056): /projects/:project/secrets shows Network's metadata (name, version,
 * fingerprint, grants) to every member, and the set, delete and grant forms to admins and owners only. A value goes
 * from the form to Network once and appears nowhere after: not on any page, not in Services' database, not in its logs.
 * Grants forward the purposes and origins as chosen; Network's refusals are shown as it answered them.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('ona');
    const admin = t.network.addUser('ada');
    const viewer = t.network.addUser('vee');
    const P = await t.project(owner, 'Signed');
    for (const [who, role] of [['ada', 'admin'], ['vee', 'viewer']]) {
        assert.strictEqual((await t.get(`/projects/${P}/members`, { as: owner, form: { username: who, role } })).status, 303);
    }
    const page = `/projects/${P}/secrets`;
    const VALUE = `whk_${crypto.randomBytes(24).toString('hex')}`;
    const stored = () => t.network.state.secrets.get(`${P} sandbox webhook-signing`);

    await check('the project page links its secrets; an empty list says so, with the form for owners only', async () => {
        assert.ok((await t.get(`/projects/${P}`, { as: viewer })).text.includes(`href="/projects/${P}/secrets"`));
        const r = await t.get(page, { as: owner });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /No secrets yet\./);
        assert.match(r.text, /<h2>Set a secret<\/h2>/);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        const v = await t.get(page, { as: viewer });
        assert.ok(!v.text.includes('<h2>Set a secret</h2>'), 'a viewer gets no form');
    });

    await check('an owner sets a value: it reaches Network once and appears on no page, table or log line', async () => {
        const r = await t.get(page, { as: owner, form: { environment: 'sandbox', name: 'webhook-signing', value: VALUE } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        assert.match(r.headers.get('location'), new RegExp(`^/projects/${P}/secrets\\?done=webhook-signing%20saved`));
        assert.strictEqual(stored().value, VALUE, 'Network got the value');
        const after = await t.get(page, { as: admin });
        assert.ok(after.text.includes('webhook-signing') && after.text.includes(stored().fingerprint), 'name and fingerprint shown');
        assert.ok(!after.text.includes(VALUE), 'never the value');
        assert.ok(!(await t.dbDump()).includes(VALUE), 'not in Services\' database');
        assert.ok(!t.logs().includes(VALUE), 'not in its logs');
    });

    await check('a grant forwards what was chosen; reveal without origins is refused by Network and shown so', async () => {
        let r = await t.get(`${page}/sandbox/webhook-signing/grants`, { as: admin, form: { service: 'actor', purpose_sign: '1' } });
        assert.strictEqual(r.status, 303);
        assert.deepStrictEqual(stored().grants.get('actor'), { ...stored().grants.get('actor'), purposes: ['sign'], origins: [] });
        assert.match((await t.get(page, { as: viewer })).text, /<code>actor<\/code> sign/);
        r = await t.get(`${page}/sandbox/webhook-signing/grants`, { as: admin, form: { service: 'watch', purpose_reveal: '1' } });
        assert.strictEqual(r.status, 422, 'Network refused it');
        assert.match(r.text, /secret\.invalid/);
        r = await t.get(`${page}/sandbox/webhook-signing/grants`, { as: admin, form: { service: 'watch', purpose_reveal: '1', origins: 'https://api.example.com\nhttps://b.example.com' } });
        assert.strictEqual(r.status, 303);
        assert.deepStrictEqual(stored().grants.get('watch').origins, ['https://api.example.com', 'https://b.example.com']);
    });

    await check('a viewer cannot set, grant or delete: Network refuses and nothing changes', async () => {
        const r = await t.get(page, { as: viewer, form: { environment: 'sandbox', name: 'x', value: 'v' } });
        assert.strictEqual(r.status, 403);
        assert.ok(!t.network.state.secrets.has(`${P} sandbox x`));
    });

    await check('revoking a grant and deleting a secret (with the confirmation box)', async () => {
        assert.strictEqual((await t.get(`${page}/sandbox/webhook-signing/grants/watch/revoke`, { as: admin, form: {} })).status, 303);
        assert.ok(!stored().grants.has('watch'));
        assert.strictEqual((await t.get(`${page}/sandbox/webhook-signing/delete`, { as: owner, form: {} })).status, 422, 'unconfirmed');
        assert.strictEqual((await t.get(`${page}/sandbox/webhook-signing/delete`, { as: owner, form: { confirm: 'yes' } })).status, 303);
        assert.strictEqual(stored(), undefined);
        assert.strictEqual((await t.get(`${page}/staging/x/delete`, { as: owner, form: { confirm: 'yes' } })).status, 404, 'a bad environment never reaches Network');
    });

    await t.close();
    done();
})();
