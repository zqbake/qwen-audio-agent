import AppKit
import ApplicationServices
import Foundation
import QwenInputCore

final class SystemAccessibilityTextClient: AccessibilityTextClient {
    private let expectedPID: pid_t

    init?(expectedPID: pid_t?) {
        guard let expectedPID, expectedPID > 0,
              expectedPID != ProcessInfo.processInfo.processIdentifier else {
            return nil
        }
        self.expectedPID = expectedPID
    }

    func replaceRecentText(expected: String, replacement: String) -> Bool {
        guard let initial = editableSnapshot(),
              initial.selection.length == 0 else { return false }
        let expectedLength = (expected as NSString).length
        guard initial.selection.location >= expectedLength else { return false }
        let ownedRange = NSRange(
            location: initial.selection.location - expectedLength,
            length: expectedLength
        )
        guard (initial.value as NSString).substring(with: ownedRange) == expected,
              setRange(ownedRange, on: initial.element) else { return false }

        guard let confirmed = editableSnapshot(),
              CFEqual(initial.element, confirmed.element),
              confirmed.value == initial.value,
              confirmed.selection == ownedRange else { return false }
        return AXUIElementSetAttributeValue(
            confirmed.element,
            kAXSelectedTextAttribute as CFString,
            replacement as CFTypeRef
        ) == .success
    }

    func confirmFocusedElement() -> Bool {
        guard let initial = editableSnapshot() else { return false }
        var actionNames: CFArray?
        guard AXUIElementCopyActionNames(initial.element, &actionNames) == .success,
              let names = actionNames as? [String],
              names.contains(kAXConfirmAction as String),
              let confirmed = editableSnapshot(),
              CFEqual(initial.element, confirmed.element) else { return false }
        return AXUIElementPerformAction(
            confirmed.element,
            kAXConfirmAction as CFString
        ) == .success
    }

    private func editableSnapshot() -> Snapshot? {
        guard AXIsProcessTrusted(), !SystemSecureInputGate.isEnabled,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == expectedPID,
              let element = focusedElement() else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success,
              pid == expectedPID,
              booleanAttribute(kAXFocusedAttribute, of: element) == true,
              booleanAttribute(kAXEnabledAttribute, of: element) == true,
              stringAttribute(kAXSubroleAttribute, of: element) != "AXSecureTextField",
              attributeIsSettable(kAXSelectedTextRangeAttribute, on: element),
              attributeIsSettable(kAXSelectedTextAttribute, on: element),
              let value = stringAttribute(kAXValueAttribute, of: element),
              let selection = rangeAttribute(kAXSelectedTextRangeAttribute, of: element)
        else { return nil }
        return Snapshot(element: element, value: value, selection: selection)
    }

    private func focusedElement() -> AXUIElement? {
        let system = AXUIElementCreateSystemWide()
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            system,
            kAXFocusedUIElementAttribute as CFString,
            &value
        ) == .success, let value,
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    private func stringAttribute(_ name: String, of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    private func booleanAttribute(_ name: String, of element: AXUIElement) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success
        else { return nil }
        return value as? Bool
    }

    private func rangeAttribute(_ name: String, of element: AXUIElement) -> NSRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success,
              let value,
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(value, to: AXValue.self)
        guard
              AXValueGetType(axValue) == .cfRange else { return nil }
        var range = CFRange()
        guard AXValueGetValue(axValue, .cfRange, &range) else { return nil }
        return NSRange(location: range.location, length: range.length)
    }

    private func attributeIsSettable(_ name: String, on element: AXUIElement) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(
            element,
            name as CFString,
            &settable
        ) == .success && settable.boolValue
    }

    private func setRange(_ range: NSRange, on element: AXUIElement) -> Bool {
        var cfRange = CFRange(location: range.location, length: range.length)
        guard let value = AXValueCreate(.cfRange, &cfRange) else { return false }
        return AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            value
        ) == .success
    }

    private struct Snapshot {
        let element: AXUIElement
        let value: String
        let selection: NSRange
    }
}
