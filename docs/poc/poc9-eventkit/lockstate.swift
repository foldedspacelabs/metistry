import CoreGraphics
import Foundation
if let d = CGSessionCopyCurrentDictionary() as? [String: Any] {
    for k in ["kCGSSessionOnConsoleKey", "CGSSessionScreenIsLocked", "kCGSSessionUserNameKey", "kCGSSessionLoginDoneKey"] {
        print("\(k) = \(d[k] ?? "<absent>")")
    }
} else { print("no session dictionary (not in a GUI session)") }
