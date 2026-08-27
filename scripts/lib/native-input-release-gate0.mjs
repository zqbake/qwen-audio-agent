import { isAbsolute, join } from 'node:path'

export const GATE0_PARTIAL_TEXT = 'Qwen Gate 0 partial'
export const GATE0_FINAL_TEXT = 'Qwen Gate 0 final'
export const SYSTEM_TOOL_PATHS = Object.freeze({
  codesign: '/usr/bin/codesign',
  open: '/usr/bin/open',
  pgrep: '/usr/bin/pgrep',
  ps: '/bin/ps',
  spctl: '/usr/sbin/spctl',
  xcrun: '/usr/bin/xcrun',
})

export class Gate0ProbeError extends Error {
  constructor(code, options = {}) {
    super(code, options)
    this.name = 'Gate0ProbeError'
    this.code = code
  }
}

export function parseGate0Arguments(argv) {
  if (
    argv.length !== 2
    || argv[0] !== '--app'
    || !isAbsolute(argv[1])
    || !argv[1].endsWith('.app')
  ) {
    throw new Gate0ProbeError('invalid_arguments')
  }
  return { appPath: argv[1] }
}

export function assertGate0Host({
  consoleUid,
  euid,
  groups,
  homeUid,
  platform,
}) {
  if (platform !== 'darwin') throw new Gate0ProbeError('macos_required')
  if (euid === 0 || groups.includes(80)) {
    throw new Gate0ProbeError('standard_user_required')
  }
  if (!Number.isInteger(euid) || consoleUid !== euid) {
    throw new Gate0ProbeError('console_user_required')
  }
  if (homeUid !== euid) throw new Gate0ProbeError('home_owner_mismatch')
}

export async function verifyReleaseArtifact({ appPath, execute, exists }) {
  const resources = join(appPath, 'Contents', 'Resources', 'native-input')
  const bridgePath = join(resources, 'QwenInputBridge')
  const inputMethodPath = join(resources, 'Qwen Input.app')
  for (const path of [appPath, bridgePath, inputMethodPath]) {
    if (!exists(path)) throw new Gate0ProbeError('release_artifact_missing')
  }

  try {
    await execute(SYSTEM_TOOL_PATHS.codesign, [
      '--verify', '--deep', '--strict', appPath,
    ])
    await execute(SYSTEM_TOOL_PATHS.codesign, [
      '--verify', '--strict',
      '-R=identifier "ai.qwenaudio.agent.inputbridge" and anchor apple generic',
      bridgePath,
    ])
    await execute(SYSTEM_TOOL_PATHS.codesign, [
      '--verify', '--deep', '--strict',
      '-R=identifier "ai.qwenaudio.agent.inputmethod" and anchor apple generic',
      inputMethodPath,
    ])
  } catch (error) {
    throw new Gate0ProbeError('signature_invalid', { cause: error })
  }

  const metadataEntries = []
  for (const [expectedIdentifier, path] of [
    ['ai.qwenaudio.agent', appPath],
    ['ai.qwenaudio.agent.inputbridge', bridgePath],
    ['ai.qwenaudio.agent.inputmethod', inputMethodPath],
  ]) {
    try {
      const result = await execute(SYSTEM_TOOL_PATHS.codesign, [
        '--display', '--verbose=4', path,
      ])
      metadataEntries.push({ expectedIdentifier, output: result.output })
    } catch (error) {
      throw new Gate0ProbeError('signature_invalid', { cause: error })
    }
  }
  validateDeveloperIdMetadata(metadataEntries)

  try {
    await execute(SYSTEM_TOOL_PATHS.xcrun, ['stapler', 'validate', appPath])
  } catch (error) {
    throw new Gate0ProbeError('notarization_required', { cause: error })
  }
  try {
    const status = await execute(SYSTEM_TOOL_PATHS.spctl, ['--status'])
    if (!/\bassessments enabled\b/iu.test(status.output)) {
      throw new Gate0ProbeError('gatekeeper_disabled')
    }
  } catch (error) {
    if (error instanceof Gate0ProbeError) throw error
    throw new Gate0ProbeError('gatekeeper_disabled', { cause: error })
  }
  try {
    await execute(SYSTEM_TOOL_PATHS.spctl, [
      '--assess', '--type', 'execute', '--verbose=2', appPath,
    ])
  } catch (error) {
    throw new Gate0ProbeError('gatekeeper_rejected', { cause: error })
  }
  try {
    await execute(SYSTEM_TOOL_PATHS.xcrun, ['--find', 'syspolicy_check'])
  } catch {
    return { bridgePath, inputMethodPath }
  }
  try {
    await execute(SYSTEM_TOOL_PATHS.xcrun, [
      'syspolicy_check', 'distribution', appPath,
    ])
  } catch (error) {
    throw new Gate0ProbeError('gatekeeper_rejected', { cause: error })
  }
  return { bridgePath, inputMethodPath }
}

export function validateDeveloperIdMetadata(entries) {
  let teamIdentifier = null
  for (const { expectedIdentifier, output } of entries) {
    const metadata = parseCodeSignMetadata(output)
    if (
      metadata.identifier !== expectedIdentifier
      || metadata.signature === 'adhoc'
      || !metadata.authorities.some(value => value.startsWith(
        'Developer ID Application:',
      ))
      || !metadata.teamIdentifier
      || metadata.teamIdentifier === 'not set'
      || !metadata.flags.includes('runtime')
    ) {
      throw new Gate0ProbeError('developer_id_required')
    }
    if (teamIdentifier && metadata.teamIdentifier !== teamIdentifier) {
      throw new Gate0ProbeError('developer_id_required')
    }
    teamIdentifier = metadata.teamIdentifier
  }
  if (!teamIdentifier) throw new Gate0ProbeError('developer_id_required')
  return { teamIdentifier }
}

