'use strict';
/**
 * /mod (server/http/mod.js): a public, indexable page that lists every way to extend OpenVibe today, each card with a
 * link, says plainly that packaged mods are installed by staff until ADR-013's open decisions are made, and is in the
 * navigation, the sitemap and llms.txt.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { TODAY } = require('../server/http/mod');

(async () => {
    const t = await boot();
    try {
        await check('the page: every card, the honest state of packaged mods, links that go somewhere', async () => {
            const r = await t.get('/mod');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<h1>Mod the network<\/h1>/);
            TODAY.forEach((c) => {
                assert.ok(r.text.includes(c.title.replace(/'/g, '&#39;').replace(/"/g, '&quot;')), `missing card: ${c.title}`);
                assert.match(c.href, /^https:\/\//, `${c.title} links out over https`);
            });
            assert.match(r.text, /only staff install mods/);
            assert.match(r.text, /href="\/docs\/adr\/ADR-013"/);
            assert.match(r.text, /create-openvibe-app my-mod --template mod/);
            assert.ok(!/noindex/.test(r.text), 'indexable');
        });
        await check('found from the navigation, the sitemap and llms.txt', async () => {
            assert.match((await t.get('/')).text, /href="\/mod"/);
            assert.ok((await t.get('/sitemap.xml')).text.includes('<loc>https://openvibe.services/mod</loc>'));
            assert.ok((await t.get('/llms.txt')).text.includes('https://openvibe.services/mod'));
            assert.ok((await t.get('/llms-full.txt')).text.includes('Mod the network'));
        });
    } finally { await done(t); }
})();
