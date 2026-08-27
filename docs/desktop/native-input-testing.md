# Desktop native input testing

This document separates automated native-input evidence from installed-app
claims. The feature is part of Qwen Audio Agent Desktop, but its InputMethodKit
bundle changes macOS input-source state when installed. Do not perform the
manual matrix without explicit authorization from the machine owner.

## Current status

- Phase 0 automated substrate: implemented and locally verified.
- Desktop lifecycle and IME→Bridge→Gateway automated chain: implemented and
  locally verified with injected filesystem/input-source adapters, fake
  transcript, and a real ad-hoc-signed IME/Bridge peer exchange.
- Hidden-palette user-level install/repair registration, enablement, selection,
  verification, and rollback: automated. On the current macOS 26.5.1 arm64
  machine, the per-user Debug/ad-hoc and Apple Development-signed probes both
  returned success from register/enable but remained disabled; select returned
  `paramErr` (`-50`). The transaction rolled back and left the keyboard source
  unchanged. A historical system-level copy reached the macOS `SecurityAgent`
  prompt and was cancelled before credentials were entered. That path is now
  deferred: the next and blocking gate is the Developer ID/notarized per-user
  release probe below.
- Cross-application InputMethodKit interaction: verified with fake transcript in
  TextEdit and Safari textarea/contenteditable/password controls. Terminal and
  the broader application matrix remain open.
- Physical-microphone and TCC interaction: not run.
- Optional Accessibility-based Voice Send: not implemented or authorized.
- Developer ID signing, notarization, and release Gatekeeper: not run.

The blocking next step is the repeatable per-user release Gate 0 below. The
system-level probe is deferred and must not be used to skip Gate 0.

The verified installed path is still not release evidence. Physical microphone,
real provider, Terminal, broader target applications, Developer ID signing,
and notarization remain later gates. Automated lifecycle tests do not copy,
register, enable, or select an input source.

Qwen Input is a `ComponentInvisibleInSystemUI` palette. After the explicit
Install/Repair confirmation, Desktop uses public TIS APIs once to register,
enable, select, and verify that palette. It has no ordinary input-menu item and
coexists with the current keyboard source. Sessions only read palette readiness
and never select or restore ABC, Pinyin, or another keyboard layout.

## Automated Phase 0 gate

Run on macOS from the repository root:

```sh
npm run native-input:test
node --test desktop/test/native-input-*.test.mjs
npm test
npm run lint
npm run build
npm run test:desktop-smoke
git diff --check
```

The native tests cover:

- protocol version, sequence, generation, target, replay, and 64 KiB limits;
- UTF-16 owned marked/final ranges, including emoji and composed characters;
- deterministic replace/delete limited to the latest session-owned final;
- Secure Event Input and visible-status fail-closed decisions;
- InputMethodKit client calls and non-consumption of physical key events;
- exact peer identity, same-user checks, a 0700 runtime directory, and a 0600
  Unix-domain socket;
- read-only hidden-palette readiness with no per-session keyboard mutation;
- Desktop-owned Bridge startup, scrubbed environment, emergency stop, and
  bounded shutdown;
- a real built Bridge process handling fake partial/final/pause/resume/cancel,
  rejecting malformed frames, exiting on EOF, and leaving no runtime files.
- explicit status/install/repair/uninstall request correlation, symlink/owner/
  signature/version rejection, atomic replacement rollback, ordered public-TIS
  register/enable/select/verify, and Qwen-only disable-before-trash uninstall;
- a real signed IME peer registering one target, polling one correlated
  operation through Bridge, returning an operation result, and cleaning the
  temporary socket; renderer tests prove ownership/suspend gates, empty-draft
  Gateway start, terminal late-event rejection, and native failure cancellation.

The packaging gate additionally requires:

```sh
npm run native-input:build:release
lipo -archs dist/native-input/QwenInputBridge
lipo -archs "dist/native-input/Qwen Input.app/Contents/MacOS/Qwen Input"
codesign --verify --strict \
  -R='identifier "ai.qwenaudio.agent.inputbridge"' \
  dist/native-input/QwenInputBridge
codesign --verify --deep --strict \
  -R='identifier "ai.qwenaudio.agent.inputmethod"' \
  "dist/native-input/Qwen Input.app"
```

Both native artifacts must contain `arm64` and `x86_64`. Local builds are
ad-hoc signed and are only build/integrity evidence; they are not notarized
release evidence.

## Blocking per-user release Gate 0

