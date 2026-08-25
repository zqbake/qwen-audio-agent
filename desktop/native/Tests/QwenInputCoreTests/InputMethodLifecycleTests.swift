import Foundation
import XCTest
@testable import QwenInputCore

final class InputMethodLifecycleTests: XCTestCase {
    func testInstallRegistersEnablesSelectsVerifiesThenCommitsHiddenPalette() throws {
        let fileSystem = FakeInputMethodFileSystem()
        let registration = FakeInputMethodRegistration()
        let embedded = URL(fileURLWithPath: "/Applications/Qwen.app/Contents/Resources/native-input/Qwen Input.app")
        let installed = URL(fileURLWithPath: "/Users/test/Library/Input Methods/Qwen Input.app")
        fileSystem.inspections[embedded.path] = .valid(owner: 501)

        let status = try makeLifecycle(
            fileSystem: fileSystem,
            registration: registration,
            embedded: embedded,
            installed: installed
        ).install()

        XCTAssertEqual(fileSystem.installCalls, [[embedded.path, installed.path]])
        XCTAssertEqual(fileSystem.commitCalls, [installed.path])
        XCTAssertEqual(registration.calls, [
            "contains", "register:\(installed.path)", "enable", "select",
            "contains", "enabled", "selected",
        ])
        XCTAssertEqual(status, InputMethodLifecycleStatus(
            installed: true,
            registered: true,
            enabled: true,
            selected: true,
            version: "1.11.0"
        ))
    }

    func testInstallRejectsUnsafeEmbeddedBundleBeforeMutation() {
        let invalid: [InputMethodArtifactInspection] = [
            .valid(owner: 0, symbolicLink: true),
            .valid(owner: 501, signatureValid: false),
            .valid(owner: 501, version: "0.9.0"),
            .valid(owner: 501, bundleID: "example.wrong.input"),
        ]
        for inspection in invalid {
            let fileSystem = FakeInputMethodFileSystem()
            let registration = FakeInputMethodRegistration()
            fileSystem.inspections["/embedded/Qwen Input.app"] = inspection
            let lifecycle = makeLifecycle(
                fileSystem: fileSystem,
                registration: registration
            )
            XCTAssertThrowsError(try lifecycle.install())
            XCTAssertTrue(fileSystem.installCalls.isEmpty)
            XCTAssertTrue(registration.calls.isEmpty)
        }
    }

    func testEnableSelectAndVerificationFailuresRollbackNewPalette() {
        let cases: [(FakeInputMethodRegistration) -> Void] = [
            { $0.registerResult = false },
            { $0.enableResult = false },
            { $0.selectResult = false },
            { $0.selectSetsSelected = false },
        ]
        for configure in cases {
            let fileSystem = FakeInputMethodFileSystem()
            let registration = FakeInputMethodRegistration()
            fileSystem.inspections["/embedded/Qwen Input.app"] = .valid(owner: 501)
            configure(registration)

            XCTAssertThrowsError(try makeLifecycle(
                fileSystem: fileSystem,
                registration: registration
            ).install())
            XCTAssertEqual(fileSystem.rollbackCalls, ["/installed/Qwen Input.app"])
            XCTAssertTrue(fileSystem.commitCalls.isEmpty)
            XCTAssertEqual(registration.calls.last, "disable")
        }
    }

    func testUpgradeFailureRollsBackBundleAndRestoresPreviousQwenPalette() {
        let fileSystem = FakeInputMethodFileSystem()
        let registration = FakeInputMethodRegistration()
        fileSystem.inspections["/embedded/Qwen Input.app"] = .valid(owner: 501)
        fileSystem.inspections["/installed/Qwen Input.app"] = .valid(owner: 501)
        registration.contains = true
        registration.enabled = true
        registration.selected = true
        registration.selectResult = false

        XCTAssertThrowsError(try makeLifecycle(
            fileSystem: fileSystem,
            registration: registration
        ).install())

        XCTAssertEqual(fileSystem.rollbackCalls, ["/installed/Qwen Input.app"])
        XCTAssertEqual(Array(registration.calls.suffix(4)), [
            "register:/installed/Qwen Input.app", "enable", "select", "disable",
        ])
        XCTAssertTrue(fileSystem.commitCalls.isEmpty)
    }

