import Foundation
import KeychainAccess

enum KeychainError: LocalizedError {
  case missingDSN

  var errorDescription: String? {
    switch self {
    case .missingDSN:
      return """
        scrollantir/user-role not found. Either:
          • set SCROLLANTIR_USER_ROLE_DSN=postgresql://… in the shell/Xcode scheme, or
          • ensure `./admin setup-roles` wrote the entry to the login keychain and that the
            current binary has access (unsigned SwiftPM builds often silently deadlock on
            the access check — the env var is the dev-friendly path).
        """
    }
  }
}

/// Returns the `user_role` DSN. Resolution order:
///   1. env `SCROLLANTIR_USER_ROLE_DSN`  — dev-friendly; no Keychain ACL dance
///   2. login keychain, service=scrollantir, account=user-role
///
/// Why the env var is first: unsigned SwiftPM binaries get a new code identity
/// each `swift build`, and macOS's Keychain Services can silently deadlock
/// instead of surfacing a visible "Always Allow" prompt. In that state the
/// app just hangs on `get(...)` with no indication. The env-var path avoids
/// Keychain entirely; use it during iteration.
func readUserRoleDSN() throws -> String {
  if let fromEnv = ProcessInfo.processInfo.environment["SCROLLANTIR_USER_ROLE_DSN"],
    !fromEnv.isEmpty
  {
    return fromEnv
  }
  let keychain = Keychain(service: "scrollantir")
  guard let dsn = try keychain.get("user-role"), !dsn.isEmpty else {
    throw KeychainError.missingDSN
  }
  return dsn
}
