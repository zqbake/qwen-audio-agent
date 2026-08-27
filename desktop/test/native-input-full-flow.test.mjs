import assert from 'node:assert/strict'
import { test } from 'node:test'

let fullFlow = null
let importError = null
try {
  fullFlow = await import('../../scripts/native-input-full-flow.mjs')
} catch (error) {
  importError = error
}

function requireFullFlow() {
  assert.equal(importError, null, importError?.stack || importError?.message)
  return fullFlow
}

test('automatic full flow runs every developer gate without an installed-app mutation', () => {
  const { createFullFlowStages } = requireFullFlow()
  const stages = createFullFlowStages({
    npmCli: '/opt/npm-cli.js',
    packageOutput: '/private/tmp/qwen-full-flow',
    releaseApp: null,
    root: '/repo',
  })

  assert.deepEqual(stages.map(stage => stage.name), [
    'native-tests',
    'repository-tests',
    'lint',
    'web-build',
    'native-release-build',
    'native-artifact-verify',
    'desktop-package',
    'desktop-package-verify',
    'desktop-smoke',
  ])
  assert.equal(
    stages.some(stage => stage.args.includes('native-input:gate0:release')),
    false,
  )
})

test('release mode appends one Gate 0 command after every automatic gate', () => {
  const {
    createFullFlowStages,
    parseFullFlowArguments,
  } = requireFullFlow()
  const releaseApp = '/Applications/Qwen Audio Agent.app'
  assert.deepEqual(parseFullFlowArguments([
    '--release-app', releaseApp,
  ]), { releaseApp })
  assert.deepEqual(parseFullFlowArguments([]), { releaseApp: null })

  const stages = createFullFlowStages({
    npmCli: '/opt/npm-cli.js',
    packageOutput: '/private/tmp/qwen-full-flow',
    releaseApp,
    root: '/repo',
  })
  const gate0 = stages.at(-1)
  assert.equal(gate0.name, 'release-gate0')
  assert.deepEqual(gate0.args, [
    '/repo/scripts/native-input-release-gate0.mjs',
    '--app',
    releaseApp,
  ])

  for (const argv of [
    ['--release-app'],
    ['--release-app', 'relative.app'],
    ['--yes'],
    ['--release-app', releaseApp, '--yes'],
  ]) {
    assert.throws(
      () => parseFullFlowArguments(argv),
      error => error?.code === 'invalid_arguments',
    )
  }
})

test('full flow strips provider, signing, and CI credentials from every child', () => {
  const { fullFlowEnvironment } = requireFullFlow()
  const environment = fullFlowEnvironment({
    APPLE_API_KEY: '/secure/notary.p8',
    APPLE_API_KEY_ID: 'key-id',
    APPLE_API_ISSUER: 'issuer',
    CSC_KEY_PASSWORD: 'password',
    CSC_LINK: 'certificate',
    DASHSCOPE_API_KEY: 'provider-secret',
    GITHUB_TOKEN: 'github-secret',
    HOME: '/Users/tester',
    LANG: 'en_US.UTF-8',
    PATH: '/usr/bin:/bin',
    QWEN_AUDIO_DICTATION_API_KEY: 'dictation-secret',
    QWEN_AUDIO_REALTIME_API_KEY: 'realtime-secret',
  })

  assert.deepEqual(environment, {
    HOME: '/Users/tester',
    LANG: 'en_US.UTF-8',
    PATH: '/usr/bin:/bin',
  })
})

test('full flow executes stages serially, cleans, then emits one result', async () => {
  const { runFullFlowStages } = requireFullFlow()
  const calls = []
  const events = []
  const stages = ['native-tests', 'repository-tests', 'desktop-smoke']
    .map(name => ({ name, command: '/usr/bin/true', args: [] }))

  const result = await runFullFlowStages({
    stages,
    execute: async stage => { calls.push(stage.name) },
    finalize: async () => { calls.push('package-cleanup') },
    report: event => events.push(event),
  })

  assert.deepEqual(calls, [
    ...stages.map(stage => stage.name),
    'package-cleanup',
  ])
  assert.deepEqual(events, [
    { stage: 'native-tests', status: 'pass' },
    { stage: 'repository-tests', status: 'pass' },
    { stage: 'desktop-smoke', status: 'pass' },
    { stage: 'result', status: 'pass' },
  ])
  assert.deepEqual(result, { status: 'pass' })
})

test('full flow stops at the first failing stage without leaking its error', async () => {
  const { runFullFlowStages } = requireFullFlow()
  const calls = []
  const events = []
  const stages = ['native-tests', 'lint', 'desktop-package']
    .map(name => ({ name, command: '/usr/bin/true', args: [] }))

  await assert.rejects(
    runFullFlowStages({
      stages,
      execute: async stage => {
        calls.push(stage.name)
        if (stage.name === 'lint') throw new Error('secret provider response')
      },
      finalize: async () => { calls.push('package-cleanup') },
      report: event => events.push(event),
    }),
    error => error?.code === 'stage_failed' && error?.stage === 'lint',
  )

  assert.deepEqual(calls, ['native-tests', 'lint', 'package-cleanup'])
  assert.deepEqual(events, [
    { stage: 'native-tests', status: 'pass' },
    { reason: 'stage_failed', stage: 'lint', status: 'fail' },
    { reason: 'stage_failed', stage: 'result', status: 'fail' },
  ])
  assert.equal(JSON.stringify(events).includes('provider response'), false)
})

test('artifact verification requires both native release architectures', () => {
  const { assertUniversalArchitectures } = requireFullFlow()
  assert.doesNotThrow(() => assertUniversalArchitectures('x86_64 arm64\n'))
  assert.doesNotThrow(() => assertUniversalArchitectures('arm64 x86_64\n'))
  for (const output of ['arm64\n', 'x86_64\n', 'arm64 arm64\n', '']) {
    assert.throws(
      () => assertUniversalArchitectures(output),
      error => error?.code === 'universal_artifact_required',
    )
  }
})

test('package verification selects exactly one app and one DMG from this run', () => {
  const { selectPackageArtifacts } = requireFullFlow()
  assert.deepEqual(selectPackageArtifacts([
    '/private/tmp/run/mac-arm64/Qwen Audio Agent.app',
    '/private/tmp/run/qwen-audio-agent-1.11.0-mac-arm64.dmg',
    '/private/tmp/run/qwen-audio-agent-1.11.0-mac-arm64.dmg.blockmap',
  ]), {
    appPath: '/private/tmp/run/mac-arm64/Qwen Audio Agent.app',
    dmgPath: '/private/tmp/run/qwen-audio-agent-1.11.0-mac-arm64.dmg',
  })

  for (const paths of [
    [],
    ['/private/tmp/run/mac-arm64/Qwen Audio Agent.app'],
    [
      '/private/tmp/run/mac-arm64/Qwen Audio Agent.app',
      '/private/tmp/run/mac-universal/Qwen Audio Agent.app',
      '/private/tmp/run/qwen.dmg',
    ],
  ]) {
    assert.throws(
      () => selectPackageArtifacts(paths),
      error => error?.code === 'package_artifact_unproven',
    )
  }
})
