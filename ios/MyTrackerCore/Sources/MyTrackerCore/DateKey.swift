import Foundation

public enum DateKey {
    public static func string(from date: Date, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            components.year ?? 0,
            components.month ?? 0,
            components.day ?? 0
        )
    }

    public static func date(from value: String, calendar: Calendar = .current) -> Date? {
        let pieces = value.split(separator: "-").compactMap { Int($0) }
        guard pieces.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: pieces[0], month: pieces[1], day: pieces[2], hour: 12))
    }

    public static func isValid(_ value: String) -> Bool {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil,
              let date = date(from: value) else { return false }
        return string(from: date) == value
    }

    public static func mondayWeek(containing value: String) -> (start: String, end: String)? {
        guard let date = date(from: value) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let weekday = calendar.component(.weekday, from: date)
        let daysSinceMonday = (weekday + 5) % 7
        guard let startDate = calendar.date(byAdding: .day, value: -daysSinceMonday, to: date),
              let endDate = calendar.date(byAdding: .day, value: 6, to: startDate) else { return nil }
        return (string(from: startDate, calendar: calendar), string(from: endDate, calendar: calendar))
    }
}
