import Foundation

struct Report: Identifiable, Hashable, Sendable {
  let id: UUID
  let title: String
  let body: String
  let tags: [String]
  let windowStart: Date?
  let windowEnd: Date?
  let createdAt: Date
}

struct EnrichedEvent: Identifiable, Hashable, Sendable {
  let id: UUID
  let timestampUTC: Date
  let device: String
  let source: String
  let durationSec: Double  // events.duration_s is double precision, not int
  let dataJSON: String

  var endsAt: Date { timestampUTC.addingTimeInterval(durationSec) }
}