    func testStatusFailsClosedForUnsafeBundleAndReportsSelectedReadiness() throws {
        let fileSystem = FakeInputMethodFileSystem()
        let registration = FakeInputMethodRegistration()
        fileSystem.inspections["/installed/Qwen Input.app"] = .valid(
            owner: 999,
            symbolicLink: true
        )
        registration.contains = true
        registration.enabled = true
        registration.selected = true

        let status = try makeLifecycle(
            fileSystem: fileSystem,
            registration: registration
        ).status()
        XCTAssertEqual(status, InputMethodLifecycleStatus(
            installed: false,
            registered: false,
            enabled: false,
            selected: false,
            version: ""
        ))
        XCTAssertTrue(registration.calls.isEmpty)
    }

    func testUninstallDisablesOnlyQwenPaletteBeforeMovingBundleToTrash() throws {
        let fileSystem = FakeInputMethodFileSystem()
        let registration = FakeInputMethodRegistration()
        fileSystem.inspections["/installed/Qwen Input.app"] = .valid(owner: 501)
        registration.contains = true
        registration.enabled = true
        registration.selected = true

        let status = try makeLifecycle(
            fileSystem: fileSystem,
            registration: registration
        ).uninstall()

        XCTAssertEqual(registration.calls, ["contains", "disable"])
        XCTAssertEqual(fileSystem.trashCalls, ["/installed/Qwen Input.app"])
        XCTAssertEqual(status, InputMethodLifecycleStatus(
            installed: false,
            registered: false,
            enabled: false,
            selected: false,
            version: ""
        ))
    }

    private func makeLifecycle(
        fileSystem: FakeInputMethodFileSystem,
        registration: FakeInputMethodRegistration,
        embedded: URL = URL(fileURLWithPath: "/embedded/Qwen Input.app"),
        installed: URL = URL(fileURLWithPath: "/installed/Qwen Input.app")
    ) -> InputMethodLifecycle {
        InputMethodLifecycle(
            embeddedBundleURL: embedded,
            installedBundleURL: installed,
            expectedBundleID: "ai.qwenaudio.agent.inputmethod",
            expectedVersion: "1.11.0",
            currentUserID: 501,
            fileSystem: fileSystem,
            registration: registration
        )
    }
}

private final class FakeInputMethodFileSystem: InputMethodLifecycleFileSystem {
    var inspections: [String: InputMethodArtifactInspection] = [:]
    var installCalls: [[String]] = []
    var commitCalls: [String] = []
    var rollbackCalls: [String] = []
    var trashCalls: [String] = []

    func inspect(at url: URL) -> InputMethodArtifactInspection? {
        inspections[url.path]
    }

    func installAtomically(from source: URL, to destination: URL) throws {
        installCalls.append([source.path, destination.path])
        inspections[destination.path] = inspections[source.path]
    }

    func rollbackInstall(at destination: URL) throws {
        rollbackCalls.append(destination.path)
    }

    func commitInstall(at destination: URL) throws {
        commitCalls.append(destination.path)
    }

    func moveToTrash(_ url: URL) throws {
        trashCalls.append(url.path)
        inspections[url.path] = nil
    }
}

private final class FakeInputMethodRegistration: InputMethodRegistration {
    var contains = false
    var enabled = false
    var selected = false
    var registerResult = true
    var enableResult = true
    var selectResult = true
    var selectSetsSelected = true
    var disableResult = true
    var calls: [String] = []

    func containsInputSource() -> Bool {
        calls.append("contains")
        return contains
    }
    func isInputSourceEnabled() -> Bool {
        calls.append("enabled")
        return enabled
    }
    func isInputSourceSelected() -> Bool {
        calls.append("selected")
        return selected
    }
    func registerInputSource(at url: URL) -> Bool {
        calls.append("register:\(url.path)")
        if registerResult { contains = true }
        return registerResult
    }
    func enableInputSource() -> Bool {
        calls.append("enable")
        if enableResult { enabled = true }
        return enableResult
    }
    func selectInputSource() -> Bool {
        calls.append("select")
        if selectResult, selectSetsSelected { selected = true }
        return selectResult
    }
    func disableInputSource() -> Bool {
        calls.append("disable")
        if disableResult {
            enabled = false
            selected = false
            contains = false
        }
        return disableResult
    }
}

private extension InputMethodArtifactInspection {
    static func valid(
        owner: UInt32,
        symbolicLink: Bool = false,
        signatureValid: Bool = true,
        version: String = "1.11.0",
        bundleID: String = "ai.qwenaudio.agent.inputmethod"
    ) -> InputMethodArtifactInspection {
        InputMethodArtifactInspection(
            symbolicLink: symbolicLink,
            ownerUserID: owner,
            bundleID: bundleID,
            version: version,
            signatureValid: signatureValid
        )
    }
}
