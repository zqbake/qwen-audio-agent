import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

import {
  GATE0_FINAL_TEXT,
  Gate0ProbeError,
  assertGate0Host,
  parseGate0Arguments,
  runGate0Probe,
  validateDeveloperIdMetadata,
  verifyReleaseArtifact,
} from '../../scripts/lib/native-input-release-gate0.mjs'

const cleanBaseline = Object.freeze({
  keyboardId: 'com.apple.keylayout.ABC',
  qwenCount: 0,
  enabled: false,
  selected: false,
  userBundleExists: false,
  systemBundleExists: false,
  qwenProcessCount: 0,
  runtimeExists: false,
  textEditRunning: false,
})

const readyState = Object.freeze({
  ...cleanBaseline,
  qwenCount: 1,
  enabled: true,
  selected: true,
  userBundleExists: true,
})

const root = resolve(new URL('../..', import.meta.url).pathname)

function makeSystem(overrides = {}) {
  const calls = []
  const system = {
    calls,
    async assertSupportedHost() { calls.push('host') },
    async verifyReleaseArtifact() { calls.push('release') },
    async captureBaseline() { calls.push('baseline'); return { ...cleanBaseline } },
    async install() { calls.push('install') },
    async freshState() { calls.push('fresh'); return { ...readyState } },
    async exerciseTextEdit() {
      calls.push('textedit')
      return {
        partialAccepted: true,
        finalAccepted: true,
        documentText: GATE0_FINAL_TEXT,
      }
    },
    async cleanup() { calls.push('cleanup') },
    async verifyCleanup() {
      calls.push('verify-cleanup')
      return { ...cleanBaseline }
    },
    ...overrides,
  }
  return system
}

async function captureRun(system, confirm = async () => true) {
  const events = []
  const result = await runGate0Probe({
    system,
    confirm,
    report: event => events.push(event),
  })
  return { events, result }
}

test('accepts only exact Developer ID Application identities with hardened runtime', () => {
  const team = 'ABCDE12345'
  assert.deepEqual(validateDeveloperIdMetadata([
    {
      expectedIdentifier: 'ai.qwenaudio.agent',
      output: [
        'Identifier=ai.qwenaudio.agent',
        'Authority=Developer ID Application: Example (ABCDE12345)',
        `TeamIdentifier=${team}`,
        'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded',
      ].join('\n'),
    },
    {
      expectedIdentifier: 'ai.qwenaudio.agent.inputbridge',
      output: [
        'Identifier=ai.qwenaudio.agent.inputbridge',
        'Authority=Developer ID Application: Example (ABCDE12345)',
        `TeamIdentifier=${team}`,
        'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded',
      ].join('\n'),
    },
    {
      expectedIdentifier: 'ai.qwenaudio.agent.inputmethod',
      output: [
        'Identifier=ai.qwenaudio.agent.inputmethod',
        'Authority=Developer ID Application: Example (ABCDE12345)',
        `TeamIdentifier=${team}`,
        'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded',
      ].join('\n'),
    },
  ]), { teamIdentifier: team })
})

test('rejects ad-hoc and Apple Development metadata as release evidence', () => {
  for (const output of [
    'Identifier=ai.qwenaudio.agent\nSignature=adhoc\nTeamIdentifier=not set',
    [
      'Identifier=ai.qwenaudio.agent',
      'Authority=Apple Development: Example (ABCDE12345)',
      'TeamIdentifier=ABCDE12345',
      'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded',
    ].join('\n'),
  ]) {
    assert.throws(
      () => validateDeveloperIdMetadata([{
        expectedIdentifier: 'ai.qwenaudio.agent',
        output,
      }]),
      error => error instanceof Gate0ProbeError
        && error.code === 'developer_id_required',
    )
  }
})

test('requires a non-admin macOS account for a clean Gate 0 baseline', () => {
  assert.doesNotThrow(() => assertGate0Host({
    groups: [20, 501],
    platform: 'darwin',
  }))
  assert.throws(
    () => assertGate0Host({ groups: [20, 80, 501], platform: 'darwin' }),
    error => error instanceof Gate0ProbeError && error.code === 'standard_user_required',
  )
  assert.throws(
    () => assertGate0Host({ groups: [20, 501], platform: 'linux' }),
    error => error instanceof Gate0ProbeError && error.code === 'macos_required',
  )
})