**Current status: BLOCKED ON RELEASE ENVIRONMENT.** The hardened runner is ready
for the formal probe, but do not execute the installing/TIS/TextEdit phases
until a real Developer ID, notarized, stapled release app is available on a
clean standard-user machine. Local unit/process tests validate the runner only;
they are not Gate 0 evidence and must not be used to select a privileged
lifecycle.

Run this probe only on a clean macOS **standard-user** test account with a
finished Qwen Audio Agent app already copied to `/Applications`. The app, its
Bridge, and its nested input method must all be signed by one Developer ID
Application identity with hardened runtime. The app must carry a valid stapled
notarization ticket and pass Gatekeeper. Ad-hoc and Apple Development signatures
are rejected before any OS state changes.

The probe intentionally accepts no provider key and no non-interactive approval
flag:

```sh
git rev-parse HEAD
npm ci
npm --silent run native-input:gate0:release -- \
  --app "/Applications/Qwen Audio Agent.app"
```

The one interactive prompt is written to stderr so stdout remains fixed NDJSON.
It explains that macOS may show input-method consent as part of first setup.
Type `RUN` only when you are ready to complete any
macOS-owned dialog yourself. The probe never clicks a dialog, invokes a private
TIS API, uses Accessibility/CGEvent/AppleScript, requests TCC, or reads a
provider credential.

The command is a single fail-closed stage machine:

1. use absolute Apple tool paths, derive every user path and the Bridge `HOME`
   from the system account database, reject an alternate caller `HOME`, omit
   caller `PATH` and unrelated environment values from the Bridge, and verify
   macOS, enabled Gatekeeper assessments, an interactive non-root/non-admin
   console user whose canonical home has the same UID,
   a release tree not owned/writable by the test user, exact Developer ID
   identities, hardened runtime, deep code signatures,
   notarization staple, `spctl`, and `syspolicy_check distribution` when the
   installed SDK supplies it;
2. capture a clean baseline: no user/system Qwen bundle, lifecycle backup or
   staging path, Qwen TIS source, Qwen process/socket, or running TextEdit;
   require the user's Input Methods directory to be safe and Trash to be
   owned/readable; save the exact ordinary keyboard source ID and Trash entry
   identities;
3. use the release Bridge lifecycle to copy only the embedded input method to
   `~/Library/Input Methods`, then run public TIS
   `register → enable → select`;
4. use a fresh public-TIS process to require exactly one registered, enabled,
   selected hidden palette while the ordinary keyboard ID remains byte-for-byte
   unchanged;
5. open one probe-owned plain-text document and retain the uniquely identified
   new TextEdit PID only for run-owned cleanup. For text targeting, use the
   Soink-aligned model: trust the macOS IMK client handoff, require an observable
   focus transition into the test client and no observable focus change across
   arm/partial/final, pin every partial/final/cancel to the returned
   session/generation/target capability, and require final document bytes to
   equal the fixed final text. App PID/document ownership is not a P0 target
   proof and is not inferred from the final byte check;
6. after every mutated stage, enter one serial bounded cleanup exit. A timed-out
   action is actively cancelled and its child/Bridge request is confirmed
   settled before the next action or final verification. Cleanup attempts every
   action even after a prior error, then unconditionally performs a fresh
   verification. It cancels the pinned session, uninstalls through the
   owned Bridge, disables only Qwen, terminates only the recorded TextEdit PID,
   removes only paths whose device/inode still matches this run, and accepts a
   trashed bundle only when its device/inode matches the installed bundle. It
   never uses global `pkill`, deletes a runtime directory by name, or repairs an
   ordinary-keyboard change; any such residue/change makes cleanup incomplete.

Output is newline-delimited JSON containing only fixed `stage`, `status`, and
`reason` codes, with exactly one terminal `result` event. Tool stderr, paths,
signing subjects, fake text, environment, and protocol contents are never
emitted. A failed cleanup is always the terminal `cleanup_incomplete` result.
`SIGINT`/`SIGTERM` only set the abort state: later mutation is rejected and the
same awaited cleanup/fresh-verification path finishes before exit 130/143.

Gate 0 passes only if release verification, the hidden-palette fresh state,
ordinary-keyboard invariant, real TextEdit partial/final, and final cleanup all
pass in the same run. A local Debug/ad-hoc or Apple Development result can never
pass this gate. If Gate 0 passes, stop: a privileged/system lifecycle is not
needed. If it fails, retain the fixed stage result and cleanup evidence; do not
introduce a root helper until that first-hand release failure is reviewed.

