import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { NativeInputFeature } from '../src/native-input-feature.mjs'
import {
  parseSettings,
  updateSettingsContent,
} from '../src/settings-config.mjs'

function harness({ enabled = false, registerResult = true } = {}) {
  const calls = []
  const callbacks = new Map()
  const operationRequests = []
  const sessionRequests = []
  const host = Object.assign(new EventEmitter(), {
    state: 'idle',
    async start() {
      calls.push('host.start')
      this.state = 'ready'
      return { state: 'ready' }
    },
    async stop(reason) {
      calls.push(`host.stop:${reason}`)
      this.state = 'idle'
    },
    emergencyStop(reason) {
      calls.push(`host.emergency:${reason}`)
      this.state = 'error'
    },
    send(message) {
      calls.push(`host.send:${message.type}`)
    },
    async request(message) {
      calls.push(`host.request:${message.type}`)
      operationRequests.push(message)
      return {
        type: 'operation.result',
        operationId: 'development-operation',
        accepted: true,
      }
    },
  })
  const globalShortcut = {
    register(accelerator, callback) {
      calls.push(`shortcut.register:${accelerator}`)
      if (registerResult) callbacks.set(accelerator, callback)
      return registerResult
    },
    unregister(accelerator) {
      calls.push(`shortcut.unregister:${accelerator}`)
      callbacks.delete(accelerator)
    },
  }
  const feature = new NativeInputFeature({
    enabled,
    accelerator: 'CommandOrControl+Shift+D',
    globalShortcut,
    host,
    onSessionRequest: request => sessionRequests.push(request),
  })
  return {
    callbacks,
    calls,
    feature,
    host,
    operationRequests,
    sessionRequests,
  }
}

test('default-off native input neither spawns nor registers a shortcut', async () => {
  const { calls, feature } = harness()
  assert.deepEqual(await feature.initialize(), {
    enabled: false,
    state: 'disabled',
    shortcutRegistered: false,
  })
  assert.deepEqual(calls, [])
})

test('desktop settings keep native input explicitly disabled by default', () => {
  assert.deepEqual(
    {
      enabled: parseSettings('').nativeInputEnabled,
      accessibilityEnabled: parseSettings('').nativeInputAccessibilityEnabled,
      shortcut: parseSettings('').nativeInputShortcut,
    },
    {
      enabled: false,
      accessibilityEnabled: false,
      shortcut: 'CommandOrControl+Shift+D',
    },
  )
  const content = updateSettingsContent('', {
    nativeInputEnabled: true,
    nativeInputAccessibilityEnabled: true,
    nativeInputShortcut: 'CommandOrControl+Alt+D',
  })
  assert.match(content, /QWEN_AUDIO_NATIVE_INPUT_ENABLED=true/)
  assert.match(content, /QWEN_AUDIO_NATIVE_INPUT_ACCESSIBILITY_ENABLED=true/)
  assert.match(
    content,
    /QWEN_AUDIO_NATIVE_INPUT_SHORTCUT=CommandOrControl\+Alt\+D/,
  )
})

