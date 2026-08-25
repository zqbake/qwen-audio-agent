import AppKit
import InputMethodKit
import QwenInputCore

@objc(QwenInputController)
final class QwenInputController: IMKInputController, @unchecked Sendable {
    private var sessionState = NativeSessionState.ready
    private var targetToken: ControllerTargetToken?
    private var ledger: SessionLedger?
    private let clientAdapter = TextClientAdapter()
    private let textOperationController = ClientTextOperationController()
    private let accessibilityController = AccessibilityOperationController()
    private let safetyGate = SystemSecureInputGate.makeSafetyGate()
    private let bridgeClient = InputBridgeClient()

    override func activateServer(_ sender: Any!) {
        super.activateServer(sender)
        guard let inputClient = client(),
              let client = IMKTextClientAdapter(inputClient),
              let clientIdentifier = client.uniqueIdentifier,
              !clientIdentifier.isEmpty else {
            sessionState = .blocked
            return
        }

        let token = ControllerRegistry.shared.activate(
            self,
            clientIdentifier: clientIdentifier
        )
        targetToken = token
        let sessionID = UUID()
        ledger = SessionLedger(
            sessionID: sessionID,
            generation: token.generation,
            targetID: token.targetID
        )
        sessionState = .ready
        bridgeClient.activate(
            controller: self,
            sender: inputClient,
            target: NativeOperationTarget(
                sessionID: sessionID.uuidString,
                generation: token.generation,
                targetID: token.targetID.uuidString
            )
        )
    }

    override func deactivateServer(_ sender: Any!) {
        bridgeClient.deactivate()
        removeOwnedPartialIfPossible(from: client())
        if let targetToken {
            ControllerRegistry.shared.deactivate(
                self,
                targetID: targetToken.targetID
            )
        }
        invalidateSession()
        super.deactivateServer(sender)
    }

    override func inputControllerWillClose() {
        bridgeClient.deactivate()
        if let targetToken {
            ControllerRegistry.shared.close(
                self,
                targetID: targetToken.targetID
            )
        }
        invalidateSession()
        super.inputControllerWillClose()
    }

    override func handle(_ event: NSEvent!, client sender: Any!) -> Bool {
        _ = event
        _ = sender
        return InputEventPolicy.shouldConsumePhysicalKey(in: sessionState)
    }

    func apply(_ effect: ClientTextEffect, sender: Any) -> Bool {
        guard let client = IMKTextClientAdapter(sender) else { return false }
        let context = SafetyContext(
            featureEnabled: true,
            desktopConnected: false,
            target: targetToken == nil ? .unknown : .ready,
            statusVisibility: .unknown,
            inputSource: .ready
        )
        let decision = safetyGate.evaluate(
            state: sessionState,
            context: context,
            hasOwnedPartial: ledger?.ownedMarkedRange != nil
        )
        guard decision == .captureAllowed else { return false }
        return (try? clientAdapter.apply(effect, to: client).get()) != nil
    }

