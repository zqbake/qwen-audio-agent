import Foundation
import XCTest
@testable import QwenInputCore

final class InputSourceCoordinatorTests: XCTestCase {
    private final class FakeAPI: InputSourceAPI {
        var available: Set<String>
        var enabled: Set<String>
        var selected: Set<String>
        var calls: [String] = []

        init(
            available: Set<String>,
            enabled: Set<String>,
            selected: Set<String>
        ) {
            self.available = available
            self.enabled = enabled
            self.selected = selected
        }

        func containsInputSource(id: String) -> Bool {
            calls.append("find:\(id)")
            return available.contains(id)
        }

        func isInputSourceEnabled(id: String) -> Bool {
            calls.append("enabled:\(id)")
            return enabled.contains(id)
        }

        func isInputSourceSelected(id: String) -> Bool {
            calls.append("selected:\(id)")
            return selected.contains(id)
        }
    }

    private let qwenID = "ai.qwenaudio.agent.inputmethod"

    func testBeginOnlyReadsHiddenPaletteReadiness() {
        let api = FakeAPI(
            available: [qwenID],
            enabled: [qwenID],
            selected: [qwenID]
        )
        let coordinator = InputSourceCoordinator(
            qwenInputSourceID: qwenID,
            api: api
        )

        XCTAssertEqual(coordinator.begin(), .ready)
        XCTAssertEqual(api.calls, [
            "find:\(qwenID)",
            "enabled:\(qwenID)",
            "selected:\(qwenID)",
        ])
    }

    func testBeginFailsClosedForMissingDisabledOrUnselectedPalette() {
        let missing = FakeAPI(available: [], enabled: [], selected: [])
        XCTAssertEqual(
            InputSourceCoordinator(qwenInputSourceID: qwenID, api: missing).begin(),
            .qwenInputUnavailable
        )
        XCTAssertEqual(missing.calls, ["find:\(qwenID)"])

        let disabled = FakeAPI(
            available: [qwenID],
            enabled: [],
            selected: []
        )
        XCTAssertEqual(
            InputSourceCoordinator(qwenInputSourceID: qwenID, api: disabled).begin(),
            .qwenInputDisabled
        )
        XCTAssertEqual(disabled.calls, ["find:\(qwenID)", "enabled:\(qwenID)"])

        let unselected = FakeAPI(
            available: [qwenID],
            enabled: [qwenID],
            selected: []
        )
        XCTAssertEqual(
            InputSourceCoordinator(qwenInputSourceID: qwenID, api: unselected).begin(),
            .qwenInputNotSelected
        )
        XCTAssertEqual(unselected.calls, [
            "find:\(qwenID)",
            "enabled:\(qwenID)",
            "selected:\(qwenID)",
        ])
    }
}
