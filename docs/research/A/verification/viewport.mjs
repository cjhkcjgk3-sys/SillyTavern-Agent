import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const { chromium } = createRequire(resolve('tests/package.json'))('playwright');
const browser = await chromium.launch();
const origin = 'http://127.0.0.1:18767';
const title = 'Research A Large Book';
try {
    const results = [];
    for (const [width, height] of [[320, 568], [390, 844], [740, 360], [1280, 900]]) {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.goto(origin);
        await page.waitForFunction(() => !document.querySelector('#preloader') && !!window.SillyTavern);
        const data = await page.evaluate(async ({ title, seed }) => {
            const st = await import('/scripts/world-info.js');
            const { ToolManager } = await import('/scripts/tool-calling.js');
            if (seed) {
                const data = { entries: Object.fromEntries(Array.from({ length: 1200 }, (_, uid) => [uid, {
                    uid, comment: `fiction entry ${uid}`, key: ['all-fiction'], content: uid === 1199 ? 'rareMarker' : 'ordinary entry',
                }])) };
                await st.saveWorldInfo(title, data, true);
            }
            await st.updateWorldInfoList();
            const settings = window.SillyTavern.getContext().extensionSettings.worldbook_workbench;
            Object.assign(settings, { enabled: true, book: title, mode: 'review' });
            const book = document.querySelector('#worldbook-workbench [data-book]');
            book.dispatchEvent(new Event('focus'));
            book.value = title;
            book.dispatchEvent(new Event('change'));
            const invoke = (suffix, args) => ToolManager.invokeFunctionTool('worldbook_workbench_' + suffix, JSON.stringify(args));
            const start = performance.now();
            const all = JSON.parse(await invoke('search', { query: 'all-fiction' }));
            const rare = JSON.parse(await invoke('search', { query: 'rareMarker' }));
            const write = JSON.parse(await invoke('write', { title: 'Review layout', keys: ['fiction'], content: '示例'.repeat(400), reason: 'layout probe' }));
            return { total: all.total, returned: all.entries.length, rare: rare.entries[0]?.uid, hasDraft: !!write.id, milliseconds: Math.round(performance.now() - start) };
        }, { title, seed: width === 320 });
        assert.deepEqual([data.total, data.returned, data.rare, data.hasDraft], [1200, 30, 1199, true]);
        const dialogs = await page.locator('dialog[open]').evaluateAll(nodes => nodes.map(d => ({
            text: d.querySelector('.popup-body')?.innerText.slice(0, 180),
            buttons: [...d.querySelectorAll('button, .popup-button')].map(b => [b.textContent.trim(), b.className]),
        })));
        if (process.env.ST_PROBE_DEBUG) console.error(dialogs);
        for (const dialog of await page.locator('dialog[open]').all()) {
            const dismiss = dialog.locator('.popup-button-ok');
            if (await dismiss.count()) await dismiss.click({ timeout: 3000 });
        }
        await page.locator('#extensions-settings-button > .drawer-toggle').click({ timeout: 5000 });
        const testVisibility = selector => page.locator(selector).evaluate(element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
        });
        const header = '#worldbook-workbench > .inline-drawer-toggle';
        const headerInitiallyVisible = await testVisibility(header);
        // The second step represents navigating the existing extension drawer.
        await page.locator(header).click();
        await page.locator('#worldbook-workbench .wbw-record summary').click();
        const approvalInitiallyVisibleAfterOpeningRecord = await testVisibility('[data-drafts] button:first-of-type');
        const layout = await page.locator('#worldbook-workbench').evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { horizontalOverflow: rect.left < 0 || rect.right > innerWidth };
        });
        results.push({ width, height, headerInitiallyVisible, approvalInitiallyVisibleAfterOpeningRecord, ...layout, ...data });
        await page.close();
    }
    console.log(JSON.stringify({ check: 'T17', results }, null, 2));
} finally {
    await browser.close();
}
