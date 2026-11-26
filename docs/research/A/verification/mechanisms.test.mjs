import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import tiktoken from 'tiktoken';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function openDatabase(file) {
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS book (id TEXT PRIMARY KEY, value TEXT, revision INTEGER);
        CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, scope TEXT, phase TEXT, directive TEXT);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, book TEXT, before TEXT, after TEXT, revision INTEGER);
        INSERT OR IGNORE INTO book VALUES ('capital', 'north', 0), ('harbor', 'north', 0);
        INSERT OR IGNORE INTO task VALUES ('task', 'capital', 'working', 'update route');
    `);
    return db;
}

function transaction(db, action) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = action();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

function edit(db, { id, book, beforeRevision, after }) {
    const previous = db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    if (previous) {
        if (previous.book !== book || previous.after !== after || previous.revision !== beforeRevision + 1) {
            throw new Error('operation identity reused with different payload');
        }
        return 'replayed';
    }
    const current = db.prepare('SELECT * FROM book WHERE id=?').get(book);
    if (current?.revision !== beforeRevision) throw new Error('revision conflict');
    db.prepare('UPDATE book SET value=?, revision=revision+1 WHERE id=?').run(after, book);
    db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?)').run(id, book, current.value, after, beforeRevision + 1);
    return 'written';
}

const firstEdit = { id: 'edit-1', book: 'capital', beforeRevision: 0, after: 'south' };
if (process.argv[2] === '--commit-and-exit') {
    const db = openDatabase(process.argv[3]);
    const action = () => {
        edit(db, firstEdit);
        if (process.argv[4] === 'before-commit') process.exit(92);
        db.prepare("UPDATE task SET phase='working' WHERE id='task'").run();
    };
    transaction(db, action);
    process.exit(93);
}

function fixture(t) {
    const folder = mkdtempSync(join(tmpdir(), 'st-research-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const file = join(folder, 'fiction.sqlite');
    const db = openDatabase(file);
    t.after(() => db.close());
    return { db, file };
}

test('T06 committed and uncommitted process exits are distinguishable and replay is idempotent', t => {
    const { db, file } = fixture(t);
    const crash = mode => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--commit-and-exit', file, mode]).status;
    const capital = () => db.prepare("SELECT value, revision FROM book WHERE id='capital'").get();
    assert.equal(crash('before-commit'), 92);
    assert.deepEqual(Object.values(capital()), ['north', 0]);
    assert.equal(crash('after-commit'), 93);
    assert.deepEqual(Object.values(capital()), ['south', 1]);
    assert.equal(transaction(db, () => edit(db, firstEdit)), 'replayed');
    assert.throws(() => transaction(db, () => edit(db, { ...firstEdit, after: 'west' })), /different payload/);
    assert.deepEqual(Object.values(capital()), ['south', 1]);
});

test('T07 whole batch rollback and stale external revision rejection', t => {
    const { db } = fixture(t);
    const harbor = { id: 'edit-2', book: 'harbor', beforeRevision: 0, after: 'south' };
    transaction(db, () => edit(db, { ...harbor, id: 'human', after: 'east' }));
    assert.throws(() => transaction(db, () => {
        edit(db, firstEdit);
        edit(db, harbor);
    }), /revision conflict/);
    assert.deepEqual(db.prepare('SELECT value FROM book ORDER BY id').all().map(row => row.value), ['north', 'east']);
    assert.deepEqual(db.prepare('SELECT id FROM operations').all().map(row => row.id), ['human']);
});

test('T08 persisted approval, scope binding and new directive after reconnect', t => {
    const { db, file } = fixture(t);
    db.prepare("UPDATE task SET phase='waiting' WHERE id='task'").run();
    const resumed = openDatabase(file);
    t.after(() => resumed.close());
    const readTask = () => resumed.prepare("SELECT phase, scope, directive FROM task WHERE id='task'").get();
    const approve = (scope, directive) => resumed.prepare("UPDATE task SET phase='working', directive=? WHERE id='task' AND phase='waiting' AND scope=?").run(directive, scope).changes;
    assert.equal(readTask().phase, 'waiting');
    assert.equal(approve('harbor', 'incorrect scope'), 0);
    assert.equal(approve('capital', 'keep bridge open'), 1);
    assert.equal(approve('capital', 'repeat'), 0);
    assert.equal(readTask().directive, 'keep bridge open');
});

test('T09 bounded independent synthetic workers, errors, cancellation and remaining work', async () => {
    const root = new AbortController();
    const active = new Set();
    const inputs = [{ name: 'capital', facts: ['capital only'] }, { name: 'harbor', facts: ['harbor only'] }];
    const snapshots = [];
    const worker = async ({ name, facts }, { fail = false, duration = 10 } = {}) => {
        const context = structuredClone(facts);
        if (root.signal.aborted) return 'paused';
        active.add(name);
        snapshots.push({ name, facts: context, active: active.size });
        try {
            await sleep(duration, null, { signal: root.signal });
            if (fail) throw new Error('fixture worker failure');
            return context[0];
        } finally {
            active.delete(name);
        }
    };
    const results = await Promise.allSettled([worker(inputs[0]), worker(inputs[1], { fail: true })]);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
    assert.equal(results[0].value, 'capital only');
    assert.deepEqual(snapshots[1], { name: 'harbor', facts: ['harbor only'], active: 2 });
    const pending = worker(inputs[0], { duration: 1000 });
    root.abort('budget consumed');
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(await worker(inputs[1]), 'paused');
    assert.equal(active.size, 0);
});

test('T10 deterministic fictional compression, retention and live result reference', t => {
    const { db } = fixture(t);
    const critical = [
        '用户硬约束：避开第二人称。', '决策：三城共用历法。', '创意：桥下保留旧档案。',
        '关系：船坞补给首府。', '否决：北线结冰导致运输中断。', '修复：两处桥名统一。',
        '待办：验证春汛路线。', '事实：每月只有二十六日。',
    ];
    const original = Array.from({ length: 600 }, (_, i) => ({
        text: `第${i}段。庭院、历法、交通、贸易、合约、桥梁、人口、行政和关联事件的虚构讨论。编号${i}。`,
        pin: false,
    }));
    critical.forEach((text, i) => { original[i * 67] = { text, pin: true }; });
    const compact = (older, keep) => older.filter(item => (keep ? item.pin : false));
    let memory = [];
    for (let i = 0; i < 3; i++) memory = compact([...memory, ...original.slice(i * 190, (i + 1) * 190)], true);
    const fixed = '固定指令：读取正式设定后更新待办。';
    const reference = { book: 'capital' };
    transaction(db, () => edit(db, firstEdit));
    const buildContext = () => [fixed, ...memory.map(item => item.text), ...original.slice(-30).map(item => item.text),
        db.prepare('SELECT value FROM book WHERE id=?').get(reference.book).value].join('\n');
    const result = buildContext();
    assert.ok(critical.every(text => result.includes(text)));
    assert.ok(!critical.some(text => compact(original.slice(0, -30), false).some(item => item.text === text)));
    assert.ok(result.endsWith('south'));
    assert.equal(original.length, 600);
    const before = Buffer.byteLength(original.map(item => item.text).join('\n'));
    const after = Buffer.byteLength(result);
    assert.ok(after < before / 10);
    const tokenCounts = Object.fromEntries(['cl100k_base', 'o200k_base'].map(name => {
        const tokenizer = tiktoken.get_encoding(name);
        const counts = [tokenizer.encode(original.map(item => item.text).join('\n')).length, tokenizer.encode(result).length];
        tokenizer.free();
        assert.ok(counts[1] < counts[0] / 10);
        return [name, counts];
    }));
    t.diagnostic(JSON.stringify({ originalRecords: original.length, cycles: 3, retained: critical.length, beforeUtf8Bytes: before, afterUtf8Bytes: after, tokenCounts }));
});

test('T15 external storage partial commit is visible, retries and guarded rollback preserve edits', async t => {
    const { db } = fixture(t);
    const external = new Map([['capital', 'north'], ['harbor', 'north']]);
    const modify = (book, value) => {
        if (book === 'harbor') throw new Error('synthetic I/O failure');
        external.set(book, value);
    };
    db.exec(`CREATE TABLE batch (id TEXT PRIMARY KEY, book TEXT, previous TEXT, next TEXT, state TEXT);
      INSERT INTO batch VALUES ('a', 'capital', 'north', 'south', 'planned'), ('b', 'harbor', 'north', 'south', 'planned');`);
    const results = () => db.prepare('SELECT * FROM batch ORDER BY id').all();
    const setState = db.prepare('UPDATE batch SET state=? WHERE id=?');
    for (const item of results()) {
        try {
            modify(item.book, item.next);
            assert.equal(external.get(item.book), item.next);
            setState.run('verified', item.id);
        } catch {
            setState.run('unknown', item.id);
        }
    }
    assert.deepEqual(results().map(item => item.state), ['verified', 'unknown']);
    assert.deepEqual([...external.values()], ['south', 'north']);
    // Recovery classifies the unknown operation by rereading before retry.
    const pending = results()[1];
    assert.equal(external.get(pending.book), pending.previous);
    // A person can edit the verified result before attempted compensation.
    external.set('capital', 'east');
    const verified = results()[0];
    const canCompensate = external.get(verified.book) === verified.next;
    assert.equal(canCompensate, false);
    assert.equal(external.get('capital'), 'east');
});

test('T16 independent HTTP model requests share a persisted call budget', async t => {
    const { db } = fixture(t);
    const { createServer } = await import('node:http');
    const requests = [];
    let active = 0;
    let peak = 0;
    const ready = Promise.withResolvers();
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks));
        requests.push(data);
        peak = Math.max(peak, ++active);
        if (requests.length === 2) ready.resolve();
        await ready.promise;
        active--;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ fact: data.context[0] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    db.exec("CREATE TABLE budget (id TEXT PRIMARY KEY, remaining INTEGER); INSERT INTO budget VALUES ('task', 2)");
    const url = 'http://127.0.0.1:' + server.address().port;
    const runChild = async (id, model, context) => {
        const reserved = db.prepare("UPDATE budget SET remaining=remaining-1 WHERE id='task' AND remaining>0").run().changes;
        if (!reserved) {
            db.prepare("UPDATE task SET phase='paused' WHERE id='task'").run();
            return { state: 'paused' };
        }
        const response = await fetch(url, { method: 'POST', body: JSON.stringify({ id, model, context }), signal: AbortSignal.timeout(5000) });
        return response.json();
    };
    const result = await Promise.all([
        runChild('capital', 'fixture-model-a', ['capital only']),
        runChild('harbor', 'fixture-model-b', ['harbor only']),
    ]);
    assert.deepEqual(result, [{ fact: 'capital only' }, { fact: 'harbor only' }]);
    assert.equal(peak, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(await runChild('other', 'fixture-model-b', ['blocked']), { state: 'paused' });
    assert.equal(requests.length, 2);
    assert.equal(db.prepare("SELECT phase FROM task WHERE id='task'").get().phase, 'paused');
});
