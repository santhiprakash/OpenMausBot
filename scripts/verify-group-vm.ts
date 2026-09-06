import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { launchVerificationServer, runControlOmb } from './control-omb.ts';
const podman = process.env.OMB_VERIFY_PODMAN;
const machine = process.env.OMB_VERIFY_MACHINE;
if (!podman || !machine)
    throw Error('Set OMB_VERIFY_PODMAN and OMB_VERIFY_MACHINE explicitly');
const connection = JSON.parse(execFileSync(podman, ['system', 'connection', 'list', '--format', 'json'], { encoding: 'utf8' })).find(x => x.Name === machine);
if (!connection)
    throw Error('The requested Podman connection does not exist');
const fixture = await launchVerificationServer(process.env, undefined, { binDir: dirname(podman), host: connection.URI, sshKey: connection.Identity, staticDir: resolve('dist') });
const api = async (path, body, method = body ? 'POST' : 'GET') => { const r = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (!r.ok)
    throw Error(path + ': ' + await r.text()); return r.json(); };
const ids = [];
const evidence = [];
try {
    console.log(JSON.stringify({ stage: 'isolated-fixture', ...fixture.info }));
    await api('/api/config', { localVm: { mode: 'per-bot', maxInstances: 2 } }, 'PUT');
    for (const name of ['Fixture GUI A', 'Fixture GUI B']) {
        const b = (await api('/api/bots', { name })).bot;
        ids.push(b.id);
        await api('/api/bots/' + b.id, { computer: 'vm' }, 'PATCH');
        await api('/api/bots/' + b.id + '/local-computer/run', {});
        console.log(JSON.stringify({ stage: 'fixture-desktop', id: b.id }));
    }
    const g = (await api('/api/groups', { name: 'Isolated Goal GUI routing', memberIds: ids, setup: { bulletin: 'Fixture only', defaultResponder: { kind: 'member', botId: ids[0] } } })).group;
    for (const id of ids) {
        await api('/api/groups/' + g.id, { defaultResponder: { kind: 'member', botId: id } }, 'PATCH');
        await api('/api/groups/' + g.id + '/messages', { mode: 'goal', text: 'Reply once for isolated GUI routing verification.' });
        const wait = await runControlOmb(['wait', '--channel', g.id, '--timeout', '60', '--url', fixture.info.url]);
        assert.equal(wait.status, 'settled', 'Goal turn must settle');
        const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, 'fake-claude-dump.json'), 'utf8'));
        const computer = dump.mcpConfig?.mcpServers?.computer;
        assert(computer, 'Goal speaker must receive computer MCP');
        const target = (await api('/api/bots/' + id + '/local-computer')).container_name;
        assert(computer.args.includes(target), 'MCP must target exactly the speaking bot GUI container');
        assert(String(dump.systemPrompt).includes('computer'), 'Goal must include computer instructions');
        evidence.push({ id, computerArgs: computer.args, target, status: wait.status });
    }
    assert.notDeepEqual(evidence[0].computerArgs, evidence[1].computerArgs, 'Different speakers must use different desktops');
    const off = ids[0];
    await api('/api/bots/' + off, { computer: 'off' }, 'PATCH');
    await api('/api/groups/' + g.id, { defaultResponder: { kind: 'member', botId: off } }, 'PATCH');
    await api('/api/groups/' + g.id + '/messages', { mode: 'goal', text: 'Reply once without computer.' });
    await runControlOmb(['wait', '--channel', g.id, '--timeout', '60', '--url', fixture.info.url]);
    const offDump = JSON.parse(readFileSync(join(fixture.info.dataDir, 'fake-claude-dump.json'), 'utf8'));
    assert(!offDump.mcpConfig?.mcpServers?.computer, 'Computer off must not receive desktop tools');
    mkdirSync('docs/verification/evidence', { recursive: true });
    writeFileSync('docs/verification/evidence/group-vm-routing.json', JSON.stringify({ passed: true, fixture: fixture.info.url, evidence, computerOff: true }, null, 2));
    console.log(JSON.stringify({ passed: true, evidence, computerOff: true }));
}
finally {
    for (const id of ids)
        await api('/api/bots/' + id + '/local-computer/remove', {}).catch(e => console.error(e.message));
    await fixture.close();
}
