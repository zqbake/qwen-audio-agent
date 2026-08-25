import Foundation
import XCTest
@testable import QwenInputCore

final class AccessibilityEnhancementTests: XCTestCase {
    private final class FakeClient: AccessibilityTextClient {
        enum Call: Equatable {
            case replace(expected: String, replacement: String)
            case confirm
        }

        var replaceResult = true
        var confirmResult = true
        private(set) var calls: [Call] = []

        func replaceRecentText(expected: String, replacement: String) -> Bool {
            calls.append(.replace(expected: expected, replacement: replacement))
            return replaceResult
        }

        func confirmFocusedElement() -> Bool {
            calls.append(.confirm)
            return confirmResult
        }
    }

    private let targetID = UUID()

    private func opaqueFinalLedger(text: String = "hello world") throws -> SessionLedger {
        var ledger = SessionLedger(
            sessionID: UUID(),
            generation: 3,
            targetID: targetID
        )
        _ = try ledger.final(
            text: text,
            selectedRange: NSRange(location: NSNotFound, length: 0),
            clientMarkedRange: NSRange(location: NSNotFound, length: 0),
            generation: 3,
            targetID: targetID
        ).get()
        return ledger
    }

    func testAccessibilityEditIsDefaultOffAndDoesNotTouchTheClient() throws {
        var ledger = try opaqueFinalLedger()
        let before = ledger.latestOwnedFinalText
        let client = FakeClient()

        XCTAssertFalse(AccessibilityOperationController().applyEdit(
            .replace(target: "world", replacement: "earth"),
            to: &ledger,
            generation: 3,
            targetID: targetID,
            enabled: false,
            client: client,
            revalidate: { true }
        ))
        XCTAssertEqual(ledger.latestOwnedFinalText, before)
        XCTAssertTrue(client.calls.isEmpty)
    }

    func testAccessibilityEditCommitsLedgerOnlyAfterExactClientReplacement() throws {
        var ledger = try opaqueFinalLedger()
        let client = FakeClient()

        XCTAssertTrue(AccessibilityOperationController().applyEdit(
            .replace(target: "world", replacement: "earth"),
            to: &ledger,
            generation: 3,
            targetID: targetID,
            enabled: true,
            client: client,
            revalidate: { true }
        ))
        XCTAssertEqual(client.calls, [
            .replace(expected: "hello world", replacement: "hello earth"),
        ])
        XCTAssertEqual(ledger.latestOwnedFinalText, "hello earth")
        XCTAssertEqual(
            ledger.latestOwnedFinalRange,
            NSRange(location: NSNotFound, length: 11)
        )

        client.replaceResult = false
        let before = ledger.latestOwnedFinalText
        XCTAssertFalse(AccessibilityOperationController().applyEdit(
            .delete(target: "hello "),
            to: &ledger,
            generation: 3,
            targetID: targetID,
            enabled: true,
            client: client,
            revalidate: { true }
        ))
        XCTAssertEqual(ledger.latestOwnedFinalText, before)
    }

    func testAccessibilityEditRevalidatesBeforeMutation() throws {
        var ledger = try opaqueFinalLedger()
        let client = FakeClient()
        var checks = 0

        XCTAssertFalse(AccessibilityOperationController().applyEdit(
            .delete(target: "world"),
            to: &ledger,
            generation: 3,
            targetID: targetID,
            enabled: true,
            client: client,
            revalidate: {
                checks += 1
                return checks == 1
            }
        ))
        XCTAssertEqual(checks, 2)
        XCTAssertTrue(client.calls.isEmpty)
        XCTAssertEqual(ledger.latestOwnedFinalText, "hello world")
    }

    func testVoiceSendRequiresExplicitEnablementAndSuccessfulConfirmAction() {
        let client = FakeClient()
        let controller = AccessibilityOperationController()

        XCTAssertFalse(controller.submit(
            enabled: false,
            client: client,
            revalidate: { true }
        ))
        XCTAssertTrue(client.calls.isEmpty)

        XCTAssertTrue(controller.submit(
            enabled: true,
            client: client,
            revalidate: { true }
        ))
        XCTAssertEqual(client.calls, [.confirm])

        client.confirmResult = false
        XCTAssertFalse(controller.submit(
            enabled: true,
            client: client,
            revalidate: { true }
        ))
    }
}
