import {
  assertGate0Host,
  verifyReleaseArtifact,
} from '../../../scripts/lib/native-input-release-gate0.mjs'
import {
  gate0ChildEnvironment,
  runGate0Command,
} from '../../../scripts/native-input-release-gate0.mjs'

const clean = {
  backupBundleExists: false,
  enabled: false,
  inputMethodsDirectorySafe: true,
  keyboardId: 'com.apple.keylayout.ABC',
  qwenCount: 0,
  qwenProcessCount: 0,
  runtimeExists: false,
  selected: false,
  stagingBundleCount: 0,
  systemBundleExists: false,
  textEditRunning: false,
  trashRestored: true,
  trashReadable: true,
  userBundleExists: false,
}
const ready = {
  ...clean,
  enabled: true,
  qwenCount: 1,
  selected: true,
  userBundleExists: true,
}

function makeSystem(scenario) {
  const signal = async stage => {
    if (scenario !== `signal-${stage}`) return
    process.kill(process.pid, 'SIGTERM')
    await new Promise(resolve => setImmediate(resolve))
  }
  const system = {
    async assertSupportedHost() {
      if (scenario === 'alternate-home') {
        gate0ChildEnvironment(
          { HOME: '/Users/same-uid-alternate' },
          '/Users/canonical-account',
        )
      }
      if (scenario === 'root') {
        assertGate0Host({
          consoleUid: 0,
          euid: 0,
          groups: [0],
          homeUid: 0,
          platform: 'darwin',
        })
      }
      if (scenario === 'non-console') {
        assertGate0Host({
          consoleUid: 502,
          euid: 501,
          groups: [20, 501],
          homeUid: 501,
          platform: 'darwin',
        })
      }
    },
    async verifyReleaseArtifact() {
      if (scenario === 'release-path') {
        await verifyReleaseArtifact({
          appPath: '/not/a/real/Qwen Audio Agent.app',
          execute: async (command, args) => {
            const { execFile } = await import('node:child_process')
            return await new Promise((resolve, reject) => {
              execFile(command, args, error => error ? reject(error) : resolve({ output: '' }))
            })
          },
          exists: () => true,
        })
      }
    },
    async captureBaseline() { return { ...clean } },
    async install() {
      await signal('install')
    },
    async freshState() { await signal('fresh'); return { ...ready } },
    async exerciseTextEdit() {
      await signal('textedit')
      return {
        documentText: 'Qwen Gate 0 final',
        finalAccepted: true,
        partialAccepted: true,
      }
    },
    async cleanup() {
      await signal('cleanup')
      if (scenario === 'cleanup-failure') throw new Error('private cleanup detail')
    },
    async verifyCleanup() { return { ...clean } },
  }
  return system
}

const scenario = process.env.GATE0_PROCESS_SCENARIO || 'pass'
const exitCode = await runGate0Command({
  argv: ['--app', '/Applications/Qwen Audio Agent.app'],
  confirm: async () => true,
  systemFactory: () => makeSystem(scenario),
})
process.exitCode = exitCode
