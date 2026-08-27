import Carbon.HIToolbox
import Darwin
import Foundation

private enum ProbeError: Error {
    case invalidArguments
    case sourceUnavailable
    case operationFailed
}

private func property(
    _ source: TISInputSource,
    _ key: CFString?
) -> CFTypeRef? {
    guard let pointer = TISGetInputSourceProperty(source, key) else {
        return nil
    }
    return Unmanaged<CFTypeRef>.fromOpaque(pointer).takeUnretainedValue()
}

private func source(id: String) -> TISInputSource? {
    guard let key = kTISPropertyInputSourceID else { return nil }
    let filter = [key as String: id] as CFDictionary
    guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
    else { return nil }
    let values = list as NSArray
    guard let value = values.firstObject else { return nil }
    return unsafeBitCast(value as AnyObject, to: TISInputSource.self)
}

private func inputSourceID(_ source: TISInputSource) throws -> String {
    guard let value = property(source, kTISPropertyInputSourceID) as? String
    else { throw ProbeError.sourceUnavailable }
    return value
}

private func boolProperty(
    _ source: TISInputSource?,
    _ key: CFString?
) -> Bool {
    guard let source,
          let value = property(source, key) as? Bool else { return false }
    return value
}

private func snapshot(qwenID: String) throws {
    guard let key = kTISPropertyInputSourceID else {
        throw ProbeError.sourceUnavailable
    }
    let filter = [key as String: qwenID] as CFDictionary
    let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
    let values = list.map { $0 as NSArray } ?? NSArray()
    let qwen = values.firstObject.map {
        unsafeBitCast($0 as AnyObject, to: TISInputSource.self)
    }
    let keyboard = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
    let result: [String: Any] = [
        "keyboardId": try inputSourceID(keyboard),
        "qwenCount": values.count,
        "enabled": boolProperty(qwen, kTISPropertyInputSourceIsEnabled),
        "selected": boolProperty(qwen, kTISPropertyInputSourceIsSelected),
    ]
    let data = try JSONSerialization.data(withJSONObject: result, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func disable(qwenID: String) throws {
    guard let value = source(id: qwenID) else { return }
    guard TISDisableInputSource(value) == noErr else {
        throw ProbeError.operationFailed
    }
}

private func select(inputSourceID: String) throws {
    guard let value = source(id: inputSourceID),
          TISSelectInputSource(value) == noErr else {
        throw ProbeError.operationFailed
    }
}

do {
    guard CommandLine.arguments.count == 3 else {
        throw ProbeError.invalidArguments
    }
    switch CommandLine.arguments[1] {
    case "snapshot":
        try snapshot(qwenID: CommandLine.arguments[2])
    case "disable":
        try disable(qwenID: CommandLine.arguments[2])
    case "select":
        try select(inputSourceID: CommandLine.arguments[2])
    default:
        throw ProbeError.invalidArguments
    }
} catch {
    exit(EXIT_FAILURE)
}
