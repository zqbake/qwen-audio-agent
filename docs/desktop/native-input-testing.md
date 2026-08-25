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
  unchanged. A system-level installation probe or Developer ID/notarized
  artifact is the next explicit authorization/release gate.
- Cross-application InputMethodKit interaction: verified with fake transcript in
  TextEdit and Safari textarea/contenteditable/password controls. Terminal and
  the broader application matrix remain open.
- Physical-microphone and TCC interaction: not run.
- Optional Accessibility-based Voice Send: not implemented or authorized.
- Developer ID signing, notarization, and release Gatekeeper: not run.

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
