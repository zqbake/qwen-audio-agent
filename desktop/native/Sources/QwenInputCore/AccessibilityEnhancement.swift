import Foundation

public struct AccessibilityTextReplacement: Equatable, Sendable {
    public let expected: String
    public let replacement: String

    public init(expected: String, replacement: String) {
        self.expected = expected
        self.replacement = replacement
    }
}

public protocol AccessibilityTextClient: AnyObject {
    func replaceRecentText(expected: String, replacement: String) -> Bool
    func confirmFocusedElement() -> Bool
}

public struct AccessibilityOperationController: Sendable {
    public init() {}

    public func applyEdit(
        _ operation: OwnedTextEdit,
        to ledger: inout SessionLedger,
        generation: UInt64,
        targetID: UUID,
        enabled: Bool,
        client: AccessibilityTextClient,
        revalidate: () -> Bool
    ) -> Bool {
        guard enabled, revalidate() else { return false }
        var candidate = ledger
        guard case let .success(effect) = candidate.accessibilityEdit(
            operation,
            generation: generation,
            targetID: targetID
        ) else {
            return false
        }
        guard revalidate() else { return false }
        guard client.replaceRecentText(
            expected: effect.expected,
            replacement: effect.replacement
        ) else {
            return false
        }
        ledger = candidate
        return true
    }

    public func submit(
        enabled: Bool,
        client: AccessibilityTextClient,
        revalidate: () -> Bool
    ) -> Bool {
        guard enabled, revalidate(), revalidate() else { return false }
        return client.confirmFocusedElement()
    }
}