export async function runGate0Probe({
  abortSignal,
  system,
  confirm,
  report = () => {},
}) {
  await runStage(report, 'host', 'unsupported_host', () => (
    system.assertSupportedHost()
  ))
  await runStage(report, 'release', 'release_artifact_invalid', () => (
    system.verifyReleaseArtifact()
  ))
  const baseline = await runStage(
    report,
    'baseline',
    'dirty_baseline',
    async () => {
      const value = await system.captureBaseline()
      assertClean(value, value.keyboardId, 'dirty_baseline')
      return value
    },
  )

  assertNotAborted(abortSignal)
  let confirmed
  try {
    confirmed = await confirm()
  } catch (error) {
    if (abortSignal?.aborted) {
      const terminated = new Gate0ProbeError('terminated')
      report(failureEvent('setup-confirmation', terminated.code))
      throw terminated
    }
    throw error
  }
  assertNotAborted(abortSignal)
  if (!confirmed) {
    const error = new Gate0ProbeError('setup_not_confirmed')
    report(failureEvent('setup-confirmation', error.code))
    throw error
  }
  report(successEvent('setup-confirmation'))

  let primaryError = null
  try {
    assertNotAborted(abortSignal)
    await runStage(report, 'install', 'install_failed', () => system.install())
    assertNotAborted(abortSignal)
    await runStage(report, 'fresh-verify', 'fresh_verify_failed', async () => {
      const state = await system.freshState()
      if (state.keyboardId !== baseline.keyboardId) {
        throw new Gate0ProbeError('keyboard_changed')
      }
      if (
        state.qwenCount !== 1
        || state.enabled !== true
        || state.selected !== true
        || state.userBundleExists !== true
        || state.systemBundleExists !== false
      ) {
        throw new Gate0ProbeError('fresh_verify_failed')
      }
    })
    assertNotAborted(abortSignal)
    let textEditResult
    await runStage(report, 'textedit-partial', 'textedit_partial_failed', async () => {
      textEditResult = await system.exerciseTextEdit({
        finalText: GATE0_FINAL_TEXT,
        partialText: GATE0_PARTIAL_TEXT,
      })
      if (textEditResult?.partialAccepted !== true) {
        throw new Gate0ProbeError('textedit_partial_failed')
      }
    })
    assertNotAborted(abortSignal)
    await runStage(report, 'textedit-final', 'textedit_final_failed', async () => {
      if (
        textEditResult?.finalAccepted !== true
        || textEditResult.documentText !== GATE0_FINAL_TEXT
      ) {
        throw new Gate0ProbeError('textedit_final_failed')
      }
    })
  } catch (error) {
    primaryError = normalizeError(error, 'probe_failed')
  }

  let cleanupError = null
  try {
    await runStage(report, 'cleanup', 'cleanup_failed', () => (
      system.cleanup(baseline)
    ))
  } catch (error) {
    cleanupError = new Gate0ProbeError('cleanup_incomplete', { cause: error })
  }
  try {
    await runStage(report, 'cleanup-verify', 'cleanup_incomplete', async () => {
      const state = await system.verifyCleanup(baseline)
      assertClean(state, baseline.keyboardId)
    })
  } catch (error) {
    cleanupError ??= new Gate0ProbeError('cleanup_incomplete', { cause: error })
  }

  if (abortSignal?.aborted) {
    primaryError ??= new Gate0ProbeError('terminated')
  }
  if (cleanupError) throw cleanupError
  if (primaryError) throw primaryError
  report(successEvent('result'))
  return { status: 'pass' }
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Gate0ProbeError('terminated')
}

function parseCodeSignMetadata(output) {
  const metadata = {
    authorities: [],
    flags: '',
    identifier: '',
    signature: '',
    teamIdentifier: '',
  }
  for (const line of String(output).split(/\r?\n/u)) {
    if (/\bflags=.*\bruntime\b/u.test(line)) metadata.flags = line
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1).trim()
    if (key === 'Authority') metadata.authorities.push(value)
    else if (key === 'Identifier') metadata.identifier = value
    else if (key === 'TeamIdentifier') metadata.teamIdentifier = value
    else if (key === 'Signature') metadata.signature = value
    else if (key === 'flags') metadata.flags = value
  }
  return metadata
}

function assertClean(state, keyboardId, failureCode = 'cleanup_incomplete') {
  if (
    !keyboardId
    || state.keyboardId !== keyboardId
    || state.qwenCount !== 0
    || state.enabled !== false
    || state.selected !== false
    || state.userBundleExists !== false
    || state.systemBundleExists !== false
    || state.backupBundleExists !== false
    || state.stagingBundleCount !== 0
    || state.inputMethodsDirectorySafe !== true
    || state.qwenProcessCount !== 0
    || state.runtimeExists !== false
    || state.textEditRunning !== false
    || state.trashReadable !== true
    || state.trashRestored !== true
  ) {
    throw new Gate0ProbeError(failureCode)
  }
}

async function runStage(report, stage, fallbackCode, action) {
  try {
    const value = await action()
    report(successEvent(stage))
    return value
  } catch (error) {
    const normalized = normalizeError(error, fallbackCode)
    report(failureEvent(stage, normalized.code))
    throw normalized
  }
}

function normalizeError(error, fallbackCode) {
  return error instanceof Gate0ProbeError
    ? error
    : new Gate0ProbeError(fallbackCode, { cause: error })
}

function successEvent(stage) {
  return { stage, status: 'pass' }
}

function failureEvent(stage, reason) {
  return { reason, stage, status: 'fail' }
}
