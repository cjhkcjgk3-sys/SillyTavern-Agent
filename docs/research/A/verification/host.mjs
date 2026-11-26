import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve('tests/package.json'));
const { chromium } = require('playwright');
const lab = 'http://127.0.0.1:18767';
const endpoint = 'http://127.0.0.1:18768';
const book = 'Research A Fiction';
const marker = 'researchcity';
const tool = name => 'worldbook_workbench_' + name;
let plan = [];
const streamStarted = Promise.withResolvers();
const streamClosed = Promise.withResolvers();
const trace = [];
const issue = [];
const vertex = [];
const server = createServer(async (request, response) => {
    try {
        if (request.method === 'GET') {
            response.setHeader('Content-Type', 'application/json');
            return response.end(JSON.stringify({ data: [{ id: 'research-alias' }] }));
        }
        const raw = [];
        for await (const chunk of request) raw.push(chunk);
        const body = JSON.parse(Buffer.concat(raw));
        response.setHeader('Content-Type', 'application/json');
        if (request.url.startsWith('/v1/publishers/')) {
            const modalities = body.contents.flatMap(message => message.parts).map(part => part.inlineData?.mimeType ?? part.inline_data?.mime_type).filter(Boolean);
            vertex.push({ path: request.url, modalities, tools: body.tools?.map(item => Object.keys(item)[0]), mode: body.toolConfig?.functionCallingConfig?.mode, config: body.generationConfig });
            if (request.url.includes('/rate-limit:')) {
                return response.writeHead(429).end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'synthetic rate limit' } }));
            }
            const payload = {
                candidates: [{ content: { role: 'model', parts: [{ text: 'synthetic vertex response' }] }, finishReason: 'MAX_TOKENS' }],
                usageMetadata: { promptTokenCount: 31, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
            };
            if (request.url.includes('streamGenerateContent')) {
                response.setHeader('Content-Type', 'text/event-stream');
                return response.end('data: ' + JSON.stringify(payload) + '\n\n');
            }
            return response.end(JSON.stringify(payload));
        }
        const entry = plan.shift();
        assert.ok(entry, 'unexpected Custom generation');
        const lastResult = body.messages.findLast(message => message.role === 'tool');
        const wire = JSON.stringify(body.messages.filter(message => message.role === 'system'));
        trace.push({
            path: request.url, model: body.model, stream: body.stream, tools: body.tools?.map(item => item.function.name),
            toolResult: lastResult?.content, oldPrompt: wire.includes('LOC_NORTH'), newPrompt: wire.includes('LOC_SOUTH'),
        });
        const message = { role: 'assistant', content: entry.text ?? null };
        const calls = entry.calls ?? (entry.call ? [entry] : []);
        if (calls.length) message.tool_calls = calls.map((call, index) => ({
            id: 'call_' + trace.length + '_' + index, type: 'function',
            function: { name: tool(call.call), arguments: JSON.stringify(call.args(lastResult?.content)) },
        }));
        const finish = calls.length ? 'tool_calls' : 'stop';
        if (entry.hold) {
            response.setHeader('Content-Type', 'text/event-stream');
            response.once('close', streamClosed.resolve);
            response.write('data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: null }] }) + '\n\n');
            streamStarted.resolve();
            return;
        }
        if (body.stream) {
            response.setHeader('Content-Type', 'text/event-stream');
            response.write('data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: finish }] }) + '\n\n');
            return response.end('data: [DONE]\n\n');
        }
        return response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
    } catch (error) {
        issue.push(error.message);
        response.writeHead(500).end();
    }
});
await new Promise(resolve => server.listen(18768, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
    const page = await browser.newPage();
    page.on('console', message => {
        if (process.env.ST_PROBE_DEBUG) console.error('browser', message.type(), message.text());
    });
    page.on('pageerror', error => console.error('pageerror', error.message));
    await page.goto(lab);
    await page.waitForFunction(() => !document.querySelector('#preloader') && !!window.SillyTavern, { timeout: 30000 });
    await page.locator('[data-book]').waitFor({ state: 'attached' });
    await page.evaluate(async ({ book, marker, endpoint }) => {
        const st = await import('/script.js');
        const wi = await import('/scripts/world-info.js');
        const { oai_settings: settings } = await import('/scripts/openai.js');
        const { ToolManager } = await import('/scripts/tool-calling.js');
        ToolManager.RECURSE_LIMIT = 10;
        st.eventSource.on(st.event_types.GENERATION_AFTER_COMMANDS, () => st.setOnlineStatus('Valid'));
        const wb = { entries: {} };
        Object.assign(wi.createWorldInfoEntry(book, wb), { comment: 'Capital', key: [marker], content: 'LOC_NORTH', selective: false });
        Object.assign(wi.createWorldInfoEntry(book, wb), { comment: 'Harbor', key: ['harbor'], content: 'ROUTE_NORTH', disable: true });
        await wi.saveWorldInfo(book, wb, true);
        await wi.updateWorldInfoList();
        wi.selected_world_info.splice(0, Infinity, book);
        Object.assign(window.SillyTavern.getContext().extensionSettings.worldbook_workbench, { enabled: true, book, mode: 'direct' });
        await st.newAssistantChat({ temporary: true });
        st.changeMainAPI('openai');
        Object.assign(settings, {
            chat_completion_source: 'custom', custom_url: endpoint + '/v1', custom_model: 'research-alias',
            custom_prompt_post_processing: '', function_calling: true, stream_openai: false,
        });
        st.setOnlineStatus('Valid');
    }, { book, marker, endpoint });

    const send = async (message, stream = false) => page.evaluate(async ({ message, stream }) => {
        const st = await import('/script.js');
        const openai = await import('/scripts/openai.js');
        openai.oai_settings.stream_openai = stream;
        st.setOnlineStatus('Valid');
        document.querySelector('#send_textarea').value = message;
        await st.Generate('normal');
        return st.chat.at(-1)?.mes;
    }, { message, stream });
    const read = async () => page.evaluate(async name => {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({ name }),
        });
        assertBrowser(response.ok);
        return response.json();
        function assertBrowser(value) { if (!value) throw new Error('read failed'); }
    }, book);

    plan = [
        { call: 'search', args: () => ({ query: 'Capital' }) },
        { call: 'read', args: raw => ({ uid: JSON.parse(raw).entries[0].uid }) },
        { call: 'write', args: raw => ({ uid: JSON.parse(raw).uid, base_revision: JSON.parse(raw).revision, content: 'LOC_SOUTH', reason: 'synthetic move' }) },
        { call: 'read', args: raw => ({ uid: JSON.parse(raw).uid }) },
        { call: 'search', args: raw => { assert.equal(JSON.parse(raw).content, 'LOC_SOUTH'); return { query: 'Harbor' }; } },
        { call: 'read', args: raw => ({ uid: JSON.parse(raw).entries[0].uid }) },
        { call: 'write', args: raw => {
            assert.equal(JSON.parse(raw).content, 'ROUTE_NORTH');
            return { uid: JSON.parse(raw).uid, base_revision: JSON.parse(raw).revision, content: 'ROUTE_SOUTH', reason: 'synthetic relation' };
        } },
        { text: 'Both entries verified by the synthetic script.' },
    ];
    assert.equal(await send(marker + ' is moving'), 'Both entries verified by the synthetic script.');
    assert.deepEqual(Object.values((await read()).entries).map(entry => entry.content), ['LOC_SOUTH', 'ROUTE_SOUTH']);
    assert.ok(trace[0].oldPrompt, 'active world entry in first request');
    assert.ok(trace.slice(3, 8).some(item => item.newPrompt), 'new world entry in follow-up request');
    assert.equal(trace.length, 8);

    plan = [
        { call: 'write', args: () => ({ title: 'Bridge', keys: ['bridge'], content: 'BRIDGE_NEW', reason: 'synthetic creation' }) },
        { text: 'Streaming chain finished.' },
    ];
    assert.equal(await send('Add a fictional bridge', true), 'Streaming chain finished.');
    assert.ok(Object.values((await read()).entries).some(entry => entry.content === 'BRIDGE_NEW'));
    assert.equal(plan.length, 0);
    assert.deepEqual(issue, []);

    await page.evaluate(book => {
        const settings = window.SillyTavern.getContext().extensionSettings.worldbook_workbench;
        Object.assign(settings, { book, enabled: true, mode: 'review' });
        const panel = document.querySelector('[data-book]');
        panel.dispatchEvent(new Event('focus'));
        panel.value = book;
        panel.dispatchEvent(new Event('change'));
    }, book);
    plan = [
        { call: 'read', args: () => ({ uid: 0 }) },
        { call: 'write', args: raw => ({ uid: 0, base_revision: JSON.parse(raw).revision, content: 'LOC_EAST', reason: 'synthetic approval' }) },
        { text: 'Waiting for review.' },
    ];
    assert.equal(await send('Draft a fictional correction'), 'Waiting for review.');
    assert.equal((await read()).entries[0].content, 'LOC_SOUTH');
    await page.getByRole('button', { name: '确认并应用', includeHidden: true }).evaluate(element => element.click());
    await page.waitForFunction(() => document.querySelector('[data-drafts]').textContent.includes('暂无待确认修改'));
    assert.equal((await read()).entries[0].content, 'LOC_EAST');
    await page.getByRole('button', { name: '撤销这次修改', exact: true, includeHidden: true }).first().evaluate(element => element.click());
    await page.waitForFunction(() => document.querySelector('[data-history]').textContent.includes('已撤销'));
    assert.equal((await read()).entries[0].content, 'LOC_SOUTH');
    await page.route('**/api/worldinfo/edit', route => route.fulfill({ status: 500, body: 'synthetic write error' }));
    const failedSave = await page.evaluate(async name => {
        const wi = await import('/scripts/world-info.js');
        const changed = structuredClone(await wi.loadWorldInfo(name));
        changed.entries[0].content = 'FAILED_ONLY_IN_CACHE';
        try { await wi.saveWorldInfo(name, changed, true); } catch { return { rejected: true }; }
        return { cached: (await wi.loadWorldInfo(name)).entries[0].content };
    }, book);
    await page.unroute('**/api/worldinfo/edit');
    assert.equal(failedSave.cached, 'FAILED_ONLY_IN_CACHE');
    assert.equal((await read()).entries[0].content, 'LOC_SOUTH');
    plan = [
        { calls: [{ call: 'read', args: () => ({ uid: 9999 }) }, { call: 'read', args: () => ({ uid: 0 }) }] },
        { text: 'Combined tool reply finished.' },
    ];
    const toolErrorRound = await send('Read two synthetic entries');
    assert.equal(toolErrorRound, 'Combined tool reply finished.');
    const toolHistory = await page.evaluate(async () => {
        const { chat } = await import('/script.js');
        return chat.findLast(message => Array.isArray(message.extra?.tool_invocations)).extra.tool_invocations.map(item => ({ id: item.id, error: item.error, result: item.result }));
    });
    assert.deepEqual(toolHistory.map(item => item.error), [true, false]);
    assert.match(toolHistory[0].result, /未找到条目/);
    assert.equal(JSON.parse(toolHistory[1].result).content, 'LOC_SOUTH');

    plan = [{ hold: true, text: 'Synthetic partial stream.' }];
    const ongoing = send('Wait for one streamed fixture', true);
    const bounded = promise => Promise.race([promise, new Promise((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for the streaming probe')), 6000);
        timeout.unref();
    })]);
    await bounded(streamStarted.promise);
    await page.evaluate(async () => (await import('/script.js')).stopGeneration());
    const streamEnd = await bounded(ongoing.then(() => 'settled', () => 'stopped with rejection'));
    await bounded(streamClosed.promise);
    assert.equal(plan.length, 0);
    const crossBrowser = await browser.newPage();
    await crossBrowser.goto(lab);
    assert.equal(await crossBrowser.evaluate(() => localStorage.getItem('worldbook_workbench_v1')), null);
    await crossBrowser.close();
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#preloader') && !!window.SillyTavern);
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('worldbook_workbench_v1')).history.length >= 4));

    const api = await page.evaluate(async endpoint => {
        const st = await import('/script.js');
        const openai = await import('/scripts/openai.js');
        const { ToolManager } = await import('/scripts/tool-calling.js');
        st.changeMainAPI('openai');
        Object.assign(openai.oai_settings, { chat_completion_source: 'vertexai', media_inlining: true, function_calling: true, custom_prompt_post_processing: '' });
        const detect = model => {
            openai.oai_settings.vertexai_model = model;
            return [openai.isImageInliningSupported(), openai.isVideoInliningSupported(), openai.isAudioInliningSupported(), ToolManager.isToolCallingSupported()];
        };
        const frontend = { known: detect('gemini-3.7-flash'), alias: detect('research-alias') };
        const definitions = [{ type: 'function', function: { name: 'fiction_lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } } }];
        const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jazUAAAAASUVORK5CYII=';
        const base = {
            chat_completion_source: 'vertexai', reverse_proxy: endpoint, proxy_password: 'fixture',
            messages: [{ role: 'user', content: [
                { type: 'text', text: 'fiction only' },
                { type: 'image_url', image_url: { url: image } },
                { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,QUJD' } },
                { type: 'video_url', video_url: { url: 'data:video/mp4;base64,REVG' } },
                { type: 'input_file', input_file: { mime_type: 'application/pdf', data: 'R0hJ' } },
            ] }],
            model: 'gemini-3.7-flash', max_tokens: 64, temperature: 0.5, top_p: 0.8, top_k: 16, enable_web_search: true,
            reasoning_effort: 'low', include_reasoning: true, tool_choice: 'auto', tools: definitions,
        };
        const post = async extra => {
            const response = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders(),
                body: JSON.stringify({ ...base, ...extra }),
            });
            return { status: response.status, body: await response.text() };
        };
        return {
            frontend,
            known: await post({}),
            alias: await post({ model: 'research-alias' }),
            search: await post({ tools: [], tool_choice: undefined, stream: true }),
            rateLimit: await post({ model: 'rate-limit' }),
            format: await post({
                tools: [], tool_choice: undefined, enable_web_search: false,
                json_schema: { name: 'fixture', value: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
            }),
            imageOutput: await post({ model: 'gemini-3.1-flash-image', request_images: true }),
            missing: await post({ reverse_proxy: '', vertexai_auth_mode: 'express' }),
        };
    }, endpoint);
    assert.deepEqual(api.frontend.known, [true, true, true, true]);
    assert.deepEqual(api.frontend.alias, [false, false, false, true]);
    assert.equal(api.known.status, 200);
    assert.equal(api.alias.status, 200);
    assert.equal(api.search.status, 200);
    assert.equal(api.missing.status, 400);
    assert.equal(api.rateLimit.status, 500);
    assert.ok(api.rateLimit.body.includes('RESOURCE_EXHAUSTED'));
    assert.deepEqual(vertex[0].tools, ['function_declarations']);
    assert.deepEqual(vertex[0].modalities, ['image/png', 'audio/wav', 'video/mp4']);
    assert.ok(vertex[0].config.thinkingConfig);
    assert.equal(vertex[0].config.temperature, undefined);
    assert.equal(vertex[1].config.thinkingConfig, undefined);
    assert.deepEqual(vertex[2].tools, ['google_search']);
    assert.equal(api.format.status, 200);
    assert.equal(vertex[4].config.responseMimeType, 'application/json');
    assert.equal(vertex[4].config.responseSchema.properties.key.type, 'string');
    assert.equal(api.imageOutput.status, 200);
    assert.deepEqual(vertex[5].config.responseModalities, ['text', 'image']);
    assert.equal(vertex[5].tools, undefined);
    assert.deepEqual(issue, []);
    assert.ok(api.search.body.includes('MAX_TOKENS') && api.search.body.includes('usageMetadata'));
    assert.ok(!api.known.body.includes('MAX_TOKENS') && !api.known.body.includes('usageMetadata'));
    console.log(JSON.stringify({ checks: ['T02', 'T03', 'T04', 'T05', 'T19', 'T20'], trace, vertex, api, failedSave, toolHistory, streamEnd, mockStreamClosed: true }, null, 2));
} catch (error) {
    console.error(error, JSON.stringify({ trace, issue, vertex }, null, 2));
    throw error;
} finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
