#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  constants as fileConstants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { NativeInputHost } from '../desktop/src/native-input-host.mjs'
import {
  Gate0ProbeError,
  SYSTEM_TOOL_PATHS,
  assertGate0Host,
  parseGate0Arguments,
  runGate0Probe,
  verifyReleaseArtifact,
} from './lib/native-input-release-gate0.mjs'

const executeFile = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tisHelper = resolve(root, 'scripts/native-input-release-gate0-tis.swift')
const qwenID = 'ai.qwenaudio.agent.inputmethod'
const userBundle = join(homedir(), 'Library/Input Methods/Qwen Input.app')
const inputMethodsDirectory = dirname(userBundle)
const backupBundle = join(inputMethodsDirectory, '.qwen-input-last-known-good')
const systemBundle = '/Library/Input Methods/Qwen Input.app'
const runtimeDirectory = join(tmpdir(), `qwen-ni-${process.getuid?.() ?? 0}`)
const trashDirectory = join(homedir(), '.Trash')
const safeEnvironment = gate0ChildEnvironment(process.env)

export function gate0ChildEnvironment(environment = {}) {
  return Object.fromEntries([
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
  ].flatMap(key => environment[key] ? [[key, environment[key]]] : []))
}

export function assertTrustedArtifactMetadata(
  metadata,
  currentUid = process.getuid?.(),
) {
  if (
    !Number.isInteger(metadata?.uid)
    || metadata.uid === currentUid
    || metadata.symbolicLink === true
    || (metadata.mode & 0o022) !== 0
    || !Number.isInteger(metadata.dev)
    || !Number.isInteger(metadata.ino)
  ) {
    throw new Gate0ProbeError('untrusted_release_owner')
  }
  return { dev: metadata.dev, ino: metadata.ino }
}

export function assertTextEditTarget({ after, armed, before, launchedPID }) {
  const textEdit = value => value?.bundleId === 'com.apple.TextEdit'
    && Number.isInteger(value.pid)
    && value.pid === launchedPID
  if (
    !textEdit(before)
    || !textEdit(after)
    || armed?.accepted !== true
    || typeof armed.sessionId !== 'string'
    || !armed.sessionId
    || !Number.isInteger(armed.generation)
    || typeof armed.targetId !== 'string'
    || !armed.targetId
  ) {
    throw new Gate0ProbeError('textedit_target_unproven')
  }
  return {
    generation: armed.generation,
    sessionId: armed.sessionId,
    targetId: armed.targetId,
  }
}

export function matchOwnedTrashItem({ after, before, installedIdentity }) {
  const candidates = [...after].filter(([name, identity]) => (
    !before.has(name)
    && /^Qwen Input(?: \d+)?\.app$/u.test(name)
    && sameIdentity(identity, installedIdentity)
  ))
  if (candidates.length !== 1) {
    throw new Gate0ProbeError('trash_ownership_unproven')
  }
  const [name, identity] = candidates[0]
  return { identity, name }
}

export async function runCleanupActions(actions, { timeoutMs = 10_000 } = {}) {
  const failures = []
  for (const [name, action] of actions) {
    try {
      await withTimeout(action(), timeoutMs)
    } catch {
      failures.push(name)
    }
  }
  if (failures.length > 0) throw new Gate0ProbeError('cleanup_failed')
}

export function requirePgrepNoMatch(error) {
  if (error?.code !== 1) throw new Gate0ProbeError('process_snapshot_failed')
}

export class LocalMacGate0System {
  constructor(appPath, { abortSignal, input = process.stdin } = {}) {
    this.appPath = realpathIfPresent(appPath)
    this.bridgePath = join(
      this.appPath,
      'Contents/Resources/native-input/QwenInputBridge',
    )
    this.host = null
    this.cleanupPromise = null
    this.abortSignal = abortSignal
    this.input = input
    this.baseline = null
    this.mutationStarted = false
    this.probeDirectory = null
    this.bridgeIdentity = null
    this.installedIdentity = null
    this.probeIdentity = null
    this.startedTextEdit = null
    this.targetCapability = null
    this.trashBefore = new Map()
    this.ownedTrashItem = null
  }

  async assertSupportedHost() {
    if (process.platform !== 'darwin') {
      throw new Gate0ProbeError('macos_required')
    }
    assertGate0Host({
      consoleUid: lstatSync('/dev/console').uid,
      euid: process.geteuid?.(),
      groups: process.getgroups?.() ?? [],
      homeUid: lstatSync(homedir()).uid,
      platform: process.platform,
    })
    if (!this.input.isTTY) {
      throw new Gate0ProbeError('interactive_terminal_required')
    }
  }

