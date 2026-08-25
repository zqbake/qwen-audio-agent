import assert from 'node:assert/strict'
import test from 'node:test'

import * as nativeDictation from '../src/native-input-dictation.js'

const { NativeInputDictationClient } = nativeDictation

async function withLang(lang, run) {
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem: key => (key === 'qwen-audio-lang' ? lang : null),
  }
  try {
    return await run()
  } finally {
    globalThis.localStorage = previous
  }
}

function harness(overrides = {}) {
  const gateway = []
  const native = []
  const capture = []
  const views = []
  const client = new NativeInputDictationClient({
    enabled: true,
    canStart: () => true,
    sendGateway: event => {
      gateway.push(event)
      return true
    },
    sendNative: operation => {
      native.push(operation)
      return Promise.resolve({
        type: 'operation.result',
        operationId: operation.operationId,
        accepted: true,
      })
    },
    setCapture: (active, options) => capture.push({ active, options }),
    onView: view => views.push(view),
    ...overrides,
  })
  return { capture, client, gateway, native, views }
}

test('starts an empty native draft only after ownership/suspend gates pass', async () => {
  const blocked = harness({ canStart: () => false })
  assert.equal(await blocked.client.start(), false)
  assert.deepEqual(blocked.gateway, [])
  assert.deepEqual(blocked.native, [])
  assert.deepEqual(blocked.capture, [])

  const ready = harness()
  assert.equal(await ready.client.start({ continuous: false }), true)
  assert.deepEqual(ready.native.map(item => item.type), ['session.arm'])
  assert.deepEqual(ready.gateway, [{
    type: 'dictation.start',
    text: '',
    revision: 0,
    continuous: false,
  }])
  assert.deepEqual(ready.capture, [{ active: true, options: undefined }])
})

test('fails closed when native arm does not return an accepted correlated result', async () => {
  for (const result of [undefined, {}, { accepted: true }]) {
    const blocked = harness({ sendNative: () => Promise.resolve(result) })
    assert.equal(await blocked.client.start(), false)
    assert.deepEqual(blocked.gateway, [])
    assert.deepEqual(blocked.capture, [])
    assert.equal(blocked.client.view().state, 'error')
  }

  await withLang('zh-CN', async () => {
    const sourceNotSelected = harness({
      sendNative: operation => Promise.resolve({
        type: 'operation.result',
        operationId: operation.operationId,
        accepted: false,
        reason: 'input_source_selection_required',
      }),
    })
    assert.equal(await sourceNotSelected.client.start(), false)
    assert.equal(
      sourceNotSelected.client.view().error,
      '请从 macOS 输入菜单选择 Qwen Input',
    )
    assert.deepEqual(sourceNotSelected.gateway, [])
  })

  for (const [lang, expected] of [
    ['zh-CN', '当前输入目标不可用'],
    ['en-US', 'The input target is unavailable'],
  ]) {
    await withLang(lang, async () => {
      const targetUnavailable = harness({
        sendNative: operation => Promise.resolve({
          type: 'operation.result',
          operationId: operation.operationId,
          accepted: false,
          reason: 'target_unavailable',
        }),
      })
      assert.equal(await targetUnavailable.client.start(), false)
      assert.equal(targetUnavailable.client.view().error, expected)
    })
  }
})

test('routes partial/final to correlated native operations and never submits conversation', async () => {
  const { client, gateway, native } = harness()
  await client.start()
  assert.equal(client.handle({
    type: 'dictation.partial',
    text: '你好',
    revision: 0,
    seq: 1,
  }), true)
  assert.equal(client.handle({
    type: 'dictation.final',
    text: '你好世界',
    revision: 1,
    seq: 2,
  }), true)
  await client.settled()

  assert.deepEqual(native.slice(1).map(item => ({
    type: item.type,
    text: item.text,
    revision: item.revision,
    seq: item.seq,
    operationId: typeof item.operationId,
  })), [
    {
      type: 'session.partial', text: '你好', revision: 0, seq: 1,
      operationId: 'string',
    },
    {
      type: 'session.final', text: '你好世界', revision: 1, seq: 2,
      operationId: 'string',
    },
  ])
  assert.deepEqual(gateway.map(item => item.type), ['dictation.start'])
})

test('voice commit waits for final, confirms through native AX, and acks once', async () => {
  const { client, gateway, native } = harness()
  await client.start()
  client.handle({
    type: 'dictation.final', text: 'hello', revision: 0, seq: 1,
  })
  const request = {
    type: 'dictation.commit.request', intent: 'conversation',
    commitId: 'native-commit-1', revision: 1, fingerprint: 'abc123',
  }
  assert.equal(client.handle(request), true)
  assert.equal(client.handle(request), false)
  await client.settled()

  assert.deepEqual(native.slice(1).map(item => item.type), [
    'session.final', 'session.submit',
  ])
  assert.deepEqual(gateway.filter(item => item.type === 'dictation.commit.ack'), [{
    type: 'dictation.commit.ack',
    commitId: 'native-commit-1',
    revision: 1,
    fingerprint: 'abc123',
    submitted: true,
  }])
})

