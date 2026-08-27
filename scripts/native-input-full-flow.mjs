#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(scriptPath), '..')
const SYSTEM_TOOLS = Object.freeze({
  codesign: '/usr/bin/codesign',
  hdiutil: '/usr/bin/hdiutil',
  lipo: '/usr/bin/lipo',
})
const PRIVATE_ENVIRONMENT_KEYS = new Set([
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'DASHSCOPE_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'QWEN_AUDIO_DICTATION_API_KEY',
  'QWEN_AUDIO_REALTIME_API_KEY',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
])

export class FullFlowError extends Error {
  constructor(code, { cause, stage } = {}) {
    super(code, { cause })
    this.code = code
    this.stage = stage
  }
}

export function parseFullFlowArguments(argv) {
  if (argv.length === 0) return { releaseApp: null }
  if (
    argv.length === 2
    && argv[0] === '--release-app'
    && typeof argv[1] === 'string'
    && isAbsolute(argv[1])
    && basename(argv[1]).endsWith('.app')
  ) {
    return { releaseApp: argv[1] }
  }
  throw new FullFlowError('invalid_arguments')
}

export function fullFlowEnvironment(environment = {}) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => (
    !PRIVATE_ENVIRONMENT_KEYS.has(key)
    && !(/^QWEN_AUDIO_.*_API_KEY$/u).test(key)
  )))
}

export function createFullFlowStages({
  npmCli,
  packageOutput,
  releaseApp,
  root,
}) {
  for (const path of [npmCli, packageOutput, root]) {
    if (!isAbsolute(path)) throw new FullFlowError('untrusted_execution_path')
  }
  const npmStage = (name, args) => ({
    args: [npmCli, ...args],
    command: process.execPath,
    cwd: root,
    name,
  })
  const stages = [
    npmStage('native-tests', ['run', 'native-input:test']),
    npmStage('repository-tests', ['test']),
    npmStage('lint', ['run', 'lint']),
    npmStage('web-build', ['run', 'build']),
    npmStage('native-release-build', ['run', 'native-input:build:release']),
    {
      args: [],
      command: null,
      cwd: root,
      kind: 'native-artifact-verify',
      name: 'native-artifact-verify',
    },
    {
      args: [
        join(root, 'node_modules/electron-builder/out/cli/cli.js'),
        '--config', join(root, 'desktop/electron-builder.yml'),
        '--config.mac.identity=-',
        '--config.mac.hardenedRuntime=false',
        '--config.mac.notarize=false',
        `--config.directories.output=${packageOutput}`,
        '--mac', 'dmg',
        '--publish', 'never',
      ],
      command: process.execPath,
      cwd: root,
      name: 'desktop-package',
    },
    {
      args: [],
      command: null,
      cwd: root,
      kind: 'desktop-package-verify',
      name: 'desktop-package-verify',
      packageOutput,
    },
    npmStage('desktop-smoke', ['run', 'test:desktop-smoke']),
  ]
  if (releaseApp) {
    if (!isAbsolute(releaseApp)) throw new FullFlowError('invalid_arguments')
    stages.push({
      args: [
        join(root, 'scripts/native-input-release-gate0.mjs'),
        '--app',
        releaseApp,
      ],
      command: process.execPath,
      cwd: root,
      name: 'release-gate0',
    })
  }
  return stages
}

export async function runFullFlowStages({
  execute,
  finalize = async () => {},
  report,
  stages,
}) {
  let failure = null
  for (const stage of stages) {
    try {
      await execute(stage)
      report({ stage: stage.name, status: 'pass' })
    } catch (cause) {
      report({
        reason: 'stage_failed',
        stage: stage.name,
        status: 'fail',
      })
      failure = new FullFlowError('stage_failed', {
        cause,
        stage: stage.name,
      })
      break
    }
  }
  try {
    await finalize()
  } catch (cause) {
    report({
      reason: 'cleanup_failed',
      stage: 'package-cleanup',
      status: 'fail',
    })
    failure = new FullFlowError('stage_failed', {
      cause,
      stage: 'package-cleanup',
    })
  }
  if (failure) {
    report({
      reason: failure.stage === 'package-cleanup'
        ? 'cleanup_failed'
        : 'stage_failed',
      stage: 'result',
      status: 'fail',
    })
    throw failure
  }
  report({ stage: 'result', status: 'pass' })
  return { status: 'pass' }
}