  async verifyReleaseArtifact() {
    const result = await verifyReleaseArtifact({
      appPath: this.appPath,
      exists: pathExists,
      execute: executeSafe,
    })
    for (const path of [this.appPath, result.bridgePath, result.inputMethodPath]) {
      trustedArtifactIdentity(path)
    }
    this.bridgePath = realpathSync(result.bridgePath)
    this.bridgeIdentity = trustedArtifactIdentity(this.bridgePath)
  }

  async captureBaseline() {
    this.trashBefore = snapshotTrash()
    const baseline = await this.captureState()
    baseline.trashRestored = true
    this.baseline = baseline
    return baseline
  }

  async install() {
    assertNotAborted(this.abortSignal)
    await this.verifyPinnedBridge()
    this.mutationStarted = true
    const host = this.ensureHost()
    await host.start()
    const result = await host.request({ type: 'lifecycle.install' })
    if (
      result?.accepted !== true
      || result.installed !== true
      || result.registered !== true
      || result.enabled !== true
      || result.selected !== true
    ) {
      throw new Gate0ProbeError('install_failed')
    }
    this.installedIdentity = ownedIdentity(userBundle)
  }

  async freshState() {
    return this.captureState()
  }

  async exerciseTextEdit({ partialText, finalText }) {
    assertNotAborted(this.abortSignal)
    this.probeDirectory = mkdtempSync(join(tmpdir(), 'qwen-g0-'))
    this.probeIdentity = ownedIdentity(this.probeDirectory)
    const documentPath = join(this.probeDirectory, 'gate0.txt')
    writeFileSync(documentPath, '', { encoding: 'utf8', mode: 0o600 })
    if ((await processIDs('TextEdit')).length !== 0) {
      throw new Gate0ProbeError('textedit_ownership_unproven')
    }
    await executeSafe(SYSTEM_TOOL_PATHS.open, [
      '-n', '-a', 'TextEdit', documentPath,
    ])
    const textEditPID = await waitForSingleProcess('TextEdit')
    this.startedTextEdit = await captureProcessIdentity(textEditPID)
    const before = await waitForFrontmostTextEdit(textEditPID)

    const host = this.ensureHost()
    host.requestTimeoutMs = 5_000
    const armed = await waitForArm(host)
    const after = await snapshotFrontmost()
    this.targetCapability = assertTextEditTarget({
      after,
      armed,
      before,
      launchedPID: textEditPID,
    })
    assertNotAborted(this.abortSignal)
    await assertFrontmostTextEdit(textEditPID)
    const partial = await host.request({
      ...this.targetCapability,
      type: 'session.partial',
      revision: 0,
      seq: 1,
      statusVisible: true,
      text: partialText,
    })
    if (partial?.accepted !== true) {
      return { partialAccepted: false, finalAccepted: false }
    }
    assertNotAborted(this.abortSignal)
    await assertFrontmostTextEdit(textEditPID)
    const final = await host.request({
      ...this.targetCapability,
      type: 'session.final',
      revision: 0,
      seq: 2,
      statusVisible: true,
      text: finalText,
    })
    const documentText = final?.accepted === true
      ? await waitForDocument(documentPath, finalText)
      : ''
    await cancelSession(host, this.targetCapability)
    this.targetCapability = null
    return {
      documentText,
      finalAccepted: final?.accepted === true,
      partialAccepted: true,
    }
  }

  cleanup(baseline = this.baseline) {
    this.cleanupPromise ??= this.performCleanup(baseline)
    return this.cleanupPromise
  }

  async performCleanup(baseline) {
    void baseline
    if (!this.mutationStarted) return
    if (this.host) this.host.requestTimeoutMs = 8_000
    await runCleanupActions([
      ['cancel', () => cancelSession(this.host, this.targetCapability)],
      ['uninstall', () => this.uninstallOwnedBundle()],
      ['stop-bridge', () => this.stopHost()],
      ['disable-palette', () => runTIS('disable', qwenID)],
      ['terminate-textedit', () => this.terminateOwnedTextEdit()],
      ['remove-probe', () => this.removeOwnedProbe()],
      ['remove-trash', () => this.removeOwnedTrashItem()],
    ])
  }

  async verifyCleanup() {
    const state = await this.captureState()
    state.trashRestored = sameDirectorySnapshot(
      snapshotTrash(),
      this.trashBefore,
    )
    return state
  }

  ensureHost() {
    if (!this.host) {
      this.host = new NativeInputHost({
        environment: safeEnvironment,
        requestTimeoutMs: 300_000,
        resolveArtifact: () => this.bridgePath,
        startupTimeoutMs: 10_000,
        stopTimeoutMs: 5_000,
      })
    }
    return this.host
  }

