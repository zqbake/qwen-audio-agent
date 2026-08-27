import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const fixture = resolve(
  new URL('fixtures/native-input-release-gate0-process.mjs', import.meta.url).pathname,
)

function runScenario(scenario) {
  return spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    env: { GATE0_PROCESS_SCENARIO: scenario },
    timeout: 10_000,
  })
}

function parseNDJSON(output) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const event = JSON.parse(line)
    assert.deepEqual(
      Object.keys(event).sort(),
      event.status === 'fail'
        ? ['reason', 'stage', 'status']
        : ['stage', 'status'],
    )
    return event
  })
}

test('a root process is rejected before any mutation with fixed NDJSON', () => {
  const result = runScenario('root')
  assert.equal(result.status, 1, result.stderr)
  assert.deepEqual(parseNDJSON(result.stdout), [
    { reason: 'standard_user_required', stage: 'host', status: 'fail' },
    { reason: 'standard_user_required', stage: 'result', status: 'fail' },
  ])
})

test('a non-console user is rejected before any mutation', () => {
  const result = runScenario('non-console')
  assert.equal(result.status, 1, result.stderr)
  assert.deepEqual(parseNDJSON(result.stdout).at(-1), {
    reason: 'console_user_required',
    stage: 'result',
    status: 'fail',
  })
})

test('an alternate caller HOME is rejected before any mutation', () => {
  const result = runScenario('alternate-home')
  assert.equal(result.status, 1, result.stderr)
  assert.deepEqual(parseNDJSON(result.stdout), [
    { reason: 'caller_home_mismatch', stage: 'host', status: 'fail' },
    { reason: 'caller_home_mismatch', stage: 'result', status: 'fail' },
  ])
})

test('cleanup failure still emits one terminal result and no raw error', () => {
  const result = runScenario('cleanup-failure')
  assert.equal(result.status, 1, result.stderr)
  const events = parseNDJSON(result.stdout)
  assert.equal(events.filter(event => event.stage === 'result').length, 1)
  assert.deepEqual(events.at(-2), { stage: 'cleanup-verify', status: 'pass' })
  assert.deepEqual(events.at(-1), {
    reason: 'cleanup_incomplete',
    stage: 'result',
    status: 'fail',
  })
  assert.equal(result.stdout.includes('private cleanup detail'), false)
})

test('SIGTERM at every mutating phase uses one cleanup exit', {
  skip: process.platform === 'win32',
}, () => {
  for (const stage of ['install', 'fresh', 'textedit', 'cleanup']) {
    const result = runScenario(`signal-${stage}`)
    assert.equal(result.status, 143, `${stage}: ${result.stderr}`)
    const events = parseNDJSON(result.stdout)
    assert.equal(events.filter(event => event.stage === 'cleanup').length, 1)
    assert.equal(events.filter(event => event.stage === 'cleanup-verify').length, 1)
    assert.deepEqual(events.at(-1), {
      reason: 'terminated',
      stage: 'result',
      status: 'fail',
    })
  }
})

test('a malicious PATH shim cannot replace any release verification tool', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qg0-path-'))
  const marker = join(directory, 'invoked')
  for (const name of ['codesign', 'open', 'pgrep', 'pkill', 'spctl', 'xcrun']) {
    writeFileSync(join(directory, name), `#!/bin/sh\necho invoked >> "${marker}"\nexit 0\n`, {
      mode: 0o700,
    })
  }
  const result = spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    env: {
      GATE0_PROCESS_SCENARIO: 'release-path',
      PATH: directory,
    },
    timeout: 10_000,
  })
  assert.equal(result.status, 1, result.stderr)
  assert.deepEqual(parseNDJSON(result.stdout).at(-1), {
    reason: 'signature_invalid',
    stage: 'result',
    status: 'fail',
  })
  assert.throws(() => readFileSync(marker, 'utf8'), { code: 'ENOENT' })
})
