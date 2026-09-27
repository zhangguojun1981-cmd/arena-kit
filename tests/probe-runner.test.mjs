import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbeController } from '../src/lib/probe-runner.js';

/* Scripted fake page: rpc actions resolve from handlers; the "trace pipeline"
 * learns a session's model when send() runs. */
function harness({ modelsBySend = [], handlers = {}, modelDelayPolls = 0 } = {}) {
  const calls = [];
  const log = [];
  const states = [];
  const known = new Map(); // sessionId → models (after N polls)
  let sends = 0;
  const rpc = {
    call: async (action, args = {}) => {
      calls.push({ action, args });
      if (handlers[action]) return handlers[action](args, { calls });
      if (action === 'send') {
        const sessionId = 'sess-' + (++sends);
        known.set(sessionId, { models: modelsBySend[sends - 1] || [], polls: 0 });
        return { session: sessionId };
      }
      return {};
    },
  };
  const ctl = createProbeController({
    rpc,
    modelForSession: (sid) => {
      const k = known.get(sid);
      if (!k) return null;
      k.polls++;
      return k.polls > modelDelayPolls ? k.models : null;
    },
    onProgress: (l) => log.push(l),
    onFinished: (s) => log.push('FIN ' + s),
    onProbeState: (round, max, hits, active) => states.push([round, max, hits, active]),
    sleep: () => Promise.resolve(),
    modelWaitMs: 10, modelPollMs: 1, roundPacingMs: 0,
  });
  return { ctl, calls, log, states, rpc };
}

test('probe loop: new chat → agent mode → send → await models → match → rename → stop on first hit', async () => {
  const h = harness({ modelsBySend: [['gpt-4o'], ['claude-opus-5']] });
  const r = await h.ctl.start({ targets: ['opus5', 'gpt6'], maxRounds: 5, findAll: false, autoRename: true });
  assert.equal(r.hits.length, 1);
  assert.deepEqual(r.hits[0], { target: 'opus5', model: 'claude-opus-5', sessionId: 'sess-2', round: 2 });
  const seq = h.calls.map((c) => c.action);
  assert.deepEqual(seq, ['newChat', 'ensureAgentMode', 'send', 'newChat', 'ensureAgentMode', 'send', 'rename', 'collapseSidebar']);
  const rename = h.calls.find((c) => c.action === 'rename');
  assert.deepEqual(rename.args, { sessionId: 'sess-2', title: 'claude-opus-5-001' });
  assert.ok(h.calls.filter((c) => c.action === 'send').every((c) => /^\d{1,3}[+\-*/×÷]\d{1,3}=$/.test(c.args.prompt)));
  assert.ok(h.log.some((l) => l.includes('命中目标 opus5 → claude-opus-5')));
  assert.ok(h.log.some((l) => l === '命中，按设置停止'));
  assert.equal(h.log.at(-1), 'FIN 探针结束 · 命中：opus5→claude-opus-5');
  assert.deepEqual(h.states[0], [0, 5, 0, true]);
  assert.deepEqual(h.states.at(-1), [0, 5, 1, false]);
  assert.equal(h.ctl.isRunning, false);
  assert.deepEqual(h.ctl.suffixCounters, { claudeopus5: 1 });
});

test('findAll keeps probing until every target is hit; suffixes count per model', async () => {
  const h = harness({ modelsBySend: [['claude-opus-5'], ['claude-opus-5'], ['chatgpt-6-astra'], ['x']] });
  const r = await h.ctl.start({ targets: ['opus5', 'gpt6'], maxRounds: 10, findAll: true, autoRename: true });
  assert.equal(r.sessions.length, 3);
  assert.equal(r.hits.length, 3, 'a hit target is never drained from the pool');
  const titles = h.calls.filter((c) => c.action === 'rename').map((c) => c.args.title);
  assert.deepEqual(titles, ['claude-opus-5-001', 'claude-opus-5-002', 'chatgpt-6-astra-001']);
  assert.ok(h.log.some((l) => l.startsWith('第 2 轮 · 发送') && l.includes('待命中 gpt6')));
  assert.ok(h.log.includes('全部目标已命中，停止'));
});

