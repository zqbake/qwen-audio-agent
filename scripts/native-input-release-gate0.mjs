#!/usr/bin/env node

import { execFile } from 'node:child_process'
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { NativeInputHost } from '../desktop/src/native-input-host.mjs'
import {
  Gate0ProbeError,
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
const systemBundle = '/Library/Input Methods/Qwen Input.app'
const runtimeDirectory = join(tmpdir(), `qwen-ni-${process.getuid?.() ?? 0}`)
const trashDirectory = join(homedir(), '.Trash')
const safeEnvironment = Object.fromEntries([
  'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR',
].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))

class LocalMacGate0System {
  constructor(appPath) {
    this.appPath = realpathIfPresent(appPath)
    this.bridgePath = join(
      this.appPath,
      'Contents/Resources/native-input/QwenInputBridge',
    )
    this.host = null
    this.baseline = null
    this.mutationStarted = false
    this.probeDirectory = null
    this.startedTextEdit = false
    this.trashBefore = new Set()
  }

  async assertSupportedHost() {
    assertGate0Host({
      groups: process.getgroups?.() ?? [],
      platform: process.platform,
    })
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Gate0ProbeError('interactive_terminal_required')
    }
  }

  async verifyReleaseArtifact() {
    const result = await verifyReleaseArtifact({
      appPath: this.appPath,
      exists: pathExists,
      execute: executeSafe,
    })
    this.bridgePath = result.bridgePath
  }

  async captureBaseline() {
    this.trashBefore = snapshotTrash()
    const baseline = await this.captureState()
    this.baseline = baseline
    return baseline
  }

  async install() {
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
  }

  async freshState() {
    return this.captureState()
  }

  async exerciseTextEdit({ partialText, finalText }) {
    this.probeDirectory = mkdtempSync(join(tmpdir(), 'qwen-g0-'))
    const documentPath = join(this.probeDirectory, 'gate0.txt')
    writeFileSync(documentPath, '', { encoding: 'utf8', mode: 0o600 })
    await executeSafe('open', ['-n', '-a', 'TextEdit', documentPath])
    this.startedTextEdit = true

    const host = this.ensureHost()
    const armed = await waitForArm(host)
    if (!armed) return { partialAccepted: false, finalAccepted: false }
    const partial = await host.request({
      type: 'session.partial',
      revision: 0,
      seq: 1,
      statusVisible: true,
      text: partialText,
    })
    if (partial?.accepted !== true) {
      return { partialAccepted: false, finalAccepted: false }
    }
    const final = await host.request({
      type: 'session.final',
      revision: 0,
      seq: 2,
      statusVisible: true,
      text: finalText,
    })
    const documentText = final?.accepted === true
      ? await waitForDocument(documentPath, finalText)
      : ''
    await cancelSession(host)
    return {
      documentText,
      finalAccepted: final?.accepted === true,
      partialAccepted: true,
    }
  }

  async cleanup(baseline = this.baseline) {
    await cancelSession(this.host)
    if (this.host?.state === 'ready') {
      try {
        await this.host.request({ type: 'lifecycle.uninstall' })
      } catch {
        // The bounded Qwen-only fallback below handles interrupted lifecycle work.
      }
    }
    if (this.host) {
      try { await this.host.stop('gate0_cleanup') } catch {}
      this.host = null
    }

    try { await runTIS('disable', qwenID) } catch {}
    if (baseline?.keyboardId) {
      const current = await snapshotTIS()
      if (current.keyboardId !== baseline.keyboardId) {
        try { await runTIS('select', baseline.keyboardId) } catch {}
      }
    }
    if (this.startedTextEdit) {
      await executeIgnoringFailure('pkill', ['-TERM', '-x', 'TextEdit'])
      await waitForProcessExit('TextEdit')
      this.startedTextEdit = false
    }
    await executeIgnoringFailure('pkill', ['-TERM', '-x', 'Qwen Input'])
    await executeIgnoringFailure('pkill', ['-TERM', '-x', 'QwenInputBridge'])
    removeOwnedPath(userBundle, { allowSymlink: true })
    removeSafeRuntime(runtimeDirectory)
    if (this.probeDirectory) {
      removeOwnedPath(this.probeDirectory)
      this.probeDirectory = null
    }
    removeNewQwenTrashItems(this.trashBefore)
  }

  async verifyCleanup() {
    return this.captureState()
  }

  async emergencyCleanup() {
    if (!this.mutationStarted) return
    try { await this.cleanup(this.baseline) } catch {}
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
      qwenProcessCount: await processCount([
        'Qwen Audio Agent', 'Qwen Input', 'QwenInputBridge',
      ]),
      runtimeExists: pathExists(runtimeDirectory),
      systemBundleExists: pathExists(systemBundle),
      textEditRunning: await processCount(['TextEdit']) > 0,
      userBundleExists: pathExists(userBundle),
    }
  }
}