export function assertUniversalArchitectures(output) {
  const architectures = output.trim().split(/\s+/u).filter(Boolean).sort()
  if (
    architectures.length !== 2
    || architectures[0] !== 'arm64'
    || architectures[1] !== 'x86_64'
  ) {
    throw new FullFlowError('universal_artifact_required')
  }
}

export function selectPackageArtifacts(paths) {
  const apps = paths.filter(path => basename(path) === 'Qwen Audio Agent.app')
  const dmgs = paths.filter(path => path.endsWith('.dmg'))
  if (apps.length !== 1 || dmgs.length !== 1) {
    throw new FullFlowError('package_artifact_unproven')
  }
  return { appPath: apps[0], dmgPath: dmgs[0] }
}

export async function runFullFlowCommand({
  argv = process.argv.slice(2),
  environment = process.env,
  errorOutput = process.stderr,
  output = process.stdout,
} = {}) {
  let options
  try {
    options = parseFullFlowArguments(argv)
  } catch {
    errorOutput.write(
      'Usage: npm run native-input:test:full -- [--release-app "/Applications/Qwen Audio Agent.app"]\n',
    )
    writeEvent(output, {
      reason: 'invalid_arguments',
      stage: 'result',
      status: 'fail',
    })
    return 2
  }

  const npmCli = environment.npm_execpath
  if (typeof npmCli !== 'string' || !isAbsolute(npmCli)) {
    writeEvent(output, {
      reason: 'npm_cli_unproven',
      stage: 'result',
      status: 'fail',
    })
    return 1
  }

  const packageOutput = mkdtempSync(join(tmpdir(), 'qwen-native-full-flow-'))
  const packageOutputIdentity = pathIdentity(packageOutput)
  const childEnvironment = fullFlowEnvironment(environment)
  const stages = createFullFlowStages({
    npmCli,
    packageOutput,
    releaseApp: options.releaseApp,
    root: repositoryRoot,
  })

  try {
    await runFullFlowStages({
      stages,
      execute: stage => executeFullFlowStage(stage, {
        environment: childEnvironment,
        output: errorOutput,
      }),
      finalize: () => removeOwnedPackageOutput(
        packageOutput,
        packageOutputIdentity,
      ),
      report: event => writeEvent(output, event),
    })
    return 0
  } catch {
    return 1
  }
}

async function executeFullFlowStage(stage, { environment, output }) {
  if (stage.kind === 'native-artifact-verify') {
    await verifyNativeArtifacts(stage.cwd, { environment, output })
    return
  }
  if (stage.kind === 'desktop-package-verify') {
    await verifyDesktopPackage(stage.packageOutput, { environment, output })
    return
  }
  await executeProcess(stage.command, stage.args, {
    cwd: stage.cwd,
    environment,
    output,
  })
}

async function verifyNativeArtifacts(root, context) {
  const bridgePath = join(root, 'dist/native-input/QwenInputBridge')
  const inputMethodPath = join(root, 'dist/native-input/Qwen Input.app')
  const inputMethodExecutable = join(
    inputMethodPath,
    'Contents/MacOS/Qwen Input',
  )
  for (const path of [bridgePath, inputMethodExecutable]) {
    const result = await executeProcess(SYSTEM_TOOLS.lipo, ['-archs', path], {
      ...context,
      cwd: root,
      captureStdout: true,
    })
    assertUniversalArchitectures(result.stdout)
  }
  await executeProcess(SYSTEM_TOOLS.codesign, [
    '--verify', '--strict',
    '-R=identifier "ai.qwenaudio.agent.inputbridge"',
    bridgePath,
  ], { ...context, cwd: root })
  await executeProcess(SYSTEM_TOOLS.codesign, [
    '--verify', '--deep', '--strict',
    '-R=identifier "ai.qwenaudio.agent.inputmethod"',
    inputMethodPath,
  ], { ...context, cwd: root })
}

