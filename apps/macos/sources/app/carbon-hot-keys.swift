// Shortcuts in any app, registered with macOS (C120, T6-16).
//
// `RegisterEventHotKey` is the one API that takes a key system-wide without
// asking for Accessibility or Input Monitoring: it hears only the combinations
// it registered, never a keystroke meant for another app. It answers
// `eventHotKeyExistsErr` when another app already holds the combination, and
// that status is *Taken* on the Keyboard pane. The decision — what to
// register, and that nothing registers until every row is clear — is the
// kit's (`AnyAppShortcutsModel`, hotkeys.swift); this file only speaks Carbon.

import Carbon.HIToolbox
import MetistryKit

@MainActor
final class CarbonHotKeyRegistrar: HotKeyRegistrar {
    var onPress: (@MainActor (UInt32) -> Void)?

    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var handler: EventHandlerRef?

    /// `MTRY`: the signature every registration carries, so a press is ours.
    private static let signature: OSType = 0x4D54_5259

    func register(_ shortcut: MenuShortcut, id: UInt32) -> HotKeyRegistration {
        guard let keyCode = shortcut.virtualKeyCode else { return .refused(Int32(paramErr)) }
        installHandlerIfNeeded()
        unregister(id: id)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            keyCode,
            shortcut.carbonModifiers,
            EventHotKeyID(signature: Self.signature, id: id),
            GetApplicationEventTarget(),
            0,
            &ref
        )
        let outcome = HotKeyRegistration(status: status)
        if outcome == .registered, let ref { refs[id] = ref }
        return outcome
    }

    func unregister(id: UInt32) {
        guard let ref = refs.removeValue(forKey: id) else { return }
        UnregisterEventHotKey(ref)
    }

    private func installHandlerIfNeeded() {
        guard handler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var hotKey = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hotKey
            )
            guard status == noErr, hotKey.signature == CarbonHotKeyRegistrar.signature else { return OSStatus(eventNotHandledErr) }
            let registrar = Unmanaged<CarbonHotKeyRegistrar>.fromOpaque(context).takeUnretainedValue()
            let id = hotKey.id
            MainActor.assumeIsolated { registrar.onPress?(id) }
            return noErr
        }, 1, &spec, context, &handler)
    }
}