  async captureState() {
    const tis = await snapshotTIS()
    return {
      ...tis,
      backupBundleExists: pathExists(backupBundle),
      inputMethodsDirectorySafe: inputMethodsDirectoryIsSafe(),
      qwenProcessCount: await processCount([
        'Qwen Audio Agent', 'Qwen Input', 'QwenInputBridge',
      ]),
      runtimeExists: pathExists(runtimeDirectory),
      stagingBundleCount: stagingBundleCount(),
      systemBundleExists: pathExists(systemBundle),
      textEditRunning: await processCount(['TextEdit']) > 0,
      trashReadable: trashIsReadable(),
      userBundleExists: pathExists(userBundle),
    }
  }

  async verifyPinnedBridge() {
    if (!sameIdentity(readIdentity(this.bridgePath), this.bridgeIdentity)) {
      throw new Gate0ProbeError('bridge_identity_changed')
    }
    try {
      await executeSafe(SYSTEM_TOOL_PATHS.codesign, [
        '--verify', '--strict',
        '-R=identifier "ai.qwenaudio.agent.inputbridge" and anchor apple generic',
        this.bridgePath,
      ])
    } catch (error) {
      throw new Gate0ProbeError('bridge_identity_changed', { cause: error })
    }
  }

  async uninstallOwnedBundle() {
    if (!this.installedIdentity && pathExists(userBundle)) {
      this.installedIdentity = ownedIdentity(userBundle)
    }
    if (!this.installedIdentity) return
    if (!sameIdentity(readIdentity(userBundle), this.installedIdentity)) {
      throw new Gate0ProbeError('installed_bundle_identity_changed')
    }
    if (!this.host || this.host.state !== 'ready') {
      throw new Gate0ProbeError('bridge_unavailable_for_uninstall')
    }
    const result = await this.host.request({ type: 'lifecycle.uninstall' })
    if (result?.accepted !== true || result.installed !== false) {
      throw new Gate0ProbeError('uninstall_failed')
    }
    const owned = matchOwnedTrashItem({
      after: snapshotTrash(),
      before: this.trashBefore,
      installedIdentity: this.installedIdentity,
    })
    this.ownedTrashItem = {
      identity: owned.identity,
      path: join(trashDirectory, owned.name),
    }
  }

  async stopHost() {
    if (!this.host) return
    try {
      await this.host.stop('gate0_cleanup')
    } finally {
      this.host = null
    }
  }

  async terminateOwnedTextEdit() {
    if (!this.startedTextEdit) return
    const current = await captureProcessIdentity(this.startedTextEdit.pid)
    if (!sameProcessIdentity(current, this.startedTextEdit)) {
      throw new Gate0ProbeError('textedit_ownership_changed')
    }
    process.kill(this.startedTextEdit.pid, 'SIGTERM')
    await waitForPIDExit(this.startedTextEdit.pid)
    this.startedTextEdit = null
  }

  async removeOwnedProbe() {
    if (!this.probeDirectory) return
    removeOwnedPath(this.probeDirectory, { expected: this.probeIdentity })
    this.probeDirectory = null
    this.probeIdentity = null
  }

  async removeOwnedTrashItem() {
    if (!this.ownedTrashItem) return
    removeOwnedPath(this.ownedTrashItem.path, {
      expected: this.ownedTrashItem.identity,
    })
    this.ownedTrashItem = null
  }
}

export async function runGate0Command({
  argv = process.argv.slice(2),
  confirm,
  errorOutput = process.stderr,
  input = process.stdin,
  output = process.stdout,
  processObject = process,
  systemFactory = (appPath, options) => new LocalMacGate0System(appPath, options),
} = {}) {
  let options
  try {
    options = parseGate0Arguments(argv)
  } catch {
    errorOutput.write(
      'Usage: npm run native-input:gate0:release -- --app "/Applications/Qwen Audio Agent.app"\n',
    )
    writeEvent(output, {
      reason: 'invalid_arguments',
      stage: 'result',
      status: 'fail',
    })
    return 2
  }

  const abortController = new AbortController()
  let terminationSignal = null
  const handleSignal = signal => {
    terminationSignal ??= signal
    if (!abortController.signal.aborted) abortController.abort(signal)
  }
  const handleInterrupt = () => handleSignal('SIGINT')
  const handleTerminate = () => handleSignal('SIGTERM')
  processObject.once('SIGINT', handleInterrupt)
  processObject.once('SIGTERM', handleTerminate)
  const system = systemFactory(options.appPath, {
    abortSignal: abortController.signal,
    errorOutput,
    input,
  })

  try {
    await runGate0Probe({
      abortSignal: abortController.signal,
      system,
      confirm: confirm ?? (() => confirmSetup({
        abortSignal: abortController.signal,
        input,
        output: errorOutput,
      })),
      report: event => writeEvent(output, event),
    })
    return 0
  } catch (error) {
    const reason = error instanceof Gate0ProbeError
      ? error.code
      : 'probe_failed'
    writeEvent(output, {
      reason,
      stage: 'result',
      status: 'fail',
    })
    if (terminationSignal === 'SIGINT') return 130
    if (terminationSignal === 'SIGTERM') return 143
    return 1
  } finally {
    processObject.removeListener('SIGINT', handleInterrupt)
    processObject.removeListener('SIGTERM', handleTerminate)
  }
}

