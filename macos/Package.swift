// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "Scrollantir",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "Scrollantir", targets: ["Scrollantir"])
  ],
  dependencies: [
    .package(url: "https://github.com/vapor/postgres-nio.git", from: "1.21.0"),
    .package(url: "https://github.com/kishikawakatsumi/KeychainAccess.git", from: "4.2.2"),
    .package(url: "https://github.com/gonzalezreal/swift-markdown-ui.git", from: "2.4.1"),
  ],
  targets: [
    .executableTarget(
      name: "Scrollantir",
      dependencies: [
        .product(name: "PostgresNIO", package: "postgres-nio"),
        "KeychainAccess",
        .product(name: "MarkdownUI", package: "swift-markdown-ui"),
      ]
    )
  ]
)
