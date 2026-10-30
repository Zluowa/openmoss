import Foundation
import Security

private let historyKeychainServicePrefix = "com.moss.computer-history"
private let historyKeychainAccount = "moss"

private func historyKeychainService(namespace: String) throws -> String {
    guard namespace.count >= 1,
          namespace.count <= 80,
          namespace.unicodeScalars.allSatisfy({ scalar in
              (scalar.value >= 48 && scalar.value <= 57) ||
              (scalar.value >= 97 && scalar.value <= 122) ||
              scalar.value == 45
          })
    else {
        throw AppSnapFailure(
            code: "history_keychain_unavailable",
            message: "Computer History Keychain namespace is invalid."
        )
    }
    return "\(historyKeychainServicePrefix).\(namespace)"
}

func readComputerHistoryKey(namespace: String) throws -> Data {
    let service = try historyKeychainService(namespace: namespace)
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: historyKeychainAccount,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data, data.count == 32 else {
        throw AppSnapFailure(
            code: "history_keychain_unavailable",
            message: "Computer History encryption key is unavailable."
        )
    }
    return data
}
func createComputerHistoryKey(namespace: String) throws -> Data {
    if let existing = try? readComputerHistoryKey(namespace: namespace) {
        return existing
    }
    let service = try historyKeychainService(namespace: namespace)
    var key = Data(count: 32)
    let randomStatus = key.withUnsafeMutableBytes { bytes in
        SecRandomCopyBytes(kSecRandomDefault, 32, bytes.baseAddress!)
    }
    guard randomStatus == errSecSuccess else {
        throw AppSnapFailure(
            code: "history_keychain_unavailable",
            message: "Computer History encryption key is unavailable."
        )
    }
    let attributes: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: historyKeychainAccount,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecValueData as String: key
    ]
    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecSuccess {
        return key
    }
    // Another helper process may have won the create race. Never return the
    // uncommitted candidate: the store must use the key that Keychain owns.
    if status == errSecDuplicateItem {
        return try readComputerHistoryKey(namespace: namespace)
    }
    throw AppSnapFailure(
        code: "history_keychain_unavailable",
        message: "Computer History encryption key is unavailable."
    )
}

func destroyComputerHistoryKey(namespace: String) throws {
    let service = try historyKeychainService(namespace: namespace)
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: historyKeychainAccount
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        throw AppSnapFailure(
            code: "history_keychain_unavailable",
            message: "Computer History encryption key could not be removed."
        )
    }
}