test('deterministic edit forwards the Gateway from/to contract to native AX', async () => {
  const { client, native } = harness()
  await client.start()
  assert.equal(client.handle({
    type: 'dictation.operation', operation: 'replace',
    from: 'world', to: 'earth', revision: 1, seq: 2,
  }), true)
  await client.settled()
  assert.deepEqual({
    type: native.at(-1).type,
    operation: native.at(-1).operation,
    target: native.at(-1).target,
    replacement: native.at(-1).replacement,
  }, {
    type: 'session.operation', operation: 'replace',
    target: 'world', replacement: 'earth',
  })
})

test('Memory-only correction never calls native AX or ordinary submission', async () => {
  const { client, gateway, native } = harness()
  await client.start()
  const request = {
    type: 'dictation.commit.request', intent: 'memory-correction',
    commitId: 'memory-only-1', revision: 0, fingerprint: 'memory-fingerprint',
  }
  assert.equal(client.handle(request), true)
  await client.settled()

  assert.deepEqual(native.map(item => item.type), ['session.arm'])
  assert.deepEqual(gateway.at(-1), {
    type: 'dictation.commit.ack',
    commitId: 'memory-only-1',
    revision: 0,
    fingerprint: 'memory-fingerprint',
    submitted: false,
    accepted: true,
    intent: 'memory-correction',
  })
})

test('failed AX submit is visible and never acknowledges a submission', async () => {
  const h = harness({
    sendNative: operation => Promise.resolve({
      type: 'operation.result',
      operationId: operation.operationId,
      accepted: operation.type !== 'session.submit',
      ...(operation.type === 'session.submit' ? { reason: 'accessibility_unavailable' } : {}),
    }),
  })
  await h.client.start()
  h.client.handle({
    type: 'dictation.commit.request', intent: 'conversation',
    commitId: 'failed-submit', revision: 0, fingerprint: 'failed',
  })
  await h.client.settled()
  assert.equal(h.client.view().state, 'error')
  assert.deepEqual(
    h.gateway.filter(item => item.type === 'dictation.commit.ack'),
    [],
  )
})

test('cancel and native failure stop capture, cancel Gateway, and reject late results', async () => {
  let resolvePartial
  const pendingPartial = new Promise(resolve => { resolvePartial = resolve })
  const { capture, client, gateway } = harness({
    sendNative: operation => operation.type === 'session.partial'
      ? pendingPartial
      : Promise.resolve({
          type: 'operation.result',
          operationId: operation.operationId,
          accepted: true,
        }),
  })
  await client.start()
  client.handle({
    type: 'dictation.partial', text: 'secret', revision: 0, seq: 1,
  })
  assert.equal(client.cancel('user_cancelled'), true)
  resolvePartial({
    type: 'operation.result',
    operationId: 'late-result-does-not-match',
    accepted: true,
  })
  await client.settled()

  assert.deepEqual(gateway.map(item => item.type), [
    'dictation.start', 'dictation.cancel',
  ])
  assert.deepEqual(capture.at(-1), {
    active: false,
    options: { restore: true },
  })
  assert.equal(client.view().state, 'cancelled')

  const failed = harness({
    sendNative: operation => Promise.resolve({
      type: 'operation.result',
      operationId: operation.operationId,
      accepted: operation.type === 'session.arm',
      ...(operation.type === 'session.arm' ? {} : { reason: 'target_changed' }),
    }),
  })
  await failed.client.start()
  failed.client.handle({
    type: 'dictation.final', text: 'must not land', revision: 1, seq: 1,
  })
  await failed.client.settled()
  assert.equal(failed.client.view().state, 'error')
  assert.deepEqual(failed.gateway.map(item => item.type), [
    'dictation.start', 'dictation.cancel',
  ])
  assert.equal(failed.capture.at(-1).active, false)
})

test('input.suspend and terminal Gateway states fail closed before late operations', async () => {
  const { client, gateway, native } = harness()
  await client.start()
  assert.equal(client.handle({ type: 'input.suspend' }), true)
  assert.equal(client.handle({
    type: 'dictation.final', text: 'late', revision: 1, seq: 1,
  }), false)
  await client.settled()
  assert.deepEqual(native.map(item => item.type), ['session.arm', 'session.cancel'])
  assert.deepEqual(gateway.map(item => item.type), [
    'dictation.start', 'dictation.cancel',
  ])
  assert.equal(client.view().state, 'error')
})

test('ordered native event consumption handles every unseen event exactly once', () => {
  assert.equal(typeof nativeDictation.consumeNativeInputEvents, 'function')
  const handled = []
  const events = [
    { id: 1, event: { type: 'dictation.partial' } },
    { id: 2, event: { type: 'dictation.final' } },
    { id: 3, event: { type: 'dictation.state', state: 'cancelled' } },
  ]
  let cursor = nativeDictation.consumeNativeInputEvents(
    events,
    0,
    event => handled.push(event.type),
  )
  cursor = nativeDictation.consumeNativeInputEvents(
    events,
    cursor,
    event => handled.push(event.type),
  )
  assert.equal(cursor, 3)
  assert.deepEqual(handled, [
    'dictation.partial', 'dictation.final', 'dictation.state',
  ])
})
