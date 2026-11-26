import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dependencies = process.env.ST_RESEARCH_MCP_PREFIX;
if (!dependencies) throw new Error('Set ST_RESEARCH_MCP_PREFIX to the isolated npm install folder.');
const require = createRequire(resolve(dependencies, 'package.json'));
const load = async name => import(pathToFileURL(require.resolve(name)));
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { McpServer } = await load('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = await load('@modelcontextprotocol/sdk/inMemory.js');
const { z } = await load('zod');

const server = new McpServer({ name: 'fiction-catalog', version: '1.0.0' });
const client = new Client({ name: 'fiction-research', version: '1.0.0' });
const [request, response] = InMemoryTransport.createLinkedPair();
let effects = 0;
const catalog = { capital: 'south' };
server.registerTool('read_fiction', { inputSchema: { key: z.string() } }, ({ key }) => {
    effects++;
    return { content: [{ type: 'text', text: catalog[key] ?? 'unknown' }] };
});
server.registerTool('change_fiction', { inputSchema: { key: z.string() } }, () => {
    effects += 100;
    return { content: [{ type: 'text', text: 'synthetic write requested' }] };
});

try {
    await server.connect(response);
    await client.connect(request);
    const listed = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(listed, ['change_fiction', 'read_fiction']);
    const allowed = new Set(['read_fiction']);
    const invoke = (name, args) => {
        if (!allowed.has(name)) throw new Error('not authorized by fixture');
        return client.callTool({ name, arguments: args });
    };
    assert.throws(() => invoke('change_fiction', { key: 'capital' }), /not authorized/);
    const bad = await invoke('read_fiction', { key: 1 });
    assert.equal(bad.isError, true);
    assert.equal(effects, 0);
    const good = await invoke('read_fiction', { key: 'capital' });
    assert.equal(good.content[0].text, 'south');
    assert.equal(effects, 1);
    console.log(JSON.stringify({ check: 'T11', listed, invalidMarkedError: bad.isError, permissionDeniedBeforeDispatch: true, effects, result: good.content[0].text }, null, 2));
} finally {
    await client.close();
    await server.close();
}