    func applyBridgeOperation(
        _ message: NativeInputMessage,
        sender: Any
    ) -> Bool {
        guard var ledger,
              let token = targetToken,
              message.operationID != nil,
              let client = IMKTextClientAdapter(sender) else { return false }
        if let generation = message.generation,
           generation != token.generation { return false }
        if let targetID = message.targetID,
           targetID != token.targetID.uuidString { return false }
        if ledger.ownedMarkedRange?.location == NSNotFound,
           client.markedRange.location != NSNotFound {
            guard case .success = ledger.confirmMarkedRange(client.markedRange) else {
                return false
            }
            self.ledger = ledger
        }

        if message.type == .sessionCancel {
            let validationLedger = ledger
            guard textOperationController.applyTransaction(
                to: &ledger,
                client: client,
                revalidate: {
                    self.isCurrentCapability(
                        token: token,
                        ledger: validationLedger,
                        client: client
                    )
                },
                operation: { candidate in
                    candidate.cancel(
                        clientMarkedRange: client.markedRange,
                        generation: token.generation,
                        targetID: token.targetID
                    )
                }
            ) else {
                return false
            }
            self.ledger = ledger
            sessionState = .cancelled
            return true
        }
        if message.type == .sessionSubmit {
            guard let accessibilityClient = SystemAccessibilityTextClient(
                expectedPID: NSWorkspace.shared.frontmostApplication?.processIdentifier
            ), accessibilityController.submit(
                enabled: message.accessibilityEnabled == true,
                client: accessibilityClient,
                revalidate: {
                    self.canUseAccessibility(
                        token: token,
                        ledger: ledger,
                        client: client,
                        statusVisible: message.statusVisible == true
                    )
                }
            ) else {
                sessionState = .blocked
                return false
            }
            sessionState = .readyToSend
            return true
        }
        if message.type == .sessionPause {
            sessionState = .paused
            return true
        }
        if message.type == .sessionResume {
            sessionState = .listening
            return true
        }

        sessionState = .transcribing
        let context = SafetyContext(
            featureEnabled: true,
            desktopConnected: true,
            target: .ready,
            statusVisibility: message.statusVisible == true ? .ready : .unavailable,
            inputSource: .ready
        )
        guard safetyGate.evaluate(
            state: sessionState,
            context: context,
            hasOwnedPartial: ledger.ownedMarkedRange != nil
        ) == .captureAllowed else {
            removeOwnedPartialIfPossible(from: sender)
            sessionState = .blocked
            return false
        }

        let operation: (inout SessionLedger) -> Result<ClientTextEffect, LedgerError>
        var accessibilityEdit: OwnedTextEdit?
        switch message.type {
        case .sessionPartial:
            guard let text = message.text else { return false }
            operation = { candidate in
                candidate.partial(
                    text: text,
                    selectedRange: client.selectedRange,
                    clientMarkedRange: client.markedRange,
                    generation: token.generation,
                    targetID: token.targetID
                )
            }
        case .sessionFinal:
            guard let text = message.text else { return false }
            operation = { candidate in
                candidate.final(
                    text: text,
                    selectedRange: client.selectedRange,
                    clientMarkedRange: client.markedRange,
                    generation: token.generation,
                    targetID: token.targetID
                )
            }
        case .sessionOperation:
            guard let target = message.target else { return false }
            let edit: OwnedTextEdit = message.operation == "delete"
                ? .delete(target: target)
                : .replace(
                    target: target,
                    replacement: message.replacement ?? ""
                )
            operation = { candidate in
                candidate.edit(
                    edit,
                    generation: token.generation,
                    targetID: token.targetID
                )
            }
            accessibilityEdit = edit
        default:
            return false
        }
        let validationLedger = ledger
        let applied = textOperationController.applyTransaction(
            to: &ledger,
            client: client,
            revalidate: {
                self.canMutateText(
                    token: token,
                    ledger: validationLedger,
                    client: client,
                    statusVisible: message.statusVisible == true
                )
            },
            operation: operation
        )
        if !applied {
            let accessibilityValidationLedger = ledger
            guard let accessibilityEdit,
                  let accessibilityClient = SystemAccessibilityTextClient(
                      expectedPID: NSWorkspace.shared.frontmostApplication?.processIdentifier
                  ), accessibilityController.applyEdit(
                      accessibilityEdit,
                      to: &ledger,
                      generation: token.generation,
                      targetID: token.targetID,
                      enabled: message.accessibilityEnabled == true,
                      client: accessibilityClient,
                      revalidate: {
                          self.canUseAccessibility(
                              token: token,
                              ledger: accessibilityValidationLedger,
                              client: client,
                              statusVisible: message.statusVisible == true
                          )
                      }
                  ) else {
                sessionState = .blocked
                return false
            }
        }
        self.ledger = ledger
        sessionState = message.type == .sessionPartial
            ? .transcribing
            : .readyToSend
        return true
    }

    func bridgeConnectionLost(sender: Any) {
        removeOwnedPartialIfPossible(from: sender)
        sessionState = .error
    }

    private func removeOwnedPartialIfPossible(from sender: Any?) {
        guard var ledger,
              let token = targetToken,
              let client = IMKTextClientAdapter(sender) else {
            return
        }
        guard textOperationController.applyTransaction(
            to: &ledger,
            client: client,
            operation: { candidate in
                candidate.cancel(
                    clientMarkedRange: client.markedRange,
                    generation: token.generation,
                    targetID: token.targetID
                )
            }
        ) else { return }
        self.ledger = ledger
    }

    private func invalidateSession() {
        sessionState = .cancelled
        targetToken = nil
        ledger = nil
    }

    private func isCurrentCapability(
        token: ControllerTargetToken,
        ledger: SessionLedger,
        client: IMKTextClientAdapter
    ) -> Bool {
        guard targetToken == token,
              client.uniqueIdentifier == token.clientIdentifier,
              ControllerRegistry.shared.isActive(self, token: token) else {
            return false
        }
        let target = NativeOperationTarget(
            sessionID: ledger.sessionID.uuidString,
            generation: token.generation,
            targetID: token.targetID.uuidString
        )
        return bridgeClient.isConnected(controller: self, target: target)
    }

    private func canMutateText(
        token: ControllerTargetToken,
        ledger: SessionLedger,
        client: IMKTextClientAdapter,
        statusVisible: Bool
    ) -> Bool {
        guard isCurrentCapability(
            token: token,
            ledger: ledger,
            client: client
        ) else { return false }
        return safetyGate.evaluate(
            state: sessionState,
            context: SafetyContext(
                featureEnabled: true,
                desktopConnected: true,
                target: .ready,
                statusVisibility: statusVisible ? .ready : .unavailable,
                inputSource: .ready
            ),
            hasOwnedPartial: ledger.ownedMarkedRange != nil
        ) == .captureAllowed
    }

    private func canUseAccessibility(
        token: ControllerTargetToken,
        ledger: SessionLedger,
        client: IMKTextClientAdapter,
        statusVisible: Bool
    ) -> Bool {
        guard isCurrentCapability(
            token: token,
            ledger: ledger,
            client: client
        ) else { return false }
        return safetyGate.evaluate(
            state: .transcribing,
            context: SafetyContext(
                featureEnabled: true,
                desktopConnected: true,
                target: .ready,
                statusVisibility: statusVisible ? .ready : .unavailable,
                inputSource: .ready
            ),
            hasOwnedPartial: ledger.ownedMarkedRange != nil
        ) == .captureAllowed
    }
}
