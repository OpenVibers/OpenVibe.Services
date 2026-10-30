'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the parts a reader rarely needs are folds: closed on
 * a phone, open where there is room, and their content stays in the page for crawlers.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    await check('the home on a phone: the parts read once are folds', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        const text = r.text;

        // The folds: open in the page, closed on a phone, and their content stays in the page.
        for (const id of ['how', 'reference', 'faq', 'network', 'shipped']) {
            assert.ok(text.includes(`<details class="svc-fold svc-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
            assert.ok(text.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
        }
        // The content of every fold is still in the page.
        assert.ok(text.includes('Create a project'), 'the path from account to integration is still in the page');
        assert.ok(text.includes('API explorer'), 'the reference is still in the page');
        assert.ok(text.includes('What does it cost?'), 'the questions are still in the page');
        assert.ok(text.includes('Part of OpenVibe'), 'the other OpenVibe places are still in the page');
        assert.ok(text.includes('ov-shipped-home'), 'what shipped is still in the page');

        // The hero and the first useful thing stay where they are.
        assert.match(text, /<h1[\s>]/, 'the hero is still there');
        assert.match(text, /Create a project<\/a>/, 'the main action is still there');
        assert.match(text, /id="blocks"/, 'the building blocks are still there');
        assert.match(text, /id="quick-start"/, 'the quick start is still there');

        // The CSS guard: the fold is a section heading where there is room and a closed card on a phone.
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'services.css'), 'utf8');
        assert.match(css, /\.svc-fold-block > summary \{[^}]*min-height: 48px/, 'the fold is a 48 px target');
        assert.match(css, /\.svc-fold-block \.sc-sec > h2 \{ display: none; \}/, 'the fold\'s heading replaces the section\'s own');
        assert.match(css, /@media \(min-width: 641px\) \{/, 'where there is room the fold looks like the section it replaces');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
