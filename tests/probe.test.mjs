import test from 'node:test';
import assert from 'node:assert/strict';
import { runInjected, fakePage, plain } from './helpers.mjs';

/* Just enough DOM for probe.js's composer / draft / generating checks. */
function el({ tag = 'DIV', value = '', text = '', attrs = {}, className = '' } = {}) {
  return {
    tagName: tag, value, textContent: text, innerText: text, className, id: '', isConnected: true, disabled: false,
    childElementCount: 0, firstElementChild: null,
    getClientRects: () => [{}],
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {}, click() { this.clicked = true; },
  };
}

function page({ pathname = '/agent', nodes = {} } = {}) {
  const p = fakePage({ pathname });
  const sent = [];
  p.sandbox.__ARENAKIT__ = { send: (name, payload) => sent.push({ name, payload: plain(payload) }) };
  p.document.querySelectorAll = (sel) => nodes[sel] || [];
  runInjected('injected/probe.js', p.sandbox);
  const call = async (action, args = {}) => {
    const res = plain(await p.sandbox.ArenaProbe.call(action, JSON.stringify(args), 'req-' + (sent.length + 1)));
    return res;
  };
  return { ...p, sent, call, probe: p.sandbox.ArenaProbe };
}

test('own probe prompts are bare arithmetic only', () => {
  const { probe } = page();
  for (const ok of ['12+34=', ' 985×128 = ', '1-1=', '7*8=', '9/3=', '4÷2=']) assert.equal(probe.isOwnPrompt(ok), true, ok);
  for (const no of ['hello', '12+34=46', '1+2', '12345+1=', 'what is 1+1=', '', null]) assert.equal(probe.isOwnPrompt(no), false, String(no));
  assert.equal(probe.isArithmeticTitle, probe.isOwnPrompt);
});

test('results travel through the bridge as probe-result page events', async () => {
  const p = page({ pathname: '/agent/abc-123' });
  const res = await p.call('precheck');
  assert.equal(res.ok, true);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].name, 'probe-result');
  assert.equal(p.sent[0].payload.reqId, 'req-1');
  assert.deepEqual(p.sent[0].payload.data, {
    onArena: true, session: 'abc-123', agentPath: false, hasComposer: false, hasDraft: false, draftIsOwnPrompt: false,
    isGenerating: false, renameBusy: false, dialogOpen: false, title: 'Arena',
  });
  const bad = await p.call('nope');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown action: nope/);
  assert.equal(p.sent[1].payload.ok, false);
});

test('precheck reports human drafts vs our own arithmetic prompt', async () => {
  const draft = el({ tag: 'TEXTAREA', value: 'dear diary', attrs: { 'aria-label': 'Message' } });
  let p = page({ nodes: { textarea: [draft] } });
  let r = (await p.call('precheck')).data;
  assert.equal(r.hasComposer, true);
  assert.equal(r.hasDraft, true);
  assert.equal(r.draftIsOwnPrompt, false);
  assert.equal(r.agentPath, true);
  draft.value = '12+34=';
  p = page({ nodes: { textarea: [draft] } });
  r = (await p.call('precheck')).data;
  assert.equal(r.hasDraft, true);
  assert.equal(r.draftIsOwnPrompt, true);
});

test('send only ever submits arithmetic from a fresh /agent composer and never over a draft', async () => {
  let p = page();
  assert.match((await p.call('send', { prompt: 'tell me a joke' })).error, /只发送算式提示/);
  p = page({ pathname: '/agent/abc' });
  assert.match((await p.call('send', { prompt: '1+1=' })).error, /页面已变化/);
  const draft = el({ tag: 'TEXTAREA', value: 'my unsent thoughts', attrs: { 'aria-label': 'Message' } });
  p = page({ nodes: { textarea: [draft] } });
  const r = await p.call('send', { prompt: '1+1=' });
  assert.match(r.error, /未发送内容/);
  assert.match(r.error, /不会覆盖草稿/);
  assert.notEqual(draft.clicked, true);
});

test('sendToCurrent validates text and refuses while a reply is generating', async () => {
  let p = page({ pathname: '/agent/abc' });
  assert.match((await p.call('sendToCurrent', { text: '   ' })).error, /发送内容为空/);
  assert.match((await p.call('sendToCurrent', { text: 'x'.repeat(8001) })).error, /上限 8000/);
  const stop = el({ tag: 'BUTTON', attrs: { 'aria-label': 'Stop generating' } });
  p = page({ pathname: '/agent/abc', nodes: { 'button[aria-label]': [stop] } });
  assert.match((await p.call('sendToCurrent', { text: '12+34=' })).error, /仍在生成/);
  assert.equal((await p.call('precheck')).data.isGenerating, true);
  p = page({ pathname: '/agent/abc' });
  assert.match((await p.call('sendToCurrent', { text: 'hi' })).error, /未找到输入框/);
});

test('rename and archive validate their arguments before touching the page', async () => {
  const p = page({ pathname: '/agent/abc' });
  runInjected('injected/conversation-rename.js', p.sandbox);
  assert.match((await p.call('rename', { sessionId: '../x', title: 'm' })).error, /请先进入一个已保存的 Arena 对话/);
  assert.match((await p.call('rename', { sessionId: 'abc', title: '' })).error, /尚未识别模型/);
  assert.match((await p.call('rename', { sessionId: 'abc', title: 'x'.repeat(101) })).error, /100 字符上限/);
  assert.match((await p.call('archive', { sessionId: 'a?b' })).error, /请先进入一个已保存的 Arena 对话/);
});
