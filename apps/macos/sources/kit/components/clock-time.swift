// Clock times, 12-hour with AM/PM, everywhere (amendments §8.1; facets §7.5).
//
// A time is *1:02 PM*. A range carries the meridiem once when both ends share
// it — *9:30–10:00 AM* — and twice when they do not — *11:30 AM–12:30 PM*. A
// duration says it is one (*4m 12s*), so it cannot be misread as a time. The
// rule is the product's, not the reader's locale's: a 24-hour system setting
// does not turn *1:02 PM* into *13:02*, which is why the formatters pin
// `en_US_POSIX` and spell the pattern out. The time zone is the caller's (the
// Mac's own, or a fixture's), so a snapshot renders the same on every machine.

import Foundation

public struct ClockTime: Sendable {
    public let timeZone: TimeZone

    public init(timeZone: TimeZone = .current) {
        self.timeZone = timeZone
    }

    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        return c
    }

    private func format(_ pattern: String, _ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = pattern
        f.amSymbol = "AM"
        f.pmSymbol = "PM"
        return f.string(from: date)
    }

    /// *1:02 PM*.
    public func time(_ date: Date) -> String {
        format("h:mm a", date)
    }

    /// *9:30–10:00 AM*, or *11:30 AM–12:30 PM* when the meridiem changes.
    public func range(_ start: Date, _ end: Date) -> String {
        let a = format("a", start), b = format("a", end)
        let sameDay = calendar.isDate(start, inSameDayAs: end)
        if a == b && sameDay { return "\(format("h:mm", start))–\(time(end))" }
        return "\(time(start))–\(time(end))"
    }

    /// *16 Sep* — the day, when it is not today.
    public func day(_ date: Date) -> String {
        format("d MMM", date)
    }

    /// *9:14 AM* today; *27 Sep, 9:14 AM* on any other day. What a stale band
    /// and a *last collected* line say.
    public func moment(_ date: Date, now: Date) -> String {
        calendar.isDate(date, inSameDayAs: now) ? time(date) : "\(day(date)), \(time(date))"
    }

    /// *4m 12s* · *2h 5m* · *45s* · *3d 2h* — a duration, never a clock time.
    public static func duration(_ seconds: TimeInterval) -> String {
        let s = max(Int(seconds.rounded()), 0)
        let (d, h, m, r) = (s / 86_400, s % 86_400 / 3600, s % 3600 / 60, s % 60)
        if d > 0 { return h > 0 ? "\(d)d \(h)h" : "\(d)d" }
        if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        if m > 0 { return r > 0 ? "\(m)m \(r)s" : "\(m)m" }
        return "\(r)s"
    }

    /// *40 minutes ago* · *3 hours ago* · *2 days ago* — an age, in words, for
    /// a stale pill or a *last succeeded* line. Under a minute is *just now*.
    public static func age(_ seconds: TimeInterval) -> String {
        let s = max(Int(seconds), 0)
        func unit(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s") ago" }
        if s < 60 { return "just now" }
        if s < 3600 { return unit(s / 60, "minute") }
        if s < 86_400 { return unit(s / 3600, "hour") }
        return unit(s / 86_400, "day")
    }
}
