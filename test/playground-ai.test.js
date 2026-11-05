'use strict';
/**
 * The AI playground (AI Exchange P8): one chat reply as the APP, with its own ai.app.run token (AI Exchange D8'), behind
 * SERVICES_AI_PLAYGROUND. Refused without the grant (nothing requested); with it, the app token goes to OpenVibe AI,
 * the reply and the openvibe disclosure are shown once, and the run log keeps neither the prompt nor the reply.
 */
const assert = require('assert');
const http = require('http');

(async () => {
    // A fake OpenVibe AI: answers one chat completion with a disclosure, and remembers what it was asked.
    const asked = [];
    const ai = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            asked.push({ path: req.url, auth: req.headers.authorization || '', body: body ? JSON.parse(body) : null });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl_test1', model: 'qwen/qwen3-4b:q4_k_m@3f2a1c9',
                choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from a tiny model here.' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
                x_openvibe: { run_id: 'run_test1', provider: 'own', fallback_used: false, cost_usd: 0, resolved_model: 'qwen/qwen3-4b:q4_k_m@3f2a1c9', revision: '3f2a1c9', provider_access: 'OWN_DEPLOYMENT', policy: 'balanced', rate_version: 'r-7', fallback_reason: null },
            }));
        });
    });
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    process.env.SERVICES_PLAYGROUND_AI_URL = `http://127.0.0.1:${ai.address().port}`;
    const { boot, check, done } = require('./helpers/boot');
    const { aiInput } = require('../server/domain/playground');

    await check('the input: an exact id or a dynamic name, a prompt, a capped reply', async () => {
        assert.deepStrictEqual(aiInput({ model: 'openvibe/auto', prompt: 'hi', max_tokens: 99999 }).body.max_tokens, 1024);
        assert.match(aiInput({ model: 'bad model!', prompt: 'hi' }).error, /exact id/);
        assert.match(aiInput({ model: 'openvibe', prompt: '' }).error, /write a prompt/);
        assert.match(aiInput({ model: 'openvibe', prompt: 'x'.repeat(4001) }).error, /4,000/);
    });

    // AI Exchange D10: openvibe.ai accepts sandbox app tokens (Network's DEV_SANDBOX_AUDIENCES at launch; AI spends only
    // sandbox credit on them). The Network mock is started with it.
    const t = await boot({ network: { sandboxAudiences: ['openvibe.events', 'openvibe.media', 'openvibe.ai'] } });
    // The test boot builds its config from a fixed environment: the AI playground's switch and endpoint are set on it.
    await t.ctx.aiConfig.store.apply({ ai_playground: true }, { actor: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, reason: 'test: open the playground' });
    t.config.playground.aiUrl = process.env.SERVICES_PLAYGROUND_AI_URL;
    const owner = t.network.addUser('ana');
    const projectId = await t.project(owner, 'Ask');
    const app = await t.app(owner, projectId);
    const base = `/projects/${projectId}/apps/${app.id}`;
    const ask = (fields) => t.get(`${base}/playground/ai`, { as: owner, form: { model: 'openvibe', prompt: 'Say hello in five words.', max_tokens: '64', ...fields } });
    try {
        await check('without ai.app.run: refused at the grant step, OpenVibe AI never called', async () => {
            const r = await ask({ credential_type: 'client_secret', credential: app.secret });
            assert.strictEqual(r.status, 403, String((r.text.match(/<div class="(?:result|notice)[^>]*>[\s\S]{0,300}/) || [r.status])[0]));
            assert.match(r.text, /does not hold ai\.app\.run/);
            assert.strictEqual(asked.length, 0);
            const page = await t.get(`${base}/playground`, { as: owner });
            assert.match(page.text, /AI: one chat reply/);
            assert.ok(!page.text.includes(`action="${base}/playground/ai"`), 'no form without the grant');
        });

        {   // the success path: ai.app.run is the existing public capability apps call AI with (D8')
        await check('with the grant: the app token goes to OpenVibe AI; the reply and what answered are shown', async () => {
            await t.grant(owner, projectId, app.id, 'ai.app.run');   // through Services' own grant flow (D8, Contracts v0.284.0)
            const r = await ask({ credential_type: 'client_secret', credential: app.secret });
            assert.strictEqual(r.status, 200, String((r.text.match(/<div class="result[^>]*>[\s\S]{0,400}/) || [r.status])[0]));
            assert.strictEqual(asked.length, 1);
            assert.strictEqual(asked[0].path, '/v1/chat/completions');
            assert.match(asked[0].auth, /^Bearer ey/, 'the app\'s own token, never a secret of Services');
            assert.ok(!asked[0].auth.includes(app.secret), 'the client secret never leaves for AI');
            assert.deepStrictEqual(asked[0].body, { model: 'openvibe', messages: [{ role: 'user', content: 'Say hello in five words.' }], max_tokens: 64, stream: false });
            assert.match(r.text, /<blockquote class="ai-answer">Hello from a tiny model here\.<\/blockquote>/);
            assert.match(r.text, /Answered by <code>qwen\/qwen3-4b:q4_k_m@3f2a1c9<\/code>/);
            assert.match(r.text, /OWN_DEPLOYMENT/);
            assert.match(r.text, /12 tokens in · 7 out/);
        });

        await check('the run log keeps neither the prompt nor the reply', async () => {
            const page = await t.get(`${base}/playground`, { as: owner });
            const log = page.text.slice(page.text.indexOf('Recent runs'));
            assert.match(log, /answered by qwen\/qwen3-4b:q4_k_m@3f2a1c9/);
            assert.ok(!log.includes('Say hello in five words'), 'no prompt in the log');
            assert.ok(!log.includes('Hello from a tiny model'), 'no reply in the log');
            const dump = await t.dbDump();
            assert.ok(!dump.includes('Say hello in five words') && !dump.includes('Hello from a tiny model'), 'nor anywhere in the database');
        });
        }
    } finally {
        await t.close();
        ai.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
