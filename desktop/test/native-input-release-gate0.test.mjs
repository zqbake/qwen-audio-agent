import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  GATE0_FINAL_TEXT,
  Gate0ProbeError,
  SYSTEM_TOOL_PATHS,
  assertGate0Host,
  parseGate0Arguments,
  runGate0Probe,
  validateDeveloperIdMetadata,
  verifyReleaseArtifact,
} from '../../scripts/lib/native-input-release-gate0.mjs'
import {
  assertIMKClientHandoff,
  assertObservedFocusUnchanged,
  assertTrustedArtifactMetadata,
  gate0ChildEnvironment,
  gate0UserPaths,
  matchOwnedTrashItem,
  requestHostWithCancellation,
  requirePgrepNoMatch,
  runCleanupActions,
} from '../../scripts/native-input-release-gate0.mjs'

const cleanBaseline = Object.freeze({
  backupBundleExists: false,
  keyboardId: 'com.apple.keylayout.ABC',
  qwenCount: 0,
  enabled: false,
  inputMethodsDirectorySafe: true,
  selected: false,
  userBundleExists: false,
  systemBundleExists: false,
  qwenProcessCount: 0,
  runtimeExists: false,
  stagingBundleCount: 0,
  textEditRunning: false,
  trashRestored: true,
  trashReadable: true,
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
    consoleUid: 501,
    euid: 501,
    groups: [20, 501],
    homeUid: 501,
    platform: 'darwin',
  }))
  assert.throws(
    () => assertGate0Host({
      consoleUid: 501,
      euid: 501,
      groups: [20, 80, 501],
      homeUid: 501,
      platform: 'darwin',
    }),
    error => error instanceof Gate0ProbeError && error.code === 'standard_user_required',
  )
  assert.throws(
    () => assertGate0Host({
      consoleUid: 0,
      euid: 0,
      groups: [0],
      homeUid: 0,
      platform: 'darwin',
    }),
    error => error instanceof Gate0ProbeError && error.code === 'standard_user_required',
  )
  assert.throws(
    () => assertGate0Host({
      consoleUid: 502,
      euid: 501,
      groups: [20, 501],
      homeUid: 501,
      platform: 'darwin',
    }),
    error => error instanceof Gate0ProbeError && error.code === 'console_user_required',
  )
  assert.throws(
    () => assertGate0Host({
      consoleUid: 501,
      euid: 501,
      groups: [20, 501],
      homeUid: 502,
      platform: 'darwin',
    }),
    error => error instanceof Gate0ProbeError && error.code === 'home_owner_mismatch',
  )
  assert.throws(
    () => assertGate0Host({
      consoleUid: 501,
      euid: 501,
      groups: [20, 501],
      homeUid: 501,
      platform: 'linux',
    }),
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

test('the Bridge environment never inherits caller PATH or unrelated values', () => {
  assert.deepEqual(gate0ChildEnvironment({
    LANG: 'en_US.UTF-8',
    PATH: '/malicious/bin',
    PROVIDER_KEY: 'must-not-cross',
    TMPDIR: '/private/tmp/',
  }), {
    LANG: 'en_US.UTF-8',
    TMPDIR: '/private/tmp/',
  })
})

test('every user path and child HOME use the canonical account home', () => {
  const home = resolve('test-canonical-home')
  const inputMethodsDirectory = join(home, 'Library', 'Input Methods')
  assert.deepEqual(gate0UserPaths(home), {
    backupBundle: join(inputMethodsDirectory, '.qwen-input-last-known-good'),
    inputMethodsDirectory,
    trashDirectory: join(home, '.Trash'),
    userBundle: join(inputMethodsDirectory, 'Qwen Input.app'),
  })
  assert.deepEqual(gate0ChildEnvironment({
    HOME: '/Users/canonical',
    LANG: 'en_US.UTF-8',
    PATH: '/malicious/bin',
  }, '/Users/canonical'), {
    HOME: '/Users/canonical',
    LANG: 'en_US.UTF-8',
  })
  assert.throws(
    () => gate0ChildEnvironment({ HOME: '/Users/alternate' }, '/Users/canonical'),
    error => error instanceof Gate0ProbeError
      && error.code === 'caller_home_mismatch',
  )
})

test('the release app and Bridge must not be test-user-owned or writable', () => {
  assert.deepEqual(assertTrustedArtifactMetadata({
    dev: 1,
    ino: 2,
    mode: 0o100755,
    symbolicLink: false,
    uid: 0,
  }, 501), { dev: 1, ino: 2 })
  for (const metadata of [
    { dev: 1, ino: 2, mode: 0o100755, symbolicLink: false, uid: 501 },
    { dev: 1, ino: 2, mode: 0o100775, symbolicLink: false, uid: 0 },
    { dev: 1, ino: 2, mode: 0o120755, symbolicLink: true, uid: 0 },
  ]) {
    assert.throws(
      () => assertTrustedArtifactMetadata(metadata, 501),
      error => error instanceof Gate0ProbeError
        && error.code === 'untrusted_release_owner',
    )
  }
})

test('Soink-aligned target trust accepts a stable IMK client handoff without App identity proof', () => {
  const armed = {
    accepted: true,
    generation: 7,
    sessionId: 'session-1',
    targetId: 'target-1',
  }
  assert.deepEqual(assertIMKClientHandoff({
    after: { bundleId: 'com.apple.Safari', pid: 733 },
    armed,
    before: { bundleId: 'com.apple.Safari', pid: 733 },
  }), {
    generation: 7,
    sessionId: 'session-1',
    targetId: 'target-1',
  })
  assert.throws(
    () => assertIMKClientHandoff({
      after: { bundleId: 'com.apple.Terminal', pid: 744 },
      armed,
      before: { bundleId: 'com.apple.Safari', pid: 733 },
    }),
    error => error instanceof Gate0ProbeError
      && error.code === 'imk_client_unproven',
  )
  assert.doesNotThrow(() => assertObservedFocusUnchanged(
    { bundleId: 'com.apple.Safari', pid: 733 },
    { bundleId: 'com.apple.Safari', pid: 733 },
  ))
  assert.throws(
    () => assertObservedFocusUnchanged(
      { bundleId: 'com.apple.Safari', pid: 733 },
      { bundleId: 'com.apple.Terminal', pid: 744 },
    ),
    error => error instanceof Gate0ProbeError
      && error.code === 'observed_focus_changed',
  )
  assert.throws(
    () => assertIMKClientHandoff({
      after: { bundleId: 'com.apple.Safari', pid: 733 },
      armed: { accepted: true, generation: 7, sessionId: '', targetId: '' },
      before: { bundleId: 'com.apple.Safari', pid: 733 },
    }),
    error => error instanceof Gate0ProbeError
      && error.code === 'imk_client_unproven',
  )
})

test('trash cleanup ownership requires one new entry with the installed inode', () => {
  const before = new Map([['old.app', { dev: 1, ino: 10 }]])
  assert.deepEqual(matchOwnedTrashItem({
    after: new Map([
      ...before,
      ['Qwen Input.app', { dev: 1, ino: 11 }],
    ]),
    before,
    installedIdentity: { dev: 1, ino: 11 },
  }), { name: 'Qwen Input.app', identity: { dev: 1, ino: 11 } })
  assert.throws(
    () => matchOwnedTrashItem({
      after: new Map([
        ...before,
        ['Qwen Input.app', { dev: 1, ino: 99 }],
      ]),
      before,
      installedIdentity: { dev: 1, ino: 11 },
    }),
    error => error instanceof Gate0ProbeError
      && error.code === 'trash_ownership_unproven',
  )
})

test('bounded cleanup remains serial and attempts every action after failures', async () => {
  const names = ['cancel', 'uninstall', 'stop']
  for (const failing of names) {
    const calls = []
    await assert.rejects(
      runCleanupActions(names.map(name => [name, async () => {
        calls.push(name)
        if (name === failing) throw new Error('failed')
      }]), { timeoutMs: 100 }),
      error => error instanceof Gate0ProbeError && error.code === 'cleanup_failed',
    )
    assert.deepEqual(calls, names)
  }
})

test('a timed-out cleanup action is cancelled and settled before final verify', async () => {
  let lateMutation = false
  let settled = false
  let verifySawSettled = false
  const system = makeSystem({
    async cleanup() {
      await runCleanupActions([['slow-mutation', signal => new Promise(resolve => {
        const timer = setTimeout(() => {
          lateMutation = true
          settled = true
          resolve()
        }, 40)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          settled = true
          resolve()
        }, { once: true })
      })]], { timeoutMs: 5 })
    },
    async verifyCleanup() {
      verifySawSettled = settled
      return { ...cleanBaseline }
    },
  })

  await assert.rejects(
    captureRun(system),
    error => error instanceof Gate0ProbeError
      && error.code === 'cleanup_incomplete',
  )
  await new Promise(resolveDelay => setTimeout(resolveDelay, 60))
  assert.equal(verifySawSettled, true)
  assert.equal(lateMutation, false)
})

