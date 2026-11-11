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
    htmlRawKB: 69.5, // 69.5 openvibe-shared v4.202.0 (2026-11-11: measured 69.2, raised by pin-bump from 69); 69: measured 68.9 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 67.4: measured 65.4 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    htmlBrotliKB: 14.5, // 14.5: measured 14.3 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 13.1 with the phone folds (2026-10-30); 11.5 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 10.0 with those sections (2026-10-22); 7.4
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell adds web-runtime, 2026-10-04)
    jsRawKB: 394.5, // 394.5: measured 394.1 KB raw with openvibe-shared 4.197.0 (2026-11-10: the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 393: measured 392.5 KB raw with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 376.4: measured 376.3 KB raw with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 375.1: measured 367.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 94: measured 93.7 KB brotli with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 3,   // 3 with kit.css (2026-10-29: the home's numbers strip, folds and examples list); 2; 1
    cssRawKB: 89.5, // 89.5: measured 89.0 with openvibe-shared 4.197.0 (2026-11-10: the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 88.6: measured 88.2 with openvibe-shared 4.172.0 (the paste form's segmented control, the page head), 2026-11-09
    cssBrotliKB: 19.0, // 19.0: measured 18.6 with openvibe-shared 4.197.0 (2026-11-10: the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 18.3: measured 17.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
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
        // 45 s, not 15: the shared host's PGlite boot (now including the D11 config tables) can take that long under load.
        for (let i = 0; i < 450 && !up; i++) {
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