This P0 deliberately follows macOS IMK client handoff rather than claiming an
application-level PID/control ownership proof. Session/generation/target,
secure/status gates, and observable focus-change rejection remain mandatory,
but this mode does not claim provable zero-miswrite under every unobservable OS
client race.

## Deferred cross-machine system-level palette probe

This is a reversible OS-feasibility probe, not the Desktop Install/Repair
transaction: the current product lifecycle still installs under
`~/Library/Input Methods`. Use a clean test account or machine. Do not run the
probe when a Qwen input source or either Qwen bundle path already exists,
because cleanup must remove only artifacts created by this run.

This section is retained as historical recovery evidence only. **Do not execute
it before the per-user release Gate 0 above has failed with a Developer ID,
notarized build and the failure has been reviewed.** It is not permission to add
`SMAppService`, a root helper, password handling, or automated authorization.

Clone the independent delivery branch and build without any provider key:

```sh
git clone --branch zq-77-cross-machine-test-20260826 --single-branch \
  https://github.com/zqbake/qwen-audio-agent.git qwen-audio-agent-zq77
cd qwen-audio-agent-zq77
git rev-parse HEAD
npm ci
npm run native-input:test
npm test
npm run lint
npm run build
npm run native-input:build:release
lipo -archs dist/native-input/QwenInputBridge
lipo -archs "dist/native-input/Qwen Input.app/Contents/MacOS/Qwen Input"
codesign --verify --strict \
  -R='identifier "ai.qwenaudio.agent.inputbridge"' \
  dist/native-input/QwenInputBridge
codesign --verify --deep --strict \
  -R='identifier "ai.qwenaudio.agent.inputmethod"' \
  "dist/native-input/Qwen Input.app"
```

Record the ordinary keyboard and prove the probe owns no pre-existing Qwen
state. Keep this shell open through cleanup; `BASELINE_KEYBOARD` is
non-sensitive, process-local state.

```sh
QWEN_SOURCE_ID=ai.qwenaudio.agent.inputmethod
SYSTEM_QWEN_BUNDLE='/Library/Input Methods/Qwen Input.app'
BUILT_QWEN_BUNDLE="$PWD/dist/native-input/Qwen Input.app"
BASELINE_KEYBOARD="$(swift -e '
import Carbon.HIToolbox
let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)!
print(Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue())
')"
RUNTIME_DIR="$(swift -e '
import Darwin
import Foundation
print(FileManager.default.temporaryDirectory
  .appendingPathComponent("qwen-ni-\(geteuid())").path)
')"
export QWEN_SOURCE_ID SYSTEM_QWEN_BUNDLE BUILT_QWEN_BUNDLE
export BASELINE_KEYBOARD RUNTIME_DIR
printf 'baseline.keyboard=%s\n' "$BASELINE_KEYBOARD"
test ! -e "$SYSTEM_QWEN_BUNDLE"
test ! -e "$HOME/Library/Input Methods/Qwen Input.app"
test "$(swift -e '
import Carbon.HIToolbox
let key = kTISPropertyInputSourceID!
let filter = [key as String: CommandLine.arguments[1]] as CFDictionary
let values = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
let list = values.map { $0 as NSArray } ?? NSArray()
print(list.count)
' "$QWEN_SOURCE_ID")" = 0
```

Open the two Finder locations. Manually copy only `Qwen Input.app` into the
system folder and personally complete the administrator `SecurityAgent`
prompt. Do not put a password in Terminal, shell history, a file, or automation.
Stop if macOS asks for Microphone, Accessibility, Input Monitoring, Full Disk
Access, or any permission other than this one file copy.

```sh
open -R "$BUILT_QWEN_BUNDLE"
open '/Library/Input Methods'
```

After the Finder copy finishes, verify the exact installed artifact, then run
each public TIS stage in a separate process. Every mutation must print `0`;
any other value stops the probe and goes directly to cleanup.