async function confirmSetup({ abortSignal, input, output }) {
  const terminal = createInterface({ input, output })
  try {
    const answer = await terminal.question(
      'Gate 0 may show macOS-owned first-setup dialogs. Complete them yourself; type RUN to continue: ',
      { signal: abortSignal },
    )
    return answer.trim() === 'RUN'
  } finally {
    terminal.close()
  }
}

function writeEvent(output, event) {
  const value = event.status === 'fail'
    ? { reason: event.reason, stage: event.stage, status: event.status }
    : { stage: event.stage, status: event.status }
  output.write(`${JSON.stringify(value)}\n`)
}

async function executeSafe(command, args) {
  if (!isAbsolute(command)) throw new Gate0ProbeError('untrusted_tool_path')
  const result = await executeFile(command, args, {
    encoding: 'utf8',
    env: safeEnvironment,
    maxBuffer: 1024 * 1024,
  })
  return { output: `${result.stdout || ''}\n${result.stderr || ''}` }
}

async function snapshotTIS() {
  const result = await runTIS('snapshot', qwenID)
  try {
    const value = JSON.parse(result.output)
    return {
      enabled: value.enabled === true,
      keyboardId: typeof value.keyboardId === 'string' ? value.keyboardId : '',
      qwenCount: Number(value.qwenCount),
      selected: value.selected === true,
    }
  } catch (error) {
    throw new Gate0ProbeError('tis_snapshot_failed', { cause: error })
  }
}

function runTIS(action, value) {
  return executeSafe(SYSTEM_TOOL_PATHS.xcrun, [
    'swift', tisHelper, action, value,
  ])
}

async function waitForArm(host) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const result = await host.request({
        type: 'session.arm',
        statusVisible: true,
      })
      if (result?.accepted === true) return result
    } catch {}
    await delay(250)
  }
  throw new Gate0ProbeError('textedit_target_unproven')
}

async function cancelSession(host, capability = null) {
  if (!host || host.state !== 'ready' || !capability) return
  const result = await host.request({
    ...(capability || {}),
    reason: 'gate0_cleanup',
    statusVisible: true,
    type: 'session.cancel',
  })
  if (result?.accepted !== true) throw new Gate0ProbeError('cancel_failed')
}

async function waitForDocument(path, expected) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const value = readFileSync(path, 'utf8')
      if (value === expected) return value
    } catch {}
    await delay(250)
  }
  return ''
}

async function processCount(names) {
  let count = 0
  for (const name of names) {
    try {
      const result = await executeSafe(SYSTEM_TOOL_PATHS.pgrep, ['-x', name])
      count += result.output.trim().split(/\s+/u).filter(Boolean).length
    } catch (error) {
      requirePgrepNoMatch(error)
    }
  }
  return count
}

async function processIDs(name) {
  try {
    const result = await executeSafe(SYSTEM_TOOL_PATHS.pgrep, ['-x', name])
    return result.output.trim().split(/\s+/u).filter(Boolean).map(Number)
      .filter(Number.isInteger)
  } catch (error) {
    requirePgrepNoMatch(error)
    return []
  }
}

async function waitForSingleProcess(name) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const pids = await processIDs(name)
    if (pids.length === 1) return pids[0]
    if (pids.length > 1) throw new Gate0ProbeError('textedit_ownership_unproven')
    await delay(100)
  }
  throw new Gate0ProbeError('textedit_ownership_unproven')
}

async function waitForPIDExit(pid) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await delay(100)
  }
  throw new Gate0ProbeError('textedit_exit_timeout')
}

