import MarkdownUI
import SwiftUI

struct ReportDetailView: View {
  let report: Report

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 6) {
          Text(report.title)
            .font(.title)
            .fontWeight(.semibold)
          HStack(spacing: 8) {
            Text(report.createdAt, format: .dateTime.month(.wide).day().year().hour().minute())
              .foregroundStyle(.secondary)
            if let ws = report.windowStart, let we = report.windowEnd {
              Text("·").foregroundStyle(.tertiary)
              Text(
                "window \(ws.formatted(.dateTime.month().day().hour())) → \(we.formatted(.dateTime.month().day().hour()))"
              )
              .font(.callout)
              .foregroundStyle(.secondary)
            }
          }
        }
        Divider()
        Markdown(report.body)
          .markdownTheme(.gitHub)
      }
      .padding(24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