```sh
test -d "$SYSTEM_QWEN_BUNDLE"
codesign --verify --deep --strict "$SYSTEM_QWEN_BUNDLE"

swift -e '
import Carbon.HIToolbox
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
print("register=\(TISRegisterInputSource(url as CFURL))")
' "$SYSTEM_QWEN_BUNDLE"

swift -e '
import Carbon.HIToolbox
import Darwin
func source(_ id: String) -> TISInputSource? {
  let key = kTISPropertyInputSourceID!
  let filter = [key as String: id] as CFDictionary
  guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
  else { return nil }
  let values = list as NSArray
  guard let value = values.firstObject else { return nil }
  return unsafeBitCast(value as AnyObject, to: TISInputSource.self)
}
guard let value = source(CommandLine.arguments[1]) else {
  print("enable=missing"); exit(2)
}
print("enable=\(TISEnableInputSource(value))")
' "$QWEN_SOURCE_ID"

swift -e '
import Carbon.HIToolbox
import Darwin
func source(_ id: String) -> TISInputSource? {
  let key = kTISPropertyInputSourceID!
  let filter = [key as String: id] as CFDictionary
  guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
  else { return nil }
  let values = list as NSArray
  guard let value = values.firstObject else { return nil }
  return unsafeBitCast(value as AnyObject, to: TISInputSource.self)
}
guard let value = source(CommandLine.arguments[1]) else {
  print("select=missing"); exit(2)
}
print("select=\(TISSelectInputSource(value))")
' "$QWEN_SOURCE_ID"

swift -e '
import Carbon.HIToolbox
func property(_ source: TISInputSource, _ key: CFString) -> CFTypeRef? {
  guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
  return Unmanaged<CFTypeRef>.fromOpaque(pointer).takeUnretainedValue()
}
let key = kTISPropertyInputSourceID!
let filter = [key as String: CommandLine.arguments[1]] as CFDictionary
let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
let values = list.map { $0 as NSArray } ?? NSArray()
print("fresh.count=\(values.count)")
if let raw = values.firstObject {
  let source = unsafeBitCast(raw as AnyObject, to: TISInputSource.self)
  print("fresh.enabled=\((property(source, kTISPropertyInputSourceIsEnabled!) as? Bool) ?? false)")
  print("fresh.selected=\((property(source, kTISPropertyInputSourceIsSelected!) as? Bool) ?? false)")
}
let keyboard = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
print("fresh.keyboard=\((property(keyboard, key) as? String) ?? "<unknown>")")
' "$QWEN_SOURCE_ID"
```

The pass condition is exactly `fresh.count=1`, `fresh.enabled=true`,
`fresh.selected=true`, and `fresh.keyboard` equal to
`$BASELINE_KEYBOARD`. Do not continue into TextEdit/Safari, Accessibility,
Microphone, or a live provider as part of this probe.

Always roll back, including after a failed stage. First disable only Qwen:

```sh
swift -e '
import Carbon.HIToolbox
let key = kTISPropertyInputSourceID!
let filter = [key as String: CommandLine.arguments[1]] as CFDictionary
let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
let values = list.map { $0 as NSArray } ?? NSArray()
if let raw = values.firstObject {
  let source = unsafeBitCast(raw as AnyObject, to: TISInputSource.self)
  print("disable=\(TISDisableInputSource(source))")
} else {
  print("disable=not-present")
}
' "$QWEN_SOURCE_ID"
open '/Library/Input Methods'
```

In Finder, move only the system-level `Qwen Input.app` to Trash and personally
complete the administrator prompt. Then permanently delete only that probe
bundle from Trash (not the whole Trash). Restore the exact ordinary keyboard,
stop only Qwen processes, and remove only the current user's validated runtime
directory:

```sh
test ! -e "$SYSTEM_QWEN_BUNDLE"
swift -e '
import Carbon.HIToolbox
import Darwin
let key = kTISPropertyInputSourceID!
let filter = [key as String: CommandLine.arguments[1]] as CFDictionary
guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
else { print("restore=missing"); exit(2) }
let values = list as NSArray
guard let raw = values.firstObject else { print("restore=missing"); exit(2) }
let source = unsafeBitCast(raw as AnyObject, to: TISInputSource.self)
print("restore=\(TISSelectInputSource(source))")
' "$BASELINE_KEYBOARD"
pkill -TERM -x 'Qwen Input' 2>/dev/null || true
pkill -TERM -x QwenInputBridge 2>/dev/null || true
if [ -d "$RUNTIME_DIR" ]; then
  test "$(stat -f %u "$RUNTIME_DIR")" = "$(id -u)"
  test "$(stat -f %Lp "$RUNTIME_DIR")" = 700
  rm -rf -- "$RUNTIME_DIR"
fi
```

Finish with fresh, read-only evidence. The expected output is the original
keyboard ID, `qwen.count=0`, no bundle paths, no Qwen processes, and no
runtime directory:

```sh
swift -e '
import Carbon.HIToolbox
func id(_ source: TISInputSource) -> String {
  let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID!)!
  return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
}
let keyboard = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
let key = kTISPropertyInputSourceID!
let filter = [key as String: CommandLine.arguments[1]] as CFDictionary
let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
let values = list.map { $0 as NSArray } ?? NSArray()
print("final.keyboard=\(id(keyboard))")
print("qwen.count=\(values.count)")
' "$QWEN_SOURCE_ID"
test "$(swift -e '
import Carbon.HIToolbox
let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID!)!
print(Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue())
')" = "$BASELINE_KEYBOARD"
test ! -e "$SYSTEM_QWEN_BUNDLE"
test ! -e "$HOME/Library/Input Methods/Qwen Input.app"
test ! -e "$RUNTIME_DIR"
! pgrep -x 'Qwen Input'
! pgrep -x QwenInputBridge
```

## Authorization boundary

Before manual testing, obtain explicit approval for all of the following:

1. Copy the version-matched bundle to `~/Library/Input Methods`.
2. Allow the explicit Install/Repair action to register, enable, and select the
   hidden Qwen palette using public TIS APIs.
3. If macOS presents an input-method security prompt, stop before the final
   Allow action and obtain action-time confirmation.
4. Launch the packaged Desktop app and request Microphone permission.
5. If Voice Send is being tested separately, request Accessibility permission.

The base dictation path must not request Accessibility, Input Monitoring, Full
Disk Access, or administrator credentials. Use only non-sensitive test phrases.

## Installed-app manual matrix

Results below were recorded on macOS 26.5.1 arm64 with version 1.11.0
Debug/ad-hoc artifacts and non-sensitive fake transcript. Release-signing and
unlisted rows remain unverified.

| Area | Scenario and expected result | Status |
| --- | --- | --- |
| Install | User-level install rejects symlinks/wrong owner or signature; no admin prompt | PASS (Debug/ad-hoc) |
| Hidden palette | Explicit Install/Repair produces registered + enabled + selected while the ordinary keyboard source ID remains unchanged | BLOCKED: per-user local signatures remain disabled; system-level or release-signed gate required |
| TextEdit / Notes | Partial is marked; final is committed at the caret; physical typing is preserved | PASS (TextEdit) |
| Safari textarea | Partial/final/edit remain on one locked target | PASS |
| Safari contenteditable | UTF-16 range and caret movement behave deterministically | PASS |
| Safari password | Secure field blocks start and performs no write or capture | PASS |
| Terminal | Ordinary prompt accepts text; keyboard input is never swallowed | NOT RUN |
| Terminal secure input | Secure Keyboard Entry blocks or stops the session immediately | NOT RUN |
| VS Code / Monaco | Marked/final behavior is compatible or fails visibly without misdirected text | NOT RUN |
| Mail / Messages | Existing draft and selection are preserved | NOT RUN |
| Unsupported control | Unknown/custom-drawn control fails closed | NOT RUN |
| Focus switch | Target generation changes; partial is removed and no text enters the new focus | PASS |
| Keyboard/pointer interruption | Owned partial settles/removes deterministically and capture pauses | NOT RUN |
| Keyboard source | ABC/Pinyin/other ordinary keyboard selection remains unchanged throughout install and sessions | NOT RUN after lifecycle change |
| Bridge/Desktop crash | Capture stops, owned partial is removed, and no orphan process/socket remains; a replacement Bridge reconnects | PASS (Bridge SIGTERM) |
| Microphone denied/revoked | Visible failure, zero provider audio, conversation, or Memory side effect | NOT RUN |
| Network/provider failure | Returns to ordinary typing; never falls back to main Realtime | NOT RUN |
| Continuous/pause/cancel | Paused bytes remain zero; cancel leaves no uncommitted side effect | NOT RUN |
| Memory correction | Exact non-sensitive fact replacement only; metadata audit only | NOT RUN |
| Update/rollback | Active session drains, ordinary keyboard stays user-owned, versions match, Qwen-only rollback remains usable | Automated transaction PASS; release update not run |
| Disable/uninstall | Source is disabled, bundle moved to Trash, runtime artifacts removed | PASS (Debug/ad-hoc lifecycle) |
| Orphan repair | Input method is inert without authenticated Desktop/Bridge and can be repaired | NOT RUN |
| Architectures | arm64 and x86_64/Rosetta behavior is verified | Universal binaries verified; arm64 runtime only |

## Cleanup evidence

After an authorized run, verify that the hidden Qwen palette is disabled and
removed while the ordinary keyboard source ID is unchanged, the Bridge and Desktop test processes have
exited, no runtime socket remains, and any test installation/profile/audio has
been removed. Scan repositories, runtime directories, and test logs for
credential patterns without printing credential values.
