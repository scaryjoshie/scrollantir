import Charts
import SwiftUI

struct EventLane: View {
  let title: String
  let events: [EnrichedEvent]
  let tint: Color
  let windowStart: Date
  let windowEnd: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(title).font(.headline)
        Text("(\(events.count))")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal)

      if events.isEmpty {
        Text("no events")
          .font(.caption)
          .foregroundStyle(.tertiary)
          .frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
          .padding(.horizontal)
      } else {
        Chart {
          ForEach(events) { event in
            BarMark(
              xStart: .value("start", event.timestampUTC),
              xEnd: .value("end", max(event.endsAt, event.timestampUTC.addingTimeInterval(30))),
              y: .value("source", event.source)
            )
            .foregroundStyle(tint.opacity(0.7))
          }
        }
        .chartXScale(domain: windowStart...windowEnd)
        .chartXAxis {
          AxisMarks(values: .stride(by: .hour, count: 3)) { _ in
            AxisGridLine()
            AxisTick()
            AxisValueLabel(format: .dateTime.hour())
          }
        }
        .chartYAxis {
          AxisMarks(position: .leading) { value in
            AxisValueLabel {
              if let s = value.as(String.self) {
                Text(s).font(.caption2)
              }
            }
          }
        }
        .frame(height: max(60, CGFloat(uniqueSources) * 18 + 24))
        .padding(.horizontal)
      }
    }
  }

  private var uniqueSources: Int {
    Set(events.map(\.source)).count
  }
}
