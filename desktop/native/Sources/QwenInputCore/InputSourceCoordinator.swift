import Foundation

/// Read-only session gate for the hidden Qwen palette. Installation and repair
/// own all TIS mutations; an active session never reads or changes the user's
/// ordinary keyboard input source.
public protocol InputSourceAPI: AnyObject {
    func containsInputSource(id: String) -> Bool
    func isInputSourceEnabled(id: String) -> Bool
    func isInputSourceSelected(id: String) -> Bool
}

public enum InputSourceBeginResult: Equatable, Sendable {
    case ready
    case qwenInputUnavailable
    case qwenInputDisabled
    case qwenInputNotSelected
}

public struct InputSourceCoordinator {
    private let qwenInputSourceID: String
    private let api: InputSourceAPI

    public init(qwenInputSourceID: String, api: InputSourceAPI) {
        self.qwenInputSourceID = qwenInputSourceID
        self.api = api
    }

    public func begin() -> InputSourceBeginResult {
        guard api.containsInputSource(id: qwenInputSourceID) else {
            return .qwenInputUnavailable
        }
        guard api.isInputSourceEnabled(id: qwenInputSourceID) else {
            return .qwenInputDisabled
        }
        guard api.isInputSourceSelected(id: qwenInputSourceID) else {
            return .qwenInputNotSelected
        }
        return .ready
    }
}