async function main() {
  let options
  try {
    options = parseGate0Arguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(
      'Usage: npm run native-input:gate0:release -- --app "/Applications/Qwen Audio Agent.app"\n',
    )
    process.exitCode = 2
    return
  }

  const system = new LocalMacGate0System(options.appPath)
  let handlingSignal = false
  const handleSignal = async signal => {
    if (handlingSignal) return
    handlingSignal = true
    await system.emergencyCleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', () => { void handleSignal('SIGINT') })
  process.once('SIGTERM', () => { void handleSignal('SIGTERM') })

  try {
    await runGate0Probe({
      system,
      confirm: confirmSetup,
      report: event => process.stdout.write(`${JSON.stringify(event)}\n`),
    })
  } catch (error) {
    const reason = error instanceof Gate0ProbeError
      ? error.code
      : 'probe_failed'
    process.stdout.write(`${JSON.stringify({
      reason,
      stage: 'result',
      status: 'fail',
    })}\n`)
    process.exitCode = 1
  }
}

async function confirmSetup() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await terminal.question(
      'Gate 0 may show macOS-owned first-setup dialogs. Complete them yourself; type RUN to continue: ',
    )
    return answer.trim() === 'RUN'
  } finally {
    terminal.close()
  }
}

async function executeSafe(command, args) {
  const result = await executeFile(command, args, {
    encoding: 'utf8',
    env: safeEnvironment,
    maxBuffer: 1024 * 1024,
  })
  return { output: `${result.stdout || ''}\n${result.stderr || ''}` }
}

async function executeIgnoringFailure(command, args) {
  try { await executeSafe(command, args) } catch {}
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
  return executeSafe('xcrun', ['swift', tisHelper, action, value])
}

async function waitForArm(host) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const result = await host.request({
        type: 'session.arm',
        statusVisible: true,
      })
      if (result?.accepted === true) return true
    } catch {}
    await delay(250)
  }
  return false
}

async function cancelSession(host) {
  if (!host || host.state !== 'ready') return
  try {
    await host.request({
      reason: 'gate0_cleanup',
      statusVisible: true,
      type: 'session.cancel',
    })
  } catch {}
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
      const result = await executeSafe('pgrep', ['-x', name])
      count += result.output.trim().split(/\s+/u).filter(Boolean).length
    } catch {}
  }
  return count
}

async function waitForProcessExit(name) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await processCount([name]) === 0) return
    await delay(100)
  }
}

function snapshotTrash() {
  if (!pathExists(trashDirectory)) return new Set()
  try { return new Set(readdirSync(trashDirectory)) } catch { return new Set() }
}

function removeNewQwenTrashItems(before) {
  if (!pathExists(trashDirectory)) return
  let after
  try { after = readdirSync(trashDirectory) } catch { return }
  for (const name of after) {
    if (
      before.has(name)
      || !/^Qwen Input(?: \d+)?\.app$/u.test(name)
    ) continue
    removeOwnedPath(join(trashDirectory, name))
  }
}

function removeSafeRuntime(path) {
  if (!pathExists(path)) return
  const information = lstatSync(path)
  if (
    !information.isDirectory()
    || information.uid !== process.getuid()
    || (information.mode & 0o777) !== 0o700
  ) return
  removeOwnedPath(path)
}

function removeOwnedPath(path, { allowSymlink = false } = {}) {
  if (!pathExists(path)) return
  const information = lstatSync(path)
  if (information.uid !== process.getuid()) return
  if (information.isSymbolicLink() && !allowSymlink) return
  rmSync(path, { recursive: !information.isSymbolicLink(), force: true })
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

await main()