async function verifyDesktopPackage(packageOutput, context) {
  const artifacts = selectPackageArtifacts(listPackageArtifacts(packageOutput))
  const nativeDirectory = join(
    artifacts.appPath,
    'Contents/Resources/native-input',
  )
  const bridgePath = join(nativeDirectory, 'QwenInputBridge')
  const inputMethodPath = join(nativeDirectory, 'Qwen Input.app')
  const inputMethodExecutable = join(
    inputMethodPath,
    'Contents/MacOS/Qwen Input',
  )
  for (const path of [bridgePath, inputMethodExecutable]) {
    const result = await executeProcess(SYSTEM_TOOLS.lipo, ['-archs', path], {
      ...context,
      cwd: packageOutput,
      captureStdout: true,
    })
    assertUniversalArchitectures(result.stdout)
  }
  await executeProcess(SYSTEM_TOOLS.codesign, [
    '--verify', '--strict',
    '-R=identifier "ai.qwenaudio.agent.inputbridge"',
    bridgePath,
  ], { ...context, cwd: packageOutput })
  await executeProcess(SYSTEM_TOOLS.codesign, [
    '--verify', '--deep', '--strict',
    '-R=identifier "ai.qwenaudio.agent.inputmethod"',
    inputMethodPath,
  ], { ...context, cwd: packageOutput })
  await executeProcess(SYSTEM_TOOLS.codesign, [
    '--verify', '--deep', '--strict', artifacts.appPath,
  ], { ...context, cwd: packageOutput })
  await executeProcess(SYSTEM_TOOLS.hdiutil, ['verify', artifacts.dmgPath], {
    ...context,
    cwd: packageOutput,
  })
}

function executeProcess(command, args, {
  captureStdout = false,
  cwd,
  environment,
  output,
}) {
  if (!isAbsolute(command) || !isAbsolute(cwd)) {
    throw new FullFlowError('untrusted_execution_path')
  }
  return new Promise((resolveCompletion, rejectCompletion) => {
    let stdout = ''
    let settled = false
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (!captureStdout) output.write(chunk)
    })
    child.stderr.on('data', chunk => output.write(chunk))
    child.once('error', cause => {
      if (settled) return
      settled = true
      rejectCompletion(new FullFlowError('command_failed', { cause }))
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        rejectCompletion(new FullFlowError('command_failed', {
          cause: new Error(signal || String(code)),
        }))
        return
      }
      resolveCompletion({ stdout })
    })
  })
}

function listPackageArtifacts(directory) {
  const result = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === 'Qwen Audio Agent.app') {
          result.push(child)
        } else {
          visit(child)
        }
      } else if (entry.isFile() && entry.name.endsWith('.dmg')) {
        result.push(child)
      }
    }
  }
  visit(directory)
  return result
}

function pathIdentity(path) {
  const information = lstatSync(path)
  if (
    !information.isDirectory()
    || information.isSymbolicLink()
    || information.uid !== process.getuid()
  ) {
    throw new FullFlowError('package_output_unproven')
  }
  return { dev: information.dev, ino: information.ino }
}

function removeOwnedPackageOutput(path, expected) {
  const current = pathIdentity(path)
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new FullFlowError('package_output_changed')
  }
  rmSync(path, { force: true, recursive: true })
}

function writeEvent(output, event) {
  const value = event.status === 'fail'
    ? { reason: event.reason, stage: event.stage, status: event.status }
    : { stage: event.stage, status: event.status }
  output.write(`${JSON.stringify(value)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runFullFlowCommand()
}
