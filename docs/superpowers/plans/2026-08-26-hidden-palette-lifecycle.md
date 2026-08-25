## ZQ-77 hidden palette lifecycle plan

**Goal:** Replace the visible/manual Qwen input-source workflow with a hidden InputMethodKit palette that is registered, enabled, selected, and verified during install/repair without changing the user's ordinary keyboard source.

**Constraints:** Local commits only; no push or PR mutation. Public TIS APIs only. No AppleScript, private TIS APIs, CGEvent fallback, credentials on disk, or permission bypass. Any macOS security Allow action requires action-time confirmation.

### 1. Lock the lifecycle contract with failing tests

- Add `ComponentInvisibleInSystemUI=true` assertions for source and built input-method metadata.
- Extend lifecycle tests to require register → enable → select → verify, and cover enable/select/verification rollback.
- Cover upgrade rollback and uninstall changing only the Qwen palette.
- Change coordinator and Bridge tests to require read-only hidden-palette readiness with no keyboard select/restore calls.
- Change Desktop lifecycle/settings tests so readiness requires `selected`, incomplete state routes to repair, and no manual input-source-settings control remains.

### 2. Implement the hidden palette lifecycle

- Add the hidden palette metadata to the source plist and Xcode project.
- Extend the public Carbon adapter with Qwen-only enable/select/selected queries.
- Make install/repair register, enable, select, verify, and commit atomically; on failure roll back the bundle and Qwen palette state without touching ordinary keyboard sources.
- Make uninstall disable/remove only the Qwen palette.

### 3. Remove session-level keyboard switching

- Make the Bridge coordinator verify registered/enabled/selected state without selecting or recording a previous keyboard.
- Remove all session cancel/error/emergency restoration behavior.
- Preserve existing target-generation, secure-input, opaque-range, and zero-persistence fail-closed semantics.

### 4. Update Desktop status and operator guidance

- Include `selected` in native lifecycle status and JS normalization.
- Replace manual selection/settings UI with install/repair/readiness text for the hidden palette.
- Update active English and Chinese test/configuration docs and deterministic smoke fixtures.

### 5. Verify and commit locally

- Run focused native and Node tests, then native full tests, `npm test`, lint, build, diff check, universal native build, package/codesign/DMG smoke gates.
- Record a local commit without pushing.

### 6. Run the authorized real-machine gate

- Use Computer Use (`@oai/sky`) to install/repair and inspect lifecycle state.
- Stop before any macOS security Allow click for confirmation.
- After authorization, verify hidden palette state plus unchanged ordinary keyboard source, then TextEdit/Safari fake B matrix, secure/focus negatives, C, and minimal live provider in that order.
- Restore and clean the test installation, processes, sockets, and temporary data; report any remaining blocker precisely.
