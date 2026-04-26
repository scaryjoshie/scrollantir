import SwiftUI

struct ReportCard: View {
  let report: Report

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(report.title)
        .font(.headline)
        .lineLimit(1)
      HStack(spacing: 6) {
        Text(report.createdAt, format: .dateTime.month().day().hour().minute())
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
        ForEach(report.tags, id: \.self) { tag in
          Text(tag)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tagColor(tag).opacity(0.2), in: Capsule())
            .foregroundStyle(tagColor(tag))
        }
      }
    }
    .padding(.vertical, 2)
  }

  private func tagColor(_ tag: String) -> Color {
    switch tag {
    case "daily": return .blue
    case "weekly": return .purple
    case "smoke": return .gray
    default: return .orange
    }
  }
}
