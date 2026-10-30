'use strict';
// Size budgets for openvibe.services' home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit a little above the
// 2026-09-29 measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

const BUDGETS = {
    htmlRawKB: 60,   // 57.4 with the home as a taste and a door (2026-10-29: the building blocks as a launcher with 15 inline ring icons; the text-only service catalog, what-you-can-build and integration cards it replaced measured 54.5 on Shared 4.38.0); 50.7 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 46.0 with the twelve text-only building blocks (plan track K, 2026-10-24); 42.9 with the home's own sections (2026-10-22: the platform in numbers, nine text-only "what you can build" cards, three quick-start samples, six FAQs and their FAQPage JSON-LD); 33.7 with openvibe-contracts 0.209 (2026-10-20: Blog, Reviews, Wiki, Coupons, Deals, Trade, Space, Host and News opened capabilities to apps, so the text-only catalog of services you can build on lists them); 30.8 on 2026-10-08 (six ring icons plus that catalog)
    htmlBrotliKB: 13,   // 11.5 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 10.0 with those sections (2026-10-22); 7.4
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell adds web-runtime, 2026-10-04)
    jsRawKB: 322,   // 321.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 318.1 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 315.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 307.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 300.5 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 293 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 263.4 with shared 4.11.0's seasonal navbar; 254.1 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 246.2 with openvibe-shared 4.2.x (Ask Actor in the navbar, 2026-10-15); 239.1 (212.2 before openvibe-shared/shell's web-runtime.js)
    jsBrotliKB: 79,   // 78.2 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 59.1 with openvibe-shared 4.4.0 (every site in the launcher, 2026-10-17); 56.3 (49.9 before web-runtime.js)
    cssFiles: 3,   // 3 with kit.css (2026-10-29: the home's numbers strip, folds and examples list); 2; 1
    cssRawKB: 63,   // 61.7 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 58.2 with kit.css (25.6 KB raw; 34.0 before on Shared 4.38.0): the numbers as one kit.stats strip, what is read once in kit.fold and the examples as kit rows, which took the phone home from 16.1 screens to 5.8; 31.8 openvibe-shared 4.26.1 (hero visual); 26.3 with Shared 4.13.0 (2026-10-26: account links); 20.3 with the numbers and FAQ styles (2026-10-22); 17.3 (services.css + the cached /shared/showcase.css)
    cssBrotliKB: 13,   // 12.1 with kit.css (2026-10-29; 7.3 before); 5.8 with Shared 4.13.0 (2026-10-26: account links); 4.1
    externalFiles: 2,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', SERVICES_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (SERVICES_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