test('the release probe accepts only one explicit absolute app path', () => {
  assert.deepEqual(
    parseGate0Arguments(['--app', '/Applications/Qwen Audio Agent.app']),
    { appPath: '/Applications/Qwen Audio Agent.app' },
  )
  for (const argv of [
    [],
    ['--app', 'relative.app'],
    ['--app', '/Applications/Qwen Audio Agent.app', '--yes'],
  ]) {
    assert.throws(
      () => parseGate0Arguments(argv),
      error => error instanceof Gate0ProbeError && error.code === 'invalid_arguments',
    )
  }
})

test('release verification requires signature, Developer ID, staple, and Gatekeeper', async () => {
  const commands = []
  const output = identifier => [
    `Identifier=${identifier}`,
    'Authority=Developer ID Application: Example (ABCDE12345)',
    'TeamIdentifier=ABCDE12345',
    'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded',
  ].join('\n')
  await verifyReleaseArtifact({
    appPath: '/Applications/Qwen Audio Agent.app',
    exists: () => true,
    execute: async (command, args) => {
      commands.push([command, ...args])
      if (command !== 'codesign' || args[0] !== '--display') return { output: '' }
      const target = args.at(-1)
      if (target.endsWith('QwenInputBridge')) {
        return { output: output('ai.qwenaudio.agent.inputbridge') }
      }
      if (target.endsWith('Qwen Input.app')) {
        return { output: output('ai.qwenaudio.agent.inputmethod') }
      }
      return { output: output('ai.qwenaudio.agent') }
    },
  })

  assert.ok(commands.some(call => call[0] === 'xcrun' && call[1] === 'stapler'))
  assert.ok(commands.some(call => call[0] === 'spctl' && call[1] === '--assess'))
  assert.equal(commands.filter(call => call[0] === 'codesign'
    && call[1] === '--display').length, 3)
  assert.ok(commands.some(call => call[0] === 'codesign'
    && call.includes('--deep') && call.includes('--strict')))
})

test('release verification fails closed when the staple is invalid', async () => {
  await assert.rejects(
    verifyReleaseArtifact({
      appPath: '/Applications/Qwen Audio Agent.app',
      exists: () => true,
      execute: async (command, args) => {
        if (command === 'xcrun' && args[0] === 'stapler') {
          throw new Error('raw notarization output must not escape')
        }
        if (command === 'codesign' && args[0] === '--display') {
          const target = args.at(-1)
          const identifier = target.endsWith('QwenInputBridge')
            ? 'ai.qwenaudio.agent.inputbridge'
            : target.endsWith('Qwen Input.app')
              ? 'ai.qwenaudio.agent.inputmethod'
              : 'ai.qwenaudio.agent'
          return { output: [
            `Identifier=${identifier}`,
            'Authority=Developer ID Application: Example (ABCDE12345)',
            'TeamIdentifier=ABCDE12345',
            'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded',
          ].join('\n') }
        }
        return { output: '' }
      },
    }),
    error => error instanceof Gate0ProbeError
      && error.code === 'notarization_required'
      && !error.message.includes('raw notarization'),
  )
})

test('runs the release Gate 0 in order and always cleans successful mutation', async () => {
  const system = makeSystem()
  const { events, result } = await captureRun(system)

  assert.deepEqual(system.calls, [
    'host',
    'release',
    'baseline',
    'install',
    'fresh',
    'textedit',
    'cleanup',
    'verify-cleanup',
  ])
  assert.deepEqual(result, { status: 'pass' })
  assert.deepEqual(events.map(({ stage, status }) => [stage, status]), [
    ['host', 'pass'],
    ['release', 'pass'],
    ['baseline', 'pass'],
    ['setup-confirmation', 'pass'],
    ['install', 'pass'],
    ['fresh-verify', 'pass'],
    ['textedit-partial', 'pass'],
    ['textedit-final', 'pass'],
    ['cleanup', 'pass'],
    ['cleanup-verify', 'pass'],
    ['result', 'pass'],
  ])
})

