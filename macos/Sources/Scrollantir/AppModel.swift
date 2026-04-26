import Foundation
import Observation

@Observable
@MainActor
final class AppModel {
  // Bootstrap state
  var database: Database?
  var bootstrapError: String?
  var isLoading: Bool = false

  // Reports tab
  var reports: [Report] = []
  var selectedReportID: UUID?
  var tagFilter: String? = nil  // nil = all

  // Timeline tab
  var timelineDay: Date = Calendar.current.startOfDay(for: .now)
  var macEvents: [EnrichedEvent] = []
  var phoneEvents: [EnrichedEvent] = []
  var locationEvents: [EnrichedEvent] = []

  func bootstrap() async {
    guard database == nil else { return }
    isLoading = true
    defer { isLoading = false }
    do {
      let dsn = try readUserRoleDSN()
      database = try await Database.connect(dsn: dsn)
      await loadReports()
      await loadTimeline()
    } catch {
      bootstrapError = "\(String(describing: error))"
    }
  }

  func loadReports() async {
    guard let db = database else { return }
    do {
      reports = try await db.fetchReports(tagFilter: tagFilter, limit: 50)
      // Keep selection stable when filters change.
      if let sel = selectedReportID, !reports.contains(where: { $0.id == sel }) {
        selectedReportID = reports.first?.id
      } else if selectedReportID == nil {
        selectedReportID = reports.first?.id
      }
    } catch {
      bootstrapError = "reports load failed: \(String(describing: error))"
    }
  }

  func loadTimeline() async {
    guard let db = database else { return }
    let cal = Calendar(identifier: .gregorian)
    let start = cal.startOfDay(for: timelineDay)
    let end = cal.date(byAdding: .day, value: 1, to: start) ?? start.addingTimeInterval(86_400)
    do {
      async let mac = db.fetchEvents(device: "mac", start: start, end: end)
      async let phone = db.fetchEvents(device: "phone", start: start, end: end)
      // Location placeholder — no such device yet; stays empty.
      macEvents = try await mac
      phoneEvents = try await phone
      locationEvents = []
    } catch {
      bootstrapError = "timeline load failed: \(String(describing: error))"
    }
  }
}