test('Accessibility enhancement is explicit and forbids event synthesis', () => {
  const project = readFileSync(
    new URL('../native/project.yml', import.meta.url),
    'utf8',
  )
  const sources = [
    'native/Sources/QwenInput/InputController.swift',
    'native/Sources/QwenInput/SystemAccessibilityTextClient.swift',
  ].map(file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n')
  assert.match(project, /ApplicationServices\.framework/)
  assert.doesNotMatch(sources, /CGEvent|postToPid|\.post\(/)
  assert.match(sources, /kAXConfirmAction/)
  assert.match(sources, /AXIsProcessTrusted/)
})

test('enabled feature owns one Bridge and an independent shortcut', async () => {
  const { callbacks, calls, feature, sessionRequests } = harness({ enabled: true })
  assert.deepEqual(await feature.initialize(), {
    enabled: true,
    state: 'ready',
    shortcutRegistered: true,
  })
  assert.deepEqual(calls, [
    'host.start',
    'shortcut.register:CommandOrControl+Shift+D',
  ])

  callbacks.get('CommandOrControl+Shift+D')()
  assert.deepEqual(sessionRequests, [{ type: 'toggle' }])
  assert.equal(calls.at(-1), 'shortcut.register:CommandOrControl+Shift+D')

  await feature.shutdown()
  assert.deepEqual(calls.slice(-2), [
    'shortcut.unregister:CommandOrControl+Shift+D',
    'host.stop:desktop_shutdown',
  ])
})

test('shortcut conflict stops capture and tears the Bridge back down', async () => {
  const { calls, feature } = harness({ enabled: true, registerResult: false })
  await assert.rejects(feature.initialize(), /shortcut/i)
  assert.deepEqual(calls, [
    'host.start',
    'shortcut.register:CommandOrControl+Shift+D',
    'host.stop:shortcut_unavailable',
  ])
})

test('renderer loss is a local emergency stop and blocks the shortcut', async () => {
  const { callbacks, calls, feature } = harness({ enabled: true })
  await feature.initialize()
  feature.rendererLost()
  assert.deepEqual(calls.slice(-2), [
    'shortcut.unregister:CommandOrControl+Shift+D',
    'host.emergency:renderer_lost',
  ])
  assert.equal(callbacks.size, 0)
})

test('unexpected Bridge exit makes the feature visibly fail closed', async () => {
  const { callbacks, calls, feature, host } = harness({ enabled: true })
  await feature.initialize()

  host.state = 'error'
  host.emit('failed', { reason: 'child_exit' })

  assert.deepEqual(feature.snapshot(), {
    enabled: true,
    state: 'error',
    shortcutRegistered: false,
  })
  assert.equal(callbacks.size, 0)
  assert.equal(calls.at(-1), 'shortcut.unregister:CommandOrControl+Shift+D')
  assert.throws(
    () => feature.sendOperation({ type: 'session.partial' }),
    /not ready/i,
  )
})

test('lifecycle readiness unregisters and restores the native shortcut', async () => {
  const { calls, feature } = harness({ enabled: true })
  await feature.initialize()
  assert.equal(feature.applyLifecycleStatus({ state: 'needs-enable' }).state, 'needs-enable')
  assert.equal(calls.at(-1), 'shortcut.unregister:CommandOrControl+Shift+D')
  assert.equal(feature.applyLifecycleStatus({ state: 'ready' }).state, 'ready')
  assert.equal(calls.at(-1), 'shortcut.register:CommandOrControl+Shift+D')
})

test('development operations use correlated Bridge requests and preserve visibility', async () => {
  const { calls, feature, operationRequests } = harness({ enabled: true })
  await feature.initialize()

  assert.deepEqual(await feature.sendOperation({
    type: 'session.partial',
    text: 'fake transcript',
    statusVisible: true,
  }), {
    type: 'operation.result',
    operationId: 'development-operation',
    accepted: true,
  })
  assert.deepEqual(operationRequests, [{
    type: 'session.partial',
    text: 'fake transcript',
    statusVisible: true,
  }])
  assert.equal(calls.at(-1), 'host.request:session.partial')
  assert.ok(!calls.includes('host.send:session.partial'))
})

test('Desktop owns startup, renderer-loss, dev IPC, and shutdown ordering', () => {
  const main = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const preload = readFileSync(
    new URL('../src/preload.cjs', import.meta.url),
    'utf8',
  )

  assert.match(main, /new NativeInputHost/)
  assert.match(main, /new NativeInputFeature/)
  assert.match(main, /nativeInputFeature\.initialize\(\)/)
  assert.match(main, /render-process-gone[\s\S]*nativeInputFeature\.rendererLost/)
  assert.match(main, /QWEN_AUDIO_NATIVE_INPUT_DEVTOOLS/)
  assert.ok(
    main.indexOf('await nativeInputFeature.shutdown()')
      < main.indexOf('gateway?.stop()'),
  )
  assert.match(preload, /QWEN_AUDIO_NATIVE_INPUT_DEVTOOLS/)
  assert.match(preload, /nativeInputStatus/)
  assert.match(preload, /nativeInputLifecycle/)
  assert.match(preload, /nativeInputOperation/)
  assert.match(preload, /onNativeInputSessionRequest/)
  assert.doesNotMatch(preload, /nativeInput.*Path/i)
})