test('a timed-out Bridge request stops the child and awaits exit before continuing', async () => {
  const calls = []
  let rejectRequest
  const host = {
    request() {
      calls.push('request')
      return new Promise((resolve, reject) => {
        void resolve
        rejectRequest = () => {
          calls.push('request-cancelled')
          reject(new Error('stopped'))
        }
      })
    },
    async stop() {
      calls.push('stop-start')
      rejectRequest()
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
      calls.push('stop-settled')
    },
  }

  await assert.rejects(
    runCleanupActions([
      ['host-request', signal => requestHostWithCancellation(
        host,
        { type: 'lifecycle.uninstall' },
        signal,
      )],
      ['next', async () => { calls.push('next') }],
    ], { timeoutMs: 5 }),
    error => error instanceof Gate0ProbeError
      && error.code === 'cleanup_failed',
  )
  assert.deepEqual(calls, [
    'request',
    'stop-start',
    'request-cancelled',
    'stop-settled',
    'next',
  ])
})

test('pgrep exit 1 means no match but tool failures fail closed', () => {
  assert.doesNotThrow(() => requirePgrepNoMatch({ code: 1 }))
  assert.throws(
    () => requirePgrepNoMatch({ code: 127 }),
    error => error instanceof Gate0ProbeError
      && error.code === 'process_snapshot_failed',
  )
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
      if (command !== SYSTEM_TOOL_PATHS.codesign || args[0] !== '--display') {
        if (command === SYSTEM_TOOL_PATHS.spctl && args[0] === '--status') {
          return { output: 'assessments enabled' }
        }
        if (command === SYSTEM_TOOL_PATHS.xcrun && args[0] === '--find') {
          return { output: '/usr/bin/syspolicy_check' }
        }
        return { output: '' }
      }
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

  assert.ok(commands.every(call => call[0].startsWith('/')))
  assert.ok(commands.some(call => call[0] === SYSTEM_TOOL_PATHS.xcrun
    && call[1] === 'stapler'))
  assert.ok(commands.some(call => call[0] === SYSTEM_TOOL_PATHS.xcrun
    && call[1] === 'syspolicy_check' && call[2] === 'distribution'))
  assert.ok(commands.some(call => call[0] === SYSTEM_TOOL_PATHS.spctl
    && call[1] === '--status'))
  assert.ok(commands.some(call => call[0] === SYSTEM_TOOL_PATHS.spctl
    && call[1] === '--assess'))
  assert.equal(commands.filter(call => call[0] === SYSTEM_TOOL_PATHS.codesign
    && call[1] === '--display').length, 3)
  assert.ok(commands.some(call => call[0] === SYSTEM_TOOL_PATHS.codesign
    && call.includes('--deep') && call.includes('--strict')))
})

