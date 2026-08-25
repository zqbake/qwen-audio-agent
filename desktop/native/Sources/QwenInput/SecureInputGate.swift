import Carbon.HIToolbox
import QwenInputCore

enum SystemSecureInputGate {
    static var isEnabled: Bool {
        IsSecureEventInputEnabled()
    }

    static func makeSafetyGate() -> SafetyGate {
        SafetyGate(secureEventInputEnabled: {
            isEnabled
        })
    }
}