test('declining the explicit setup confirmation performs no mutation', async () => {
  const system = makeSystem()
  const events = []

  await assert.rejects(
    runGate0Probe({
      system,
      confirm: async () => false,
      report: event => events.push(event),
    }),
    error => error instanceof Gate0ProbeError
      && error.code === 'setup_not_confirmed',
  )

  assert.deepEqual(system.calls, ['host', 'release', 'baseline'])
  assert.deepEqual(events.at(-1), {
    reason: 'setup_not_confirmed',
    stage: 'setup-confirmation',
    status: 'fail',
  })
})

test('a pre-existing Qwen artifact is a dirty baseline, not probe-owned cleanup', async () => {
  const system = makeSystem({
    async captureBaseline() {
      this.calls.push('baseline')
      return { ...cleanBaseline, userBundleExists: true }
    },
  })

  await assert.rejects(
    captureRun(system),
    error => error instanceof Gate0ProbeError && error.code === 'dirty_baseline',
  )
  assert.deepEqual(system.calls, ['host', 'release', 'baseline'])
})

test('an install failure still runs cleanup and never leaks arbitrary error text', async () => {
  const system = makeSystem({
    async install() {
      this.calls.push('install')
      throw new Error('secret transcript and private path')
    },
  })
  const events = []

  await assert.rejects(
    runGate0Probe({
      system,
      confirm: async () => true,
      report: event => events.push(event),
    }),
    error => error instanceof Gate0ProbeError
      && error.code === 'install_failed',
  )

  assert.deepEqual(system.calls, [
    'host', 'release', 'baseline', 'install', 'cleanup', 'verify-cleanup',
  ])
  assert.equal(JSON.stringify(events).includes('secret transcript'), false)
  assert.deepEqual(events.find(event => event.stage === 'install'), {
    reason: 'install_failed',
    stage: 'install',
    status: 'fail',
  })
})

test('fresh verify fails closed when the ordinary keyboard changes', async () => {
  const system = makeSystem({
    async freshState() {
      this.calls.push('fresh')
      return { ...readyState, keyboardId: 'unexpected' }
    },
  })

  await assert.rejects(
    captureRun(system),
    error => error instanceof Gate0ProbeError
      && error.code === 'keyboard_changed',
  )
  assert.deepEqual(system.calls.slice(-2), ['cleanup', 'verify-cleanup'])
})

test('TextEdit final must replace the partial with the exact fixed fake text', async () => {
  const system = makeSystem({
    async exerciseTextEdit() {
      this.calls.push('textedit')
      return {
        partialAccepted: true,
        finalAccepted: true,
        documentText: 'typed by another source',
      }
    },
  })

  await assert.rejects(
    captureRun(system),
    error => error instanceof Gate0ProbeError
      && error.code === 'textedit_final_failed',
  )
  assert.deepEqual(system.calls.slice(-2), ['cleanup', 'verify-cleanup'])
})

test('incomplete cleanup is the terminal failure even after a successful probe', async () => {
  const system = makeSystem({
    async verifyCleanup() {
      this.calls.push('verify-cleanup')
      return { ...cleanBaseline, qwenCount: 1 }
    },
  })

  await assert.rejects(
    captureRun(system),
    error => error instanceof Gate0ProbeError
      && error.code === 'cleanup_incomplete',
  )
})

test('the Swift helper emits a bounded read-only public-TIS snapshot', {
  skip: process.platform !== 'darwin',
}, () => {
  const result = spawnSync('xcrun', [
    'swift',
    resolve(root, 'scripts/native-input-release-gate0-tis.swift'),
    'snapshot',
    'ai.qwenaudio.agent.inputmethod',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const snapshot = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'enabled', 'keyboardId', 'qwenCount', 'selected',
  ])
  assert.equal(typeof snapshot.keyboardId, 'string')
  assert.equal(Number.isInteger(snapshot.qwenCount), true)
})