test('rounds without a model or session are skipped; max rounds ends the run', async () => {
  const h = harness({ modelsBySend: [[], ['gpt-4o'], []], handlers: {} });
  h.rpc.call = ((orig) => async (action, args) => {
    if (action === 'send' && h.calls.filter((c) => c.action === 'send').length === 0) { h.calls.push({ action, args }); return {}; }
    return orig(action, args);
  })(h.rpc.call);
  const r = await h.ctl.start({ targets: ['opus5'], maxRounds: 3, findAll: true, autoRename: true });
  assert.equal(r.hits.length, 0);
  assert.ok(h.log.includes('未拿到会话 id，跳过本轮'));
  assert.ok(h.log.some((l) => /第 [23] 轮未识别模型，继续/.test(l)));
  assert.equal(h.log.at(-1), 'FIN 探针结束 · 命中：无');
  assert.equal(h.calls.some((c) => c.action === 'rename'), false);
  assert.equal(h.calls.some((c) => c.action === 'collapseSidebar'), false, 'sidebar untouched when nothing renamed');
});

test('rpc failures abort the run with a reason; rename failures do not', async () => {
  let h = harness({ handlers: { ensureAgentMode: async () => { throw new Error('模式已变化'); } } });
  let r = await h.ctl.start({ targets: ['opus5'], maxRounds: 2, findAll: true, autoRename: false });
  assert.equal(r.summary, '探针中断：模式已变化');
  h = harness({ modelsBySend: [['claude-opus-5']], handlers: { rename: async () => { throw new Error('未找到唯一的 Rename 入口'); } } });
  r = await h.ctl.start({ targets: ['opus5'], maxRounds: 2, findAll: false, autoRename: true });
  assert.equal(r.hits.length, 1);
  assert.ok(h.log.includes('重命名失败：未找到唯一的 Rename 入口'));
  assert.equal(r.summary, '探针结束 · 命中：opus5→claude-opus-5');
  h = harness();
  r = await h.ctl.start({ targets: [], maxRounds: 2 });
  assert.equal(r.summary, '探针中断：请填写至少一个目标');
});

test('stop() cancels immediately, even while an rpc call is in flight', async () => {
  let release;
  const h = harness({ handlers: { newChat: () => new Promise((res) => { release = res; }) } });
  const p = h.ctl.start({ targets: ['opus5'], maxRounds: 5, findAll: true, autoRename: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.ctl.isRunning, true);
  assert.equal(h.ctl.mode, 'probe');
  const second = await h.ctl.start({ targets: ['opus5'] });
  assert.equal(second, null);
  assert.ok(h.log.includes('探针已在运行'));
  assert.equal(h.ctl.stop(), true);
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.equal(r.summary, '探针已停止（命中 0 个）');
  assert.equal(h.ctl.isRunning, false);
  release({});
  assert.equal(h.ctl.stop(), false);
});

test('quickSend targets the open conversation and is refused while probing', async () => {
  const h = harness();
  assert.deepEqual(await h.ctl.quickSend('  '), { ok: false, message: '请先填写要发送的内容' });
  const ok = await h.ctl.quickSend('12+34=');
  assert.equal(ok.ok, true);
  assert.deepEqual(h.calls.at(-1), { action: 'sendToCurrent', args: { text: '12+34=' } });
  let release;
  const busy = harness({ handlers: { newChat: () => new Promise((res) => { release = res; }) } });
  const p = busy.ctl.start({ targets: ['opus5'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await busy.ctl.quickSend('hi'), { ok: false, message: '探针运行中，请先停止再发送' });
  busy.ctl.stop(); await p; release({});
  const failing = harness({ handlers: { sendToCurrent: async () => { throw new Error('当前回复仍在生成，已停止'); } } });
  assert.deepEqual(await failing.ctl.quickSend('hi'), { ok: false, message: '发送失败：当前回复仍在生成，已停止' });
});

test('custom title builder and persisted suffix counters', async () => {
  const saved = [];
  const h = harness({ modelsBySend: [['claude-opus-5']] });
  const ctl = createProbeController({
    rpc: h.rpc, modelForSession: () => ['claude-opus-5'], sleep: () => Promise.resolve(),
    modelWaitMs: 10, modelPollMs: 1, roundPacingMs: 0,
    suffixCounters: { claudeopus5: 41 },
    onSuffixes: (c) => saved.push(c),
    buildTitle: (model, suffix) => `AK-${model}-${suffix}`,
  });
  await ctl.start({ targets: ['opus5'], maxRounds: 1, findAll: false, autoRename: true });
  assert.equal(h.calls.find((c) => c.action === 'rename').args.title, 'AK-claude-opus-5-042');
  assert.deepEqual(saved, [{ claudeopus5: 42 }]);
});