function snapshotTrash() {
  accessSync(trashDirectory, fileConstants.R_OK | fileConstants.W_OK)
  const directory = lstatSync(trashDirectory)
  if (
    !directory.isDirectory()
    || directory.isSymbolicLink()
    || directory.uid !== process.getuid()
  ) {
    throw new Gate0ProbeError('trash_ownership_unproven')
  }
  const result = new Map()
  for (const name of readdirSync(trashDirectory)) {
    result.set(name, readIdentity(join(trashDirectory, name)))
  }
  return result
}

function inputMethodsDirectoryIsSafe() {
  if (!pathExists(inputMethodsDirectory)) return true
  const information = lstatSync(inputMethodsDirectory)
  return information.isDirectory()
    && !information.isSymbolicLink()
    && information.uid === process.getuid()
}

function removeOwnedPath(path, { expected } = {}) {
  if (!pathExists(path)) return
  const information = lstatSync(path)
  if (
    information.uid !== process.getuid()
    || information.isSymbolicLink()
    || !sameIdentity(information, expected)
  ) {
    throw new Gate0ProbeError('path_ownership_unproven')
  }
  const quarantine = `${path}.qwen-gate0-${randomUUID()}`
  renameSync(path, quarantine)
  if (!sameIdentity(readIdentity(quarantine), expected)) {
    if (!pathExists(path)) renameSync(quarantine, path)
    throw new Gate0ProbeError('path_ownership_unproven')
  }
  rmSync(quarantine, { recursive: true, force: true })
}

function stagingBundleCount() {
  if (!pathExists(inputMethodsDirectory)) return 0
  return readdirSync(inputMethodsDirectory)
    .filter(name => name.startsWith('.qwen-input-staging-')).length
}

function trashIsReadable() {
  try {
    snapshotTrash()
    return true
  } catch {
    return false
  }
}

function ownedIdentity(path) {
  const information = lstatSync(path)
  if (
    information.isSymbolicLink()
    || information.uid !== process.getuid()
  ) {
    throw new Gate0ProbeError('path_ownership_unproven')
  }
  return readIdentity(path)
}

function trustedArtifactIdentity(path) {
  const information = lstatSync(path)
  return assertTrustedArtifactMetadata({
    dev: information.dev,
    ino: information.ino,
    mode: information.mode,
    symbolicLink: information.isSymbolicLink(),
    uid: information.uid,
  }, process.getuid())
}

function readIdentity(path) {
  const information = lstatSync(path)
  return { dev: information.dev, ino: information.ino }
}

async function captureProcessIdentity(pid) {
  const result = await executeSafe(SYSTEM_TOOL_PATHS.ps, [
    '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'comm=',
  ])
  const output = result.output.trim()
  const match = output.match(/^(\d+)\s+(.{24})\s+(.+)$/u)
  if (!match || Number(match[1]) !== process.getuid()) {
    throw new Gate0ProbeError('textedit_ownership_unproven')
  }
  return { command: match[3], pid, startedAt: match[2], uid: Number(match[1]) }
}

function sameProcessIdentity(left, right) {
  return left?.pid === right?.pid
    && left?.uid === right?.uid
    && left?.startedAt === right?.startedAt
    && left?.command === right?.command
}

async function snapshotFrontmost() {
  const result = await runTIS('frontmost', 'unused')
  try {
    const value = JSON.parse(result.output)
    return {
      bundleId: typeof value.bundleId === 'string' ? value.bundleId : '',
      pid: Number(value.pid),
    }
  } catch (error) {
    throw new Gate0ProbeError('frontmost_snapshot_failed', { cause: error })
  }
}

async function waitForFrontmostTextEdit(pid) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await snapshotFrontmost()
    if (value.bundleId === 'com.apple.TextEdit' && value.pid === pid) return value
    await delay(100)
  }
  throw new Gate0ProbeError('textedit_target_unproven')
}

async function assertFrontmostTextEdit(pid) {
  const value = await snapshotFrontmost()
  if (value.bundleId !== 'com.apple.TextEdit' || value.pid !== pid) {
    throw new Gate0ProbeError('textedit_target_changed')
  }
}

function realpathIfPresent(path) {
  try { return realpathSync(path) } catch { return path }
}

function pathExists(path) {
  try { lstatSync(path); return true } catch { return false }
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Gate0ProbeError('terminated')
}

function sameIdentity(left, right) {
  return Number.isInteger(left?.dev)
    && Number.isInteger(left?.ino)
    && left.dev === right?.dev
    && left.ino === right?.ino
}

function sameDirectorySnapshot(left, right) {
  if (left.size !== right.size) return false
  for (const [name, identity] of left) {
    if (!sameIdentity(identity, right.get(name))) return false
  }
  return true
}

async function withTimeout(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new Gate0ProbeError('cleanup_timeout')),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runGate0Command()
}