test('release verification fails closed when Gatekeeper assessments are disabled', async () => {
  await assert.rejects(
    verifyReleaseArtifact({
      appPath: '/Applications/Qwen Audio Agent.app',
      exists: () => true,
      execute: async (command, args) => {
        if (command === SYSTEM_TOOL_PATHS.spctl && args[0] === '--status') {
          return { output: 'assessments disabled' }
        }
        if (command === SYSTEM_TOOL_PATHS.codesign && args[0] === '--display') {
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
      && error.code === 'gatekeeper_disabled',
  )
})

test('release verification fails closed when the staple is invalid', async () => {
  await assert.rejects(
    verifyReleaseArtifact({
      appPath: '/Applications/Qwen Audio Agent.app',
      exists: () => true,
      execute: async (command, args) => {
        if (command === SYSTEM_TOOL_PATHS.xcrun && args[0] === 'stapler') {
          throw new Error('raw notarization output must not escape')
        }
        if (command === SYSTEM_TOOL_PATHS.codesign && args[0] === '--display') {
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

test('backup, staging, and unreadable Trash are dirty before setup confirmation', async () => {
  for (const changed of [
    { backupBundleExists: true },
    { stagingBundleCount: 1 },
    { trashReadable: false },
    { inputMethodsDirectorySafe: false },
  ]) {
    const system = makeSystem({
      async captureBaseline() {
        this.calls.push('baseline')
        return { ...cleanBaseline, ...changed }
      },
    })
    await assert.rejects(
      captureRun(system),
      error => error instanceof Gate0ProbeError
        && error.code === 'dirty_baseline',
    )
    assert.deepEqual(system.calls, ['host', 'release', 'baseline'])
  }
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

test('cleanup must restore the exact pre-run Trash snapshot', async () => {
  const system = makeSystem({
    async verifyCleanup() {
      this.calls.push('verify-cleanup')
      return { ...cleanBaseline, trashRestored: false }
    },
  })
  await assert.rejects(
    captureRun(system),
    error => error instanceof Gate0ProbeError
      && error.code === 'cleanup_incomplete',
  )
})

test('cleanup verification still runs when the first cleanup action fails', async () => {
  const system = makeSystem({
    async cleanup() {
      this.calls.push('cleanup')
      throw new Error('first cleanup step failed')
    },
  })

  await assert.rejects(
    captureRun(system),
    error => error instanceof Gate0ProbeError
      && error.code === 'cleanup_incomplete',
  )
  assert.deepEqual(system.calls.slice(-2), ['cleanup', 'verify-cleanup'])
})

test('an abort blocks every later mutation and uses the normal cleanup exit', async () => {
  const controller = new AbortController()
  const system = makeSystem({
    async install() {
      this.calls.push('install')
      controller.abort('SIGTERM')
    },
  })

  await assert.rejects(
    runGate0Probe({
      abortSignal: controller.signal,
      system,
      confirm: async () => true,
    }),
    error => error instanceof Gate0ProbeError && error.code === 'terminated',
  )
  assert.deepEqual(system.calls, [
    'host', 'release', 'baseline', 'install', 'cleanup', 'verify-cleanup',
  ])
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

test('the Swift helper emits only frontmost PID and bundle identity', {
  skip: process.platform !== 'darwin',
}, () => {
  const result = spawnSync('/usr/bin/xcrun', [
    'swift',
    resolve(root, 'scripts/native-input-release-gate0-tis.swift'),
    'frontmost',
    'unused',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const snapshot = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(snapshot).sort(), ['bundleId', 'pid'])
  assert.equal(typeof snapshot.bundleId, 'string')
  assert.equal(Number.isInteger(snapshot.pid), true)
})
