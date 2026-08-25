import Foundation

public protocol NativeTextClient: AnyObject {
    var selectedRange: NSRange { get }
    var markedRange: NSRange { get }

    func setMarkedText(
        _ text: NSAttributedString,
        selectionRange: NSRange,
        replacementRange: NSRange
    )

    func insertText(_ text: Any, replacementRange: NSRange)
}

public enum TextClientError: Error, Equatable, Sendable {
    case unknownSelectedRange
    case markedRangeMismatch
    case invalidSelectionRange
}

public struct TextClientAdapter: Sendable {
    public init() {}

    @discardableResult
    public func apply(
        _ effect: ClientTextEffect,
        to client: NativeTextClient
    ) -> Result<Bool, TextClientError> {
        switch effect {
        case let .setMarked(text, selection, replacement):
            guard isValidSelection(selection, in: text) else {
                return .failure(.invalidSelectionRange)
            }
            let effectiveReplacement: NSRange
            if replacement.location == NSNotFound {
                if client.markedRange.location == NSNotFound {
                    if client.selectedRange.location == NSNotFound {
                        guard replacement.length == NSNotFound else {
                            return .failure(.unknownSelectedRange)
                        }
                        effectiveReplacement = currentCaretRange
                    } else {
                        effectiveReplacement = replacement
                    }
                } else if client.markedRange.length == 0 {
                    effectiveReplacement = client.markedRange
                } else {
                    return .failure(.markedRangeMismatch)
                }
            } else if client.markedRange != replacement {
                return .failure(.markedRangeMismatch)
            } else {
                effectiveReplacement = replacement
            }
            client.setMarkedText(
                NSAttributedString(string: text),
                selectionRange: selection,
                replacementRange: effectiveReplacement
            )
            return .success(true)

        case let .commitMarked(text, replacement):
            let currentMarkedRange = client.markedRange
            let effectiveReplacement: NSRange
            if replacement.location == NSNotFound,
               replacement.length == NSNotFound,
               currentMarkedRange.location == NSNotFound {
                effectiveReplacement = currentCaretRange
            } else if replacement.location != NSNotFound,
                      currentMarkedRange.location != NSNotFound,
                      currentMarkedRange == replacement {
                effectiveReplacement = replacement
            } else {
                return .failure(.markedRangeMismatch)
            }
            client.insertText(text, replacementRange: effectiveReplacement)
            return .success(true)

        case let .commitSelection(text, expectedSelection):
            let currentMarkedRange = client.markedRange
            let currentSelection = client.selectedRange
            guard currentMarkedRange.location == NSNotFound else {
                return .failure(.markedRangeMismatch)
            }
            let matchesCurrentCaret = expectedSelection.location == NSNotFound
                && expectedSelection.length == NSNotFound
                && currentSelection.location == NSNotFound
            let matchesKnownSelection = expectedSelection.location != NSNotFound
                && currentSelection.location != NSNotFound
                && currentSelection == expectedSelection
            guard matchesCurrentCaret || matchesKnownSelection else {
                return .failure(.unknownSelectedRange)
            }
            client.insertText(
                text,
                replacementRange: NSRange(
                    location: NSNotFound,
                    length: NSNotFound
                )
            )
            return .success(true)

        case let .insert(text, replacement):
            if replacement.location == NSNotFound,
               client.markedRange.location == NSNotFound,
               client.selectedRange.location == NSNotFound {
                return .failure(.unknownSelectedRange)
            }
            if replacement.location != NSNotFound,
               client.markedRange.location != NSNotFound,
                      client.markedRange != replacement {
                return .failure(.markedRangeMismatch)
            }
            client.insertText(text, replacementRange: replacement)
            return .success(true)

        case let .removeMarked(replacement):
            let currentMarkedRange = client.markedRange
            let effectiveReplacement: NSRange
            if replacement.location == NSNotFound,
               replacement.length == NSNotFound,
               currentMarkedRange.location == NSNotFound {
                effectiveReplacement = currentCaretRange
            } else if replacement.location != NSNotFound,
                      currentMarkedRange == replacement {
                effectiveReplacement = replacement
            } else {
                return .failure(.markedRangeMismatch)
            }
            client.setMarkedText(
                NSAttributedString(string: ""),
                selectionRange: NSRange(location: 0, length: 0),
                replacementRange: effectiveReplacement
            )
            client.insertText(
                "",
                replacementRange: NSRange(
                    location: NSNotFound,
                    length: NSNotFound
                )
            )
            return .success(true)

        case .none:
            return .success(false)
        }
    }

    private func isValidSelection(_ selection: NSRange, in text: String) -> Bool {
        guard selection.location != NSNotFound else { return false }
        let length = (text as NSString).length
        return selection.location <= length
            && selection.length <= length - selection.location
    }

    private var currentCaretRange: NSRange {
        NSRange(location: NSNotFound, length: NSNotFound)
    }
}

public struct ClientTextOperationController: Sendable {
    private let adapter = TextClientAdapter()

    public init() {}

    public func apply(
        _ result: Result<ClientTextEffect, LedgerError>,
        to client: NativeTextClient
    ) -> Bool {
        guard case let .success(effect) = result else { return false }
        return (try? adapter.apply(effect, to: client).get()) != nil
    }

    public func applyTransaction(
        to ledger: inout SessionLedger,
        client: NativeTextClient,
        revalidate: () -> Bool = { true },
        operation: (inout SessionLedger) -> Result<ClientTextEffect, LedgerError>
    ) -> Bool {
        guard revalidate() else { return false }
        var candidate = ledger
        let effect = operation(&candidate)
        guard revalidate(), apply(effect, to: client) else { return false }
        ledger = candidate
        return true
    }
}

public enum InputEventPolicy {
    public static func shouldConsumePhysicalKey(
        in state: NativeSessionState
    ) -> Bool {
        _ = state
        return false
    }
}
