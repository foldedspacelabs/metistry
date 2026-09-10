// Opening a real terminal on one command, for step 7.
//
// `claude setup-token` is interactive — it opens a browser and waits — and the
// app hands every child it spawns an empty stdin on purpose, so it structurally
// cannot drive this one. Rather than fake a progress view over something it is
// not driving, the app opens the command where the person can see and answer it.
//
// A `.command` FILE, NOT APPLESCRIPT. Telling Terminal to `do script` is
// automation, which means a TCC prompt for Apple Events and a permission this
// app otherwise needs none of (apps/macos/resources/metistry.entitlements: this
// app touches no TCC-protected resource itself, and that is worth keeping true).
// A `.command` file is just a document macOS opens with the user's terminal —
// no entitlement, no prompt, and it honours whichever terminal they have set as
// the handler.
//
// The script is written 0700 into the app's own caches directory and carries
// nothing secret: it is one command line the app already shows on screen.

import AppKit
import Foundation
import MetistryKit

struct DotCommandTerminalOpener: TerminalOpener {
    func open(command: String, title: String) throws {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let scripts = dir.appendingPathComponent("com.foldedspacelabs.metistry/terminal", isDirectory: true)
        try FileManager.default.createDirectory(at: scripts, withIntermediateDirectories: true)

        // One file per invocation, named for what it does: the person sees the
        // filename in their terminal's title bar.
        let file = scripts.appendingPathComponent("\(slug(title)).command")
        let script = """
        #!/bin/sh
        # Opened by Metistry. This runs one command and stops; the app is
        # watching `metistry secrets list --json` for the result.
        echo "\(title)"
        echo
        \(command)
        status=$?
        echo
        echo "finished with status $status — you can close this window."
        exit $status
        """
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)

        // The user's own handler for `.command`, whatever it is. `openApplication`
        // with a hardcoded Terminal.app would override a choice that is theirs.
        NSWorkspace.shared.open(file)
    }

    private func slug(_ title: String) -> String {
        let allowed = title.map { $0.isLetter || $0.isNumber ? $0 : "-" }
        return String(allowed).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}
