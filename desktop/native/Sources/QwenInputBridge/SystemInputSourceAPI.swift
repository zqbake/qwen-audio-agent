import Carbon.HIToolbox
import Foundation
import QwenInputCore

/// Thin production adapter around Text Input Source Services. The coordinator
/// owns all policy; this type only performs exact lookups and requested calls.
/// It is never invoked by the default-off build or automated tests.
final class SystemInputSourceAPI: InputSourceAPI, InputMethodRegistration {
    private let qwenInputSourceID: String

    init(qwenInputSourceID: String = "ai.qwenaudio.agent.inputmethod") {
        self.qwenInputSourceID = qwenInputSourceID
    }

    func containsInputSource() -> Bool {
        containsInputSource(id: qwenInputSourceID)
    }

    func isInputSourceEnabled() -> Bool {
        isInputSourceEnabled(id: qwenInputSourceID)
    }

    func isInputSourceSelected() -> Bool {
        isInputSourceSelected(id: qwenInputSourceID)
    }

    func registerInputSource(at url: URL) -> Bool {
        TISRegisterInputSource(url as CFURL) == noErr
    }

    func enableInputSource() -> Bool {
        guard let source = inputSource(id: qwenInputSourceID) else {
            return false
        }
        return TISEnableInputSource(source) == noErr
    }

    func selectInputSource() -> Bool {
        guard let source = inputSource(id: qwenInputSourceID) else {
            return false
        }
        return TISSelectInputSource(source) == noErr
    }

    func disableInputSource() -> Bool {
        guard let source = inputSource(id: qwenInputSourceID) else {
            return true
        }
        return TISDisableInputSource(source) == noErr
    }
    func containsInputSource(id: String) -> Bool {
        inputSource(id: id) != nil
    }

    func isInputSourceEnabled(id: String) -> Bool {
        boolProperty(id: id, key: kTISPropertyInputSourceIsEnabled)
    }

    func isInputSourceSelected(id: String) -> Bool {
        boolProperty(id: id, key: kTISPropertyInputSourceIsSelected)
    }

    private func boolProperty(id: String, key: CFString?) -> Bool {
        guard let source = inputSource(id: id),
              let pointer = TISGetInputSourceProperty(
                  source,
                  key
              )
        else {
            return false
        }

        let value = Unmanaged<CFBoolean>
            .fromOpaque(pointer)
            .takeUnretainedValue()
        return CFBooleanGetValue(value)
    }

    private func inputSource(id: String) -> TISInputSource? {
        guard let key = kTISPropertyInputSourceID else {
            return nil
        }
        let filter = [key as String: id] as CFDictionary
        guard let values = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
        else {
            return nil
        }

        let array = values as NSArray
        guard let value = array.firstObject else {
            return nil
        }
        return unsafeBitCast(value as AnyObject, to: TISInputSource.self)
    }

}
