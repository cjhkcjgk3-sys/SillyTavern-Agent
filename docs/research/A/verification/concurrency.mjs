import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const { chromium } = createRequire(resolve('tests/package.json'))('playwright');
const browser = await chromium.launch();
const origin = 'http://127.0.0.1:18767';
const name = 'Research A Two Writers';
try {
    const first = await browser.newPage();
    const second = await browser.newPage();
    for (const page of [first, second]) {
        await page.goto(origin);
        await page.waitForFunction(() => !document.querySelector('#preloader') && !!window.SillyTavern);
    }
    await first.evaluate(async name => {
        const wi = await import('/scripts/world-info.js');
        const book = { entries: {} };
        Object.assign(wi.createWorldInfoEntry(name, book), { comment: 'Capital', content: 'north' });
        Object.assign(wi.createWorldInfoEntry(name, book), { comment: 'Harbor', content: 'coast' });
        await wi.saveWorldInfo(name, book, true);
    }, name);
    const readCached = page => page.evaluate(async name => (await import('/scripts/world-info.js')).loadWorldInfo(name), name);
    const firstSnapshot = await readCached(first);
    const secondSnapshot = await readCached(second);
    firstSnapshot.entries[0].content = 'east';
    secondSnapshot.entries[1].content = 'bay';
    const save = (page, snapshot) => page.evaluate(async ({ name, snapshot }) => {
        const wi = await import('/scripts/world-info.js');
        await wi.saveWorldInfo(name, snapshot, true);
    }, { name, snapshot });
    const readDisk = () => first.evaluate(async name => {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders(),
            body: JSON.stringify({ name }), cache: 'no-store',
        });
        if (!response.ok) throw new Error('fixture read failed');
        return response.json();
    }, name);
    const values = book => Object.values(book.entries).map(entry => entry.content);
    await save(first, firstSnapshot);
    assert.deepEqual(values(await readDisk()), ['east', 'coast']);
    await save(second, secondSnapshot);
    const after = values(await readDisk());
    const firstCache = values(await readCached(first));
    assert.deepEqual(after, ['north', 'bay']);
    assert.deepEqual(firstCache, ['east', 'coast']);

    const checkedRevision = await first.evaluate(async name => {
        const { ToolManager } = await import('/scripts/tool-calling.js');
        Object.assign(window.SillyTavern.getContext().extensionSettings.worldbook_workbench, { book: name, mode: 'direct', enabled: true });
        const raw = await ToolManager.invokeFunctionTool('worldbook_workbench_read', JSON.stringify({ uid: 0 }));
        return JSON.parse(raw).revision;
    }, name);
    const humanNew = await readDisk();
    humanNew.entries[0].content = 'human south';
    await save(second, humanNew);
    const workbenchReject = await first.evaluate(async base_revision => {
        const { ToolManager } = await import('/scripts/tool-calling.js');
        const result = await ToolManager.invokeFunctionTool('worldbook_workbench_write', JSON.stringify({ uid: 0, content: 'old plan west', reason: 'fixture', base_revision }));
        return result instanceof Error ? result.message : result;
    }, checkedRevision);
    assert.match(workbenchReject, /读取后已变化/);
    assert.deepEqual(values(await readDisk()), ['human south', 'bay']);
    console.log(JSON.stringify({ check: 'T18', firstSaved: ['east', 'coast'], diskAfterStaleSave: after, firstContextCacheAfterStaleSave: firstCache, workbenchRejectedStaleRevision: true, diskAfterRejection: values(await readDisk()) }, null, 2));
} finally {
    await browser.close();
}
