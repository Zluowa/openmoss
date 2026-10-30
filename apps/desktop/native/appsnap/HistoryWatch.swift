import AppKit
import CoreGraphics
import CryptoKit
import Foundation

private let chromeBundleIdentifiers: Set<String> = [
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.canary",
    "com.google.Chrome.dev",
]
private let unsupportedBrowserBundleIdentifiers: Set<String> = [
    "com.apple.Safari",
    "com.apple.SafariTechnologyPreview",
    "org.mozilla.firefox",
    "org.mozilla.firefoxdeveloperedition",
    "org.mozilla.nightly",
    "company.thebrowser.Browser",
    "com.microsoft.edgemac",
    "com.microsoft.edgemac.Beta",
    "com.microsoft.edgemac.Canary",
    "com.microsoft.edgemac.Dev",
    "com.brave.Browser",
]
private let maximumHistoryApplicationCount = 500
private let maximumHistoryIconDataURLCharacterCount = 192_000
private let maximumHistoryIconCatalogCharacterCount = 4 * 1024 * 1024
private let pngSignature: [UInt8] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]
private let historyApplicationDiscoveryExcludedBundleIdentifiers: Set<String> = [
    "com.apple.finder.Open-Computer",
    "com.openai.sky.CUAService",
    "com.spotify.installer",
]
private let historyBackgroundApplicationBundleIdentifiers: Set<String> = [
    "com.openai.sky.CUAService",
    "com.apple.WindowManager",
    "com.apple.controlcenter",
    "com.apple.dock",
    "com.apple.notificationcenterui",
    "com.apple.UserNotificationCenter",
    "com.apple.LocalAuthentication.UIAgent",
    "com.apple.LocalAuthenticationRemoteService",
    "com.apple.SecurityAgent",
]
private let historyApplicationSpotlightQuery =
    "kMDItemContentType == \"com.apple.application-bundle\" && kMDItemFSName == \"*.app\""
private let historyApplicationSpotlightRecordRegex = try? NSRegularExpression(
    pattern: "^(.*?)\\s+kMDItemDisplayName = (.*?)\\s+kMDItemCFBundleIdentifier = (.*?)\\s+kMDItemLastUsedDate_Ranking = (.*?)\\s+kMDItemUseCount = (.*)$"
)

private struct HistoryApplicationCandidate: Equatable {
    let appPath: String
    let bundleIdentifier: String
    let name: String
    let lastUsedDateRanking: TimeInterval
    let useCount: Int
}

struct BrowserWindowObservation {
    let title: String
    let url: String
    let privateBrowsing: Bool
}

enum HistoryBrowserObservationFailure: Error {
    case automationPermissionDenied
    case unknownWindowMode
}

enum HistoryBrowserClassification: Equatable {
    case verifiedChrome
    case verifiedBrowser
    case unsupportedBrowser
    case nonBrowser
}

private let unsupportedBrowserDetail =
    "No verified locale-independent private-window adapter is installed."

private func discoverRegisteredBrowserBundleIdentifiers() -> Set<String> {
    guard let url = URL(string: "https://example.invalid/") else { return [] }
    return Set(
        NSWorkspace.shared.urlsForApplications(toOpen: url).prefix(256).compactMap { applicationURL in
            Bundle(url: applicationURL)?.bundleIdentifier
        }
    )
}

func classifyHistoryBrowser(
    bundleIdentifier: String,
    registeredBrowserBundleIdentifiers: Set<String>
) -> HistoryBrowserClassification {
    if chromeBundleIdentifiers.contains(bundleIdentifier) { return .verifiedChrome }
    if unsupportedBrowserBundleIdentifiers.contains(bundleIdentifier) {
        return .unsupportedBrowser
    }
    switch historyBrowserFamily(for: bundleIdentifier) {
    case .chrome:
        return .verifiedChrome
    case .safari, .edge, .firefox, .unknown:
        return .unsupportedBrowser
    case .notBrowser:
        break
    }
    if registeredBrowserBundleIdentifiers.contains(bundleIdentifier) {
        return .unsupportedBrowser
    }
    return .nonBrowser
}

func historyBrowserObservationIsAllowed(
    bundleIdentifier: String,
    registeredBrowserBundleIdentifiers: Set<String>
) -> Bool {
    switch classifyHistoryBrowser(
        bundleIdentifier: bundleIdentifier,
        registeredBrowserBundleIdentifiers: registeredBrowserBundleIdentifiers
    ) {
    case .verifiedChrome, .verifiedBrowser, .nonBrowser:
        return true
    case .unsupportedBrowser:
        return false
    }
}

func parseHistoryBrowserObservation(
    mode: String,
    url: String,
    title: String
) -> Result<BrowserWindowObservation, HistoryBrowserObservationFailure> {
    guard mode == "normal" || mode == "incognito" else {
        return .failure(.unknownWindowMode)
    }
    guard !url.isEmpty, !title.isEmpty else {
        return .failure(.automationPermissionDenied)
    }
    return .success(
        BrowserWindowObservation(
            title: title,
            url: url,
            privateBrowsing: mode == "incognito"
        )
    )
}

func runHistoryDisplayPipelineGateSelfTest() -> Bool {
    let descriptor = HistoryDisplayDescriptor(
        displayID: 90,
        bounds: CGRect(x: 0, y: 0, width: 2, height: 2),
        pixelWidth: 1,
        pixelHeight: 1
    )
    guard let fingerprint = HistoryVisualFingerprint(
        grayscaleValues: [UInt8](repeating: 7, count: HistoryVisualFingerprint.sampleCount)
    ) else { return false }
    let displayResult = HistoryDisplayCaptureResult(
        descriptor: descriptor,
        fingerprint: fingerprint
    )
    let candidate = HistoryCaptureCandidate(
        requestId: "pipeline-fixture",
        fingerprint: String(repeating: "a", count: historyCandidateFingerprintLength),
        displayID: descriptor.displayID,
        displayGeneration: UUID(),
        displayBounds: descriptor.bounds,
        displayPixelWidth: descriptor.pixelWidth,
        displayPixelHeight: descriptor.pixelHeight,
        targetWindowID: 123,
        targetSignature: "fixture-signature",
        targetBounds: CGRect(x: 1, y: 1, width: 1, height: 1),
        bundleIdentifier: "com.example.fixture",
        appName: "Fixture",
        windowTitle: "Fixture window",
        url: nil,
        privateBrowsing: false,
        browserMode: nil,
        browserObservations: [:],
        expiresAt: Date().addingTimeInterval(10)
    )
    var childStarts = 0
    var childHistoryEmits = 0
    guard HistoryDisplayPipelineGate.startDisplayChild(
        revalidate: { false },
        start: {
            childStarts += 1
            childHistoryEmits += 1
        }
    ) == false,
          childStarts == 0,
          childHistoryEmits == 0,
          HistoryDisplayPipelineGate.startDisplayChild(
              revalidate: { true },
              start: { childStarts += 1 }
          ),
          childStarts == 1,
          childHistoryEmits == 0 else { return false }

    guard let selectedWindow = HistoryDisplayPipelineGate.selectedWindow(
        from: displayResult,
        candidate: candidate,
        hasEvidence: true,
        revalidate: { true }
    ), selectedWindow.windowID == candidate.targetWindowID,
          selectedWindow.bounds == candidate.targetBounds,
          selectedWindow.sourceBundleIdentifier == candidate.bundleIdentifier,
          HistoryDisplayPipelineGate.selectedWindow(
              from: displayResult,
              candidate: candidate,
              hasEvidence: false,
              revalidate: { true }
          ) == nil,
          HistoryDisplayPipelineGate.selectedWindow(
              from: displayResult,
              candidate: candidate,
              hasEvidence: true,
              revalidate: { false }
          ) == nil else { return false }

    let rgba = [UInt8](repeating: 128, count: 4)
    guard let provider = CGDataProvider(data: Data(rgba) as CFData),
          let image = CGImage(
              width: 1,
              height: 1,
              bitsPerComponent: 8,
              bitsPerPixel: 32,
              bytesPerRow: 4,
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
              provider: provider,
              decode: nil,
              shouldInterpolate: false,
              intent: .defaultIntent
          ) else { return false }

    var semanticRunnerStarts = 0
    var historyEmitCount = 0
    guard HistoryDisplayPipelineGate.startSemantic(
        from: .success(image),
        revalidate: { true },
        start: { _ in
            semanticRunnerStarts += 1
            historyEmitCount += 1
        }
    ), semanticRunnerStarts == 1,
          historyEmitCount == 1,
          !HistoryDisplayPipelineGate.startSemantic(
        from: .success(image),
        revalidate: { false },
        start: { _ in
            semanticRunnerStarts += 1
            historyEmitCount += 1
        }
    ),
          !HistoryDisplayPipelineGate.startSemantic(
              from: .failure(AppSnapFailure(code: "capture_failed", message: "fixture")),
              revalidate: { true },
              start: { _ in
                  semanticRunnerStarts += 1
                  historyEmitCount += 1
              }
          ),
          semanticRunnerStarts == 1,
          historyEmitCount == 1 else { return false }

    guard historyDisplayResampleIsAllowed(
        displayCaptureInFlight: false,
        windowCaptureInFlight: false,
        semanticInFlight: false,
        candidateInFlight: false
    ),
          !historyDisplayResampleIsAllowed(
              displayCaptureInFlight: true,
              windowCaptureInFlight: false,
              semanticInFlight: false,
              candidateInFlight: false
          ),
          !historyDisplayResampleIsAllowed(
              displayCaptureInFlight: false,
              windowCaptureInFlight: true,
              semanticInFlight: false,
              candidateInFlight: false
          ),
          !historyDisplayResampleIsAllowed(
              displayCaptureInFlight: false,
              windowCaptureInFlight: false,
              semanticInFlight: true,
              candidateInFlight: false
          ),
          !historyDisplayResampleIsAllowed(
              displayCaptureInFlight: false,
              windowCaptureInFlight: false,
              semanticInFlight: false,
              candidateInFlight: true
          ),
          // The other display has an independent gate and remains eligible.
          historyDisplayResampleIsAllowed(
              displayCaptureInFlight: false,
              windowCaptureInFlight: false,
              semanticInFlight: false,
              candidateInFlight: false
          ) else { return false }
    return true
}

func runHistoryWatchSelfTest() -> Bool {
    guard case let .success(normal) = parseHistoryBrowserObservation(
        mode: "normal",
        url: "https://example.invalid/normal",
        title: "localized normal title"
    ), !normal.privateBrowsing,
          case let .success(incognito) = parseHistoryBrowserObservation(
              mode: "incognito",
              url: "https://example.invalid/private",
              title: "本地化的隐私标题"
          ), incognito.privateBrowsing,
          case .failure(.unknownWindowMode) = parseHistoryBrowserObservation(
              mode: "future-mode",
              url: "https://example.invalid/unknown",
              title: "unknown"
          ) else { return false }

    let registered = Set(["com.example.unknown-browser"])
    guard classifyHistoryBrowser(
        bundleIdentifier: "com.example.unknown-browser",
        registeredBrowserBundleIdentifiers: registered
    ) == .unsupportedBrowser,
          !historyBrowserObservationIsAllowed(
              bundleIdentifier: "com.example.unknown-browser",
              registeredBrowserBundleIdentifiers: registered
          ),
          classifyHistoryBrowser(
              bundleIdentifier: "com.example.editor",
              registeredBrowserBundleIdentifiers: registered
          ) == .nonBrowser,
          historyBrowserObservationIsAllowed(
              bundleIdentifier: "com.example.editor",
              registeredBrowserBundleIdentifiers: registered
          ) else { return false }

    let recentRecord = "/Applications/Recent.app   kMDItemDisplayName = Recent   kMDItemCFBundleIdentifier = com.example.recent   kMDItemLastUsedDate_Ranking = 2026-08-20 00:00:00 +0000   kMDItemUseCount = 4"
    let frequentRecord = "/Applications/Frequent.app   kMDItemDisplayName = Frequent.app   kMDItemCFBundleIdentifier = com.example.frequent   kMDItemLastUsedDate_Ranking = 2026-08-20 00:00:00 +0000   kMDItemUseCount = 40"
    let neverUsedRecord = "/Applications/Never.app   kMDItemDisplayName = (null)   kMDItemCFBundleIdentifier = com.example.never   kMDItemLastUsedDate_Ranking = (null)   kMDItemUseCount = (null)"
    guard let recentApplication = parseHistoryApplicationSpotlightRecord(recentRecord),
          let frequentApplication = parseHistoryApplicationSpotlightRecord(frequentRecord),
          let neverUsedApplication = parseHistoryApplicationSpotlightRecord(neverUsedRecord),
          frequentApplication.name == "Frequent",
          neverUsedApplication.name == "Never",
          sortHistoryApplicationCandidates([
              neverUsedApplication,
              recentApplication,
              frequentApplication,
          ]).map(\.bundleIdentifier) == [
              "com.example.frequent",
              "com.example.recent",
              "com.example.never",
          ],
          parseHistoryApplicationSpotlightRecord(
              "/Applications/Hidden.app   kMDItemDisplayName = Hidden   kMDItemCFBundleIdentifier = com.openai.sky.CUAService   kMDItemLastUsedDate_Ranking = (null)   kMDItemUseCount = (null)"
          ) == nil else { return false }

    return runHistoryVisualActivityPolicySelfTest()
        && runHistorySemanticSummarySelfTest()
        && runOneFrameWindowCaptureCancellationSelfTest()
        && runHistoryPrivacyFilterSelfTest()
        && runHistoryDisplaySessionSelfTest()
        && runHistoryScreenCaptureChildSelfTest()
        && runHistoryDisplayPipelineGateSelfTest()
}

private func historyPermissionLabel(_ granted: Bool) -> String {
    granted ? "granted" : "denied"
}

private func chromeApplicationName(bundleIdentifier: String) -> String? {
    switch bundleIdentifier {
    case "com.google.Chrome": return "Google Chrome"
    case "com.google.Chrome.beta": return "Google Chrome Beta"
    case "com.google.Chrome.canary": return "Google Chrome Canary"
    case "com.google.Chrome.dev": return "Google Chrome Dev"
    default: return nil
    }
}

/// Chrome's scripting dictionary has a locale-independent window mode plus
/// active-tab URL/title. Automation denial and future modes are fail-closed.
private func chromeWindowObservation(
    bundleIdentifier: String
) -> Result<BrowserWindowObservation, HistoryBrowserObservationFailure> {
    guard let applicationName = chromeApplicationName(bundleIdentifier: bundleIdentifier) else {
        return .failure(.unknownWindowMode)
    }
    let source = """
    tell application "\(applicationName)"
        set activeWindow to front window
        set activeTab to active tab of activeWindow
        set windowMode to (mode of activeWindow) as text
        return {windowMode, URL of activeTab, title of activeTab}
    end tell
    """
    var error: NSDictionary?
    guard let script = NSAppleScript(source: source) else {
        return .failure(.automationPermissionDenied)
    }
    let result = script.executeAndReturnError(&error)
    guard result.numberOfItems >= 3,
          let mode = result.atIndex(1)?.stringValue,
          let url = result.atIndex(2)?.stringValue,
          let title = result.atIndex(3)?.stringValue,
          !mode.isEmpty else {
        return .failure(.automationPermissionDenied)
    }
    return parseHistoryBrowserObservation(mode: mode, url: url, title: title)
}

private func boundedHistoryIconDataURL(_ value: String?) -> String? {
    guard let value,
          value.hasPrefix("data:image/png;base64,"),
          value.count <= maximumHistoryIconDataURLCharacterCount else { return nil }
    let payload = String(value.dropFirst("data:image/png;base64,".count))
    guard !payload.isEmpty,
          let data = Data(base64Encoded: payload),
          data.count <= 128_000,
          Array(data.prefix(pngSignature.count)) == pngSignature else { return nil }
    return value
}

func installedApplications() -> [[String: String]] {
    let candidates = sortHistoryApplicationCandidates(runHistoryApplicationSpotlightQuery())
        + registeredHistoryBrowserApplications()
    var seenBundleIdentifiers = Set<String>()
    var visibleCandidates: [HistoryApplicationCandidate] = []
    for candidate in candidates {
        guard visibleCandidates.count < maximumHistoryApplicationCount,
              !seenBundleIdentifiers.contains(candidate.bundleIdentifier),
              !historyApplicationIsBackground(candidate) else { continue }
        seenBundleIdentifiers.insert(candidate.bundleIdentifier)
        visibleCandidates.append(candidate)
    }

    var iconCharacterCount = 0
    return visibleCandidates.map { candidate in
        var application = [
            "bundleIdentifier": candidate.bundleIdentifier,
            "name": candidate.name,
        ]
        if let iconDataURL = boundedHistoryIconDataURL(
            appIconDataURL(for: URL(fileURLWithPath: candidate.appPath))
        ) {
            let nextCount = iconCharacterCount + iconDataURL.count
            if nextCount <= maximumHistoryIconCatalogCharacterCount {
                iconCharacterCount = nextCount
                application["iconDataURL"] = iconDataURL
            }
        }
        return application
    }
}

private func parseHistoryApplicationSpotlightRecord(
    _ record: String
) -> HistoryApplicationCandidate? {
    guard !record.isEmpty,
          let regex = historyApplicationSpotlightRecordRegex,
          let match = regex.firstMatch(
              in: record,
              range: NSRange(record.startIndex..<record.endIndex, in: record)
          ) else { return nil }
    func capture(_ index: Int) -> String? {
        guard let range = Range(match.range(at: index), in: record) else { return nil }
        return String(record[range])
    }
    guard let appPath = capture(1),
          let rawDisplayName = capture(2),
          let bundleIdentifier = capture(3),
          let rawLastUsedDateRanking = capture(4),
          let rawUseCount = capture(5),
          appPath.hasSuffix(".app"),
          !bundleIdentifier.isEmpty,
          bundleIdentifier != "(null)",
          !historyApplicationDiscoveryExcludedBundleIdentifiers.contains(bundleIdentifier) else {
        return nil
    }
    let fallbackName = URL(fileURLWithPath: appPath).deletingPathExtension().lastPathComponent
    let displayName = rawDisplayName == "(null)" ? fallbackName : rawDisplayName
    let name = displayName.hasSuffix(".app") ? String(displayName.dropLast(4)) : displayName
    guard !name.isEmpty else { return nil }
    return HistoryApplicationCandidate(
        appPath: appPath,
        bundleIdentifier: bundleIdentifier,
        name: name,
        lastUsedDateRanking: parseHistoryApplicationLastUsedDate(rawLastUsedDateRanking),
        useCount: rawUseCount == "(null)" ? 0 : Int(rawUseCount) ?? 0
    )
}

private func parseHistoryApplicationLastUsedDate(_ value: String) -> TimeInterval {
    guard value != "(null)" else { return 0 }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
    return formatter.date(from: value)?.timeIntervalSince1970 ?? 0
}

private func sortHistoryApplicationCandidates(
    _ candidates: [HistoryApplicationCandidate]
) -> [HistoryApplicationCandidate] {
    var seenPaths = Set<String>()
    return candidates
        .filter { seenPaths.insert($0.appPath).inserted }
        .sorted { left, right in
            if left.lastUsedDateRanking != right.lastUsedDateRanking {
                return left.lastUsedDateRanking > right.lastUsedDateRanking
            }
            if left.useCount != right.useCount { return left.useCount > right.useCount }
            return left.name.localizedCompare(right.name) == .orderedAscending
        }
}

private func runHistoryApplicationSpotlightQuery() -> [HistoryApplicationCandidate] {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
    process.arguments = [
        "-0",
        historyApplicationSpotlightQuery,
        "-attr", "kMDItemDisplayName",
        "-attr", "kMDItemCFBundleIdentifier",
        "-attr", "kMDItemLastUsedDate_Ranking",
        "-attr", "kMDItemUseCount",
    ]
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
    } catch {
        return []
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0,
          let text = String(data: data, encoding: .utf8) else { return [] }
    return text.split(separator: "\0").compactMap {
        parseHistoryApplicationSpotlightRecord(String($0))
    }
}

private func registeredHistoryBrowserApplications() -> [HistoryApplicationCandidate] {
    guard let url = URL(string: "https://example.invalid/") else { return [] }
    return NSWorkspace.shared.urlsForApplications(toOpen: url).prefix(256).compactMap { appURL in
        guard let bundle = Bundle(url: appURL),
              let bundleIdentifier = bundle.bundleIdentifier,
              !bundleIdentifier.isEmpty else { return nil }
        let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? appURL.deletingPathExtension().lastPathComponent
        guard !name.isEmpty else { return nil }
        return HistoryApplicationCandidate(
            appPath: appURL.path,
            bundleIdentifier: bundleIdentifier,
            name: name,
            lastUsedDateRanking: 0,
            useCount: 0
        )
    }
}

private func historyApplicationIsBackground(_ candidate: HistoryApplicationCandidate) -> Bool {
    if historyBackgroundApplicationBundleIdentifiers.contains(candidate.bundleIdentifier) {
        return true
    }
    guard candidate.appPath.hasPrefix("/System/Applications/")
            || candidate.appPath.hasPrefix("/System/Library/"),
          let bundle = Bundle(url: URL(fileURLWithPath: candidate.appPath)) else { return false }
    return historyApplicationInfoBoolean(bundle.object(forInfoDictionaryKey: "LSUIElement"))
        || historyApplicationInfoBoolean(bundle.object(forInfoDictionaryKey: "LSBackgroundOnly"))
}

private func historyApplicationInfoBoolean(_ value: Any?) -> Bool {
    if let bool = value as? Bool { return bool }
    return (value as? NSNumber)?.boolValue == true
}

private let historyCaptureTimeoutSeconds = 6.0
private let historyCandidateFingerprintLength = 64
private let historyDecisionLineByteLimit = 16 * 1024
private let historyInitialSampleDelay = 0.25
private let historyIdlePollDelay = 1.0
private let historyDisplayReconcileDelay = 1.0

private func historyCombinedSessionIdleSeconds() -> TimeInterval? {
    guard let anyInputEvent = CGEventType(rawValue: UInt32.max) else { return nil }
    let idleSeconds = CGEventSource.secondsSinceLastEventType(
        .combinedSessionState,
        eventType: anyInputEvent
    )
    guard idleSeconds.isFinite else { return nil }
    return max(0, idleSeconds)
}

private func historyFingerprint(
    bundleIdentifier: String,
    title: String?,
    url: String?,
    browserMode: String?
) -> String {
    let material = [bundleIdentifier, title ?? "", url ?? "", browserMode ?? ""].joined(separator: "\u{1f}")
    return SHA256.hash(data: Data(material.utf8)).map { String(format: "%02x", $0) }.joined()
        .prefix(historyCandidateFingerprintLength).description
}

private struct HistoryCaptureCandidate {
    let requestId: String
    let fingerprint: String
    let displayID: CGDirectDisplayID
    let displayGeneration: UUID
    let displayBounds: CGRect
    let displayPixelWidth: Int
    let displayPixelHeight: Int
    let targetWindowID: UInt32
    let targetSignature: String
    let targetBounds: CGRect
    let bundleIdentifier: String
    let appName: String
    let windowTitle: String?
    let url: String?
    let privateBrowsing: Bool
    let browserMode: String?
    let browserObservations: [String: HistoryScreenCaptureChildBrowserObservation]
    let expiresAt: Date
}

/// The production hand-off between the whole-display privacy supervisor and
/// the existing exact window-crop/semantic path. The display result contains
/// only a bounded fingerprint; this gate deliberately has no image/frame
/// input, so a whole-display image cannot enter semantic processing.
enum HistoryDisplayPipelineGate {
    static func startDisplayChild(
        revalidate: () -> Bool,
        start: () -> Void
    ) -> Bool {
        guard revalidate() else { return false }
        start()
        return true
    }

    static func shouldStartWindowCapture(
        from capture: HistoryDisplayCaptureResult,
        revalidate: () -> Bool
    ) -> Bool {
        _ = capture.fingerprint
        return revalidate()
    }

    fileprivate static func selectedWindow(
        from capture: HistoryDisplayCaptureResult,
        candidate: HistoryCaptureCandidate,
        hasEvidence: Bool,
        revalidate: () -> Bool
    ) -> SelectedWindow? {
        guard hasEvidence,
              shouldStartWindowCapture(from: capture, revalidate: revalidate) else {
            return nil
        }
        return SelectedWindow(
            windowID: candidate.targetWindowID,
            bounds: candidate.targetBounds,
            sourceAppName: candidate.appName,
            sourceBundleIdentifier: candidate.bundleIdentifier,
            sourceAppIconDataURL: nil,
            sourceWindowTitle: candidate.windowTitle
        )
    }

    @discardableResult
    static func startSemantic(
        from result: Result<CGImage, AppSnapFailure>,
        revalidate: () -> Bool,
        start: (CGImage) -> Void
    ) -> Bool {
        guard case let .success(image) = result, revalidate() else { return false }
        start(image)
        return true
    }
}

func historyDisplayResampleIsAllowed(
    displayCaptureInFlight: Bool,
    windowCaptureInFlight: Bool,
    semanticInFlight: Bool,
    candidateInFlight: Bool
) -> Bool {
    !displayCaptureInFlight
        && !windowCaptureInFlight
        && !semanticInFlight
        && !candidateInFlight
}

/// Per-display candidate/decision/receipt watcher. A candidate contains only
/// policy data; each allowed decision starts the real child supervisor for that
/// display. The child response is reduced in-memory before model work.
final class ComputerHistoryWatchCoordinator {
    private let emitter: NDJSONEmitter
    private let displaySupervisor: HistoryDisplayCaptureSupervisor
    private var timer: Timer?
    private var displayTimers: [CGDirectDisplayID: Timer] = [:]
    private var displayReconcileTimer: Timer?
    private var displayPolicies: [CGDirectDisplayID: HistoryVisualActivityPolicy] = [:]
    private var displayPrivacyFilters: [CGDirectDisplayID: HistoryPrivacyFilter] = [:]
    private var descriptors: [CGDirectDisplayID: HistoryDisplayDescriptor] = [:]
    private var displayGenerations: [CGDirectDisplayID: UUID] = [:]
    private var registeredBrowserBundleIdentifiers = Set<String>()
    private var pendingCandidates: [String: HistoryCaptureCandidate] = [:]
    private var inputBuffer = Data()
    private var activeWindowCaptures: [CGDirectDisplayID: OneFrameWindowCapture] = [:]
    private var semanticTasks: [CGDirectDisplayID: Task<Void, Never>] = [:]
    private var stopped = false

    init(
        emitter: NDJSONEmitter,
        displaySupervisor: HistoryDisplayCaptureSupervisor? = nil
    ) {
        self.emitter = emitter
        self.displaySupervisor = displaySupervisor ?? HistoryDisplayCaptureSupervisor()
    }

    func start() {
        guard !stopped else { return }
        registeredBrowserBundleIdentifiers = discoverRegisteredBrowserBundleIdentifiers()
        let screenRecordingGranted = CGPreflightScreenCaptureAccess()
            || CGRequestScreenCaptureAccess()
        emitter.emitHistoryReady()
        emitter.emitHistoryPermissions(
            inputMonitoring: "unknown",
            accessibility: "unknown",
            screenRecording: historyPermissionLabel(screenRecordingGranted)
        )
        emitter.emitHistorySemanticCapability(historySemanticCapability())
        let knownHistoryBrowserBundles: [(String, String, String)] = [
            ("com.google.Chrome", "Google Chrome", "supported"),
            ("com.google.Chrome.beta", "Google Chrome Beta", "supported"),
            ("com.google.Chrome.canary", "Google Chrome Canary", "supported"),
            ("com.google.Chrome.dev", "Google Chrome Dev", "supported"),
            ("com.apple.Safari", "Safari", "unsupported"),
            ("com.apple.SafariTechnologyPreview", "Safari Technology Preview", "unsupported"),
            ("com.microsoft.edgemac", "Microsoft Edge", "unsupported"),
            ("com.microsoft.edgemac.Beta", "Microsoft Edge Beta", "unsupported"),
            ("com.microsoft.edgemac.Canary", "Microsoft Edge Canary", "unsupported"),
            ("com.microsoft.edgemac.Dev", "Microsoft Edge Dev", "unsupported"),
            ("org.mozilla.firefox", "Firefox", "unsupported"),
            ("org.mozilla.firefoxdeveloperedition", "Firefox Developer Edition", "unsupported"),
            ("org.mozilla.nightly", "Firefox Nightly", "unsupported"),
        ]
        var capabilities = knownHistoryBrowserBundles.map { bundleIdentifier, name, status in
            [
                "bundleIdentifier": bundleIdentifier,
                "name": name,
                "status": status,
                "detail": status == "supported"
                    ? "Chrome private-mode adapter and per-display privacy checks are available."
                    : unsupportedBrowserDetail,
            ]
        }
        let knownBundleIdentifiers = Set(capabilities.compactMap { $0["bundleIdentifier"] })
        for bundleIdentifier in registeredBrowserBundleIdentifiers
            where !knownBundleIdentifiers.contains(bundleIdentifier) {
            capabilities.append([
                "bundleIdentifier": bundleIdentifier,
                "name": applicationNameForBundle(bundleIdentifier),
                "status": "unsupported",
                "detail": unsupportedBrowserDetail,
            ])
        }
        emitter.emitHistoryBrowserCapabilities(capabilities)
        emitter.emitHistoryApplications(installedApplications())
        reconcileDisplaySessions()
        scheduleDisplayReconcile()
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            guard let data = try? handle.read(upToCount: 16 * 1024), !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consumeDecisions(data) }
        }
        scheduleNextSample(after: historyInitialSampleDelay)
    }

    private func scheduleDisplayReconcile() {
        guard !stopped else { return }
        displayReconcileTimer?.invalidate()
        displayReconcileTimer = Timer.scheduledTimer(
            withTimeInterval: historyDisplayReconcileDelay,
            repeats: false
        ) { [weak self] _ in
            guard let self else { return }
            self.displayReconcileTimer = nil
            self.reconcileDisplaySessions()
            self.scheduleDisplayReconcile()
        }
    }

    private func reconcileDisplaySessions() {
        guard !stopped else { return }
        let active = historyActiveDisplayDescriptors()
        let activeByID = Dictionary(uniqueKeysWithValues: active.map { ($0.displayID, $0) })
        let transitions = displaySupervisor.reconcile(active)
        for transition in transitions {
            switch transition {
            case let .removed(displayID), let .replaced(displayID):
                displayGenerations[displayID] = UUID()
                displayTimers[displayID]?.invalidate()
                displayTimers.removeValue(forKey: displayID)
                descriptors.removeValue(forKey: displayID)
                displayPolicies.removeValue(forKey: displayID)
                displayPrivacyFilters.removeValue(forKey: displayID)
                pendingCandidates = pendingCandidates.filter { $0.value.displayID != displayID }
                activeWindowCaptures[displayID]?.cancel()
                activeWindowCaptures.removeValue(forKey: displayID)
                semanticTasks[displayID]?.cancel()
                semanticTasks.removeValue(forKey: displayID)
            case let .added(displayID):
                displayGenerations[displayID] = UUID()
                displayTimers[displayID]?.invalidate()
                displayTimers[displayID] = nil
            case .reordered:
                break
            }
        }
        descriptors = activeByID
        for descriptor in active {
            _ = displayPolicies[descriptor.displayID]
            if displayTimers[descriptor.displayID] == nil,
               activeWindowCaptures[descriptor.displayID] == nil,
               semanticTasks[descriptor.displayID] == nil,
               !pendingCandidates.values.contains(where: { $0.displayID == descriptor.displayID }),
               !displaySupervisor.hasCaptureInFlight(on: descriptor.displayID) {
                scheduleDisplaySample(descriptor.displayID, after: historyInitialSampleDelay)
            }
        }
    }

    private func scheduleNextSample(after delay: TimeInterval) {
        guard !stopped else { return }
        timer?.invalidate()
        let boundedDelay = min(HistoryVisualActivityPolicy.failureDelay, max(0.05, delay))
        timer = Timer.scheduledTimer(withTimeInterval: boundedDelay, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.timer = nil
            self.handleScheduledSample()
        }
    }

    private func scheduleDisplaySample(_ displayID: CGDirectDisplayID, after delay: TimeInterval) {
        guard !stopped, descriptors[displayID] != nil else { return }
        displayTimers[displayID]?.invalidate()
        let boundedDelay = min(HistoryVisualActivityPolicy.failureDelay, max(0.05, delay))
        displayTimers[displayID] = Timer.scheduledTimer(withTimeInterval: boundedDelay, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.displayTimers[displayID] = nil
            self.sampleDisplay(displayID)
        }
    }

    private func handleScheduledSample() {
        guard !stopped else { return }
        let idleSeconds = historyCombinedSessionIdleSeconds()
        if idleSeconds.map({ $0 >= HistoryVisualActivityPolicy.idlePauseThreshold }) == true {
            scheduleNextSample(after: historyIdlePollDelay)
            return
        }
        sampleAllDisplays()
    }

    private func sampleAllDisplays() {
        reconcileDisplaySessions()
        guard !descriptors.isEmpty else {
            scheduleNextSample(after: HistoryVisualActivityPolicy.failureDelay)
            return
        }
        for descriptor in descriptors.values.sorted(by: { $0.displayID < $1.displayID }) {
            scheduleDisplaySample(descriptor.displayID, after: historyInitialSampleDelay)
        }
    }

    private func sampleDisplay(_ displayID: CGDirectDisplayID) {
        guard !stopped, let descriptor = descriptors[displayID] else { return }
        let idleSeconds = historyCombinedSessionIdleSeconds()
        if idleSeconds.map({ $0 >= HistoryVisualActivityPolicy.idlePauseThreshold }) == true {
            scheduleDisplaySample(displayID, after: historyIdlePollDelay)
            return
        }
        guard historyDisplayResampleIsAllowed(
                  displayCaptureInFlight: displaySupervisor.hasCaptureInFlight(on: displayID),
                  windowCaptureInFlight: activeWindowCaptures[displayID] != nil,
                  semanticInFlight: semanticTasks[displayID] != nil,
                  candidateInFlight: pendingCandidates.values.contains(where: { $0.displayID == displayID })
              ),
              let candidate = makeCandidate(for: descriptor) else {
            scheduleDisplaySample(displayID, after: HistoryVisualActivityPolicy.failureDelay)
            return
        }
        pendingCandidates[candidate.requestId] = candidate
        emitter.emitHistoryCaptureCandidate(
            requestId: candidate.requestId,
            fingerprint: candidate.fingerprint,
            bundleIdentifier: candidate.bundleIdentifier,
            appName: candidate.appName,
            windowTitle: candidate.windowTitle,
            url: candidate.url,
            privateBrowsing: candidate.privateBrowsing,
            browserMode: candidate.browserMode
        )
        let requestID = candidate.requestId
        DispatchQueue.main.asyncAfter(deadline: .now() + historyCaptureTimeoutSeconds) { [weak self] in
            guard let self,
                  let current = self.pendingCandidates[requestID],
                  current.expiresAt <= Date() else { return }
            self.pendingCandidates.removeValue(forKey: requestID)
            self.scheduleDisplaySample(current.displayID, after: HistoryVisualActivityPolicy.failureDelay)
        }
    }

    private func makeCandidate(for descriptor: HistoryDisplayDescriptor) -> HistoryCaptureCandidate? {
        let displayID = descriptor.displayID
        guard let observations = historyDisplayWindowObservations(
            displayID: displayID,
            now: ProcessInfo.processInfo.systemUptime
        ), !observations.isEmpty else { return nil }
        var privacyFilter = displayPrivacyFilters[displayID] ?? HistoryPrivacyFilter()
        let now = ProcessInfo.processInfo.systemUptime
        guard privacyFilter.assessDisplay(bounds: descriptor.bounds, observations: observations, now: now) == .allowed else {
            displayPrivacyFilters[displayID] = privacyFilter
            return nil
        }
        displayPrivacyFilters[displayID] = privacyFilter
        guard let target = observations.first(where: { observation in
            observation.bounds.intersects(descriptor.bounds)
                && observation.bundleIdentifier != Bundle.main.bundleIdentifier
                && observation.bundleIdentifier != nil
        }), let bundleIdentifier = target.bundleIdentifier else { return nil }
        let classification = classifyHistoryBrowser(
            bundleIdentifier: bundleIdentifier,
            registeredBrowserBundleIdentifiers: registeredBrowserBundleIdentifiers
        )
        let appName = applicationNameForBundle(bundleIdentifier)
        var title = target.title
        var url: String?
        var browserMode: String?
        switch classification {
        case .unsupportedBrowser:
            return nil
        case .verifiedChrome:
            guard let frontmost = NSWorkspace.shared.frontmostApplication,
                  frontmost.bundleIdentifier == bundleIdentifier,
                  case let .success(browser) = chromeWindowObservation(bundleIdentifier: bundleIdentifier),
                  !browser.privateBrowsing,
                  browser.title == target.title else { return nil }
            title = browser.title
            url = browser.url
            browserMode = "normal"
        case .verifiedBrowser, .nonBrowser:
            break
        }
        return HistoryCaptureCandidate(
            requestId: "display-\(displayID)-\(UUID().uuidString)",
            fingerprint: historyFingerprint(
                bundleIdentifier: bundleIdentifier,
                title: title,
                url: url,
                browserMode: browserMode
            ),
            displayID: displayID,
            displayGeneration: displayGenerations[displayID] ?? UUID(),
            displayBounds: descriptor.bounds,
            displayPixelWidth: descriptor.pixelWidth,
            displayPixelHeight: descriptor.pixelHeight,
            targetWindowID: target.windowID,
            targetSignature: target.signature,
            targetBounds: target.bounds,
            bundleIdentifier: bundleIdentifier,
            appName: appName,
            windowTitle: title,
            url: url,
            privateBrowsing: false,
            browserMode: browserMode,
            browserObservations: privacyFilter.browserObservationSnapshot(),
            expiresAt: Date().addingTimeInterval(historyCaptureTimeoutSeconds)
        )
    }

    private func consumeDecisions(_ data: Data) {
        inputBuffer.append(data)
        guard inputBuffer.count <= historyDecisionLineByteLimit else {
            inputBuffer.removeAll(keepingCapacity: true)
            return
        }
        while let newline = inputBuffer.firstIndex(of: 0x0A) {
            let line = inputBuffer.prefix(upTo: newline)
            inputBuffer.removeSubrange(...newline)
            guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else {
                continue
            }
            handleDecision(object)
        }
    }

    private func handleDecision(_ message: [String: Any]) {
        guard Set(message.keys) == Set(["type", "requestId", "fingerprint", "allow"]),
              message["type"] as? String == "history_capture_decision",
              let requestId = message["requestId"] as? String,
              let fingerprint = message["fingerprint"] as? String,
              let allow = message["allow"] as? Bool,
              requestId.count <= 128,
              fingerprint.count == historyCandidateFingerprintLength,
              let candidate = pendingCandidates[requestId],
              candidate.fingerprint == fingerprint,
              candidate.expiresAt > Date() else { return }
        pendingCandidates.removeValue(forKey: requestId)
        guard allow else {
            scheduleDisplaySample(candidate.displayID, after: HistoryVisualActivityPolicy.failureDelay)
            return
        }
        guard let descriptor = descriptors[candidate.displayID] else {
            emitter.emitError(
                AppSnapFailure(
                    code: "history_stale_target",
                    message: "The Computer History target changed before capture."
                ),
                capturedAt: appSnapTimestamp(),
                id: requestId
            )
            scheduleDisplaySample(candidate.displayID, after: HistoryVisualActivityPolicy.failureDelay)
            return
        }
        let privacyFilter = HistoryScreenCaptureChildPrivacyFilter(
            browserObservations: candidate.browserObservations
        )
        guard HistoryDisplayPipelineGate.startDisplayChild(
            revalidate: { [weak self] in self?.revalidate(candidate) ?? false },
            start: { [weak self] in
                _ = self?.displaySupervisor.capture(
                    descriptor: descriptor,
                    privacyFilter: privacyFilter,
                    now: ProcessInfo.processInfo.systemUptime
                ) { [weak self] result in
                    DispatchQueue.main.async {
                        self?.consumeDisplayCapture(
                            result,
                            candidate: candidate
                        )
                    }
                }
            }
        ) else {
            emitter.emitError(
                AppSnapFailure(
                    code: "history_stale_target",
                    message: "The Computer History target changed before capture."
                ),
                capturedAt: appSnapTimestamp(),
                id: requestId
            )
            scheduleDisplaySample(candidate.displayID, after: HistoryVisualActivityPolicy.failureDelay)
            return
        }
    }

    private func consumeDisplayCapture(
        _ result: Result<HistoryDisplayCaptureResult, HistoryDisplayCaptureFailure>,
        candidate: HistoryCaptureCandidate
    ) {
        guard !stopped, isCurrent(candidate) else { return }
        switch result {
        case let .failure(failure):
            emitter.emitError(
                AppSnapFailure(
                    code: "history_display_capture_failed",
                    message: String(describing: failure)
                ),
                capturedAt: appSnapTimestamp(),
                id: candidate.requestId
            )
            scheduleDisplaySample(candidate.displayID, after: HistoryVisualActivityPolicy.failureDelay)
        case let .success(capture):
            let monotonicAt = ProcessInfo.processInfo.systemUptime
            let wallClockAt = Date().timeIntervalSince1970
            let idleSeconds = historyCombinedSessionIdleSeconds()
            var policy = displayPolicies[candidate.displayID] ?? HistoryVisualActivityPolicy()
            let decision = policy.recordCapture(
                fingerprint: capture.fingerprint,
                monotonicAt: monotonicAt,
                wallClockAt: wallClockAt,
                duration: 0,
                recentUserInput: idleSeconds.map {
                    $0 < HistoryVisualActivityPolicy.recentInputDelay
                } ?? false
            )
            displayPolicies[candidate.displayID] = policy
            guard decision.evidenceReason != nil else {
                scheduleDisplaySample(candidate.displayID, after: decision.nextDelay)
                return
            }
            let displayID = candidate.displayID
            let isBrowser = chromeBundleIdentifiers.contains(candidate.bundleIdentifier)
            activeWindowCaptures[displayID]?.cancel()
            semanticTasks[displayID]?.cancel()
            // The child only supplied a cadence fingerprint. This shared
            // production seam revalidates the candidate after evidence and
            // constructs the exact SelectedWindow consumed by
            // OneFrameWindowCapture; no whole-display image is available at
            // this point.
            guard let selectedWindow = HistoryDisplayPipelineGate.selectedWindow(
                from: capture,
                candidate: candidate,
                hasEvidence: true,
                revalidate: { [weak self] in self?.revalidate(candidate) ?? false }
            ) else {
                emitter.emitError(
                    AppSnapFailure(
                        code: "history_stale_target",
                        message: "The Computer History target changed before window capture."
                    ),
                    capturedAt: appSnapTimestamp(),
                    id: candidate.requestId
                )
                scheduleDisplaySample(candidate.displayID, after: HistoryVisualActivityPolicy.failureDelay)
                return
            }
            let windowCapture = OneFrameWindowCapture(selectedWindow: selectedWindow) { [weak self] result in
                DispatchQueue.main.async {
                    self?.consumeSemanticCapture(
                        result,
                        candidate: candidate,
                        isBrowser: isBrowser,
                        nextDelay: decision.nextDelay
                    )
                }
            }
            activeWindowCaptures[displayID] = windowCapture
            windowCapture.start()
        }
    }

    private func consumeSemanticCapture(
        _ result: Result<CGImage, AppSnapFailure>,
        candidate: HistoryCaptureCandidate,
        isBrowser: Bool,
        nextDelay: TimeInterval
    ) {
        let displayID = candidate.displayID
        activeWindowCaptures.removeValue(forKey: displayID)
        guard !stopped, isCurrent(candidate) else { return }
        switch result {
        case let .failure(failure):
            emitter.emitError(failure, capturedAt: appSnapTimestamp(), id: candidate.requestId)
            scheduleDisplaySample(displayID, after: HistoryVisualActivityPolicy.failureDelay)
        case .success:
            // This is the second URL/window/bounds revalidation: it happens
            // after the exact SCStream crop succeeds and immediately before
            // the image enters the on-device semantic task. The shared gate
            // keeps this invariant in the production path and in its
            // deterministic self-test.
            guard HistoryDisplayPipelineGate.startSemantic(
                from: result,
                revalidate: { [weak self] in self?.revalidate(candidate) ?? false },
                start: { [weak self] image in
                    guard let self else { return }
                    self.semanticTasks[displayID]?.cancel()
                    self.semanticTasks[displayID] = Task { @MainActor [weak self] in
                        guard let self, !self.stopped, !Task.isCancelled else { return }
                        let semanticSummary = await summarizeHistoryFrameOnDevice(image)
                        guard !self.stopped, !Task.isCancelled else { return }
                        self.emitter.emitHistoryObservation(
                            requestId: candidate.requestId,
                            fingerprint: candidate.fingerprint,
                            capturedAt: appSnapTimestamp(),
                            bundleIdentifier: candidate.bundleIdentifier,
                            appName: candidate.appName,
                            windowTitle: nil,
                            activityText: !isBrowser && semanticSummary == nil ? "[redacted activity]" : nil,
                            semanticSummary: semanticSummary
                        )
                        self.semanticTasks[displayID] = nil
                        self.scheduleDisplaySample(displayID, after: nextDelay)
                    }
                }
            ) else {
                emitter.emitError(
                    AppSnapFailure(
                        code: "history_stale_target",
                        message: "The Computer History target changed after window capture."
                    ),
                    capturedAt: appSnapTimestamp(),
                    id: candidate.requestId
                )
                scheduleDisplaySample(displayID, after: HistoryVisualActivityPolicy.failureDelay)
                return
            }
        }
    }

    private func revalidate(_ candidate: HistoryCaptureCandidate) -> Bool {
        guard let descriptor = descriptors[candidate.displayID],
              let observations = historyDisplayWindowObservations(
                  displayID: candidate.displayID,
                  now: ProcessInfo.processInfo.systemUptime
              ),
              let target = observations.first(where: { $0.windowID == candidate.targetWindowID }),
              target.bundleIdentifier == candidate.bundleIdentifier,
              target.signature == candidate.targetSignature,
              target.bounds == candidate.targetBounds else { return false }
        var filter = displayPrivacyFilters[candidate.displayID] ?? HistoryPrivacyFilter()
        guard filter.assessDisplay(
            bounds: descriptor.bounds,
            observations: observations,
            now: ProcessInfo.processInfo.systemUptime
        ) == .allowed else { return false }
        displayPrivacyFilters[candidate.displayID] = filter
        if chromeBundleIdentifiers.contains(candidate.bundleIdentifier) {
            guard case let .success(observation) = chromeWindowObservation(
                bundleIdentifier: candidate.bundleIdentifier
            ), !observation.privateBrowsing,
                  historyFingerprint(
                      bundleIdentifier: candidate.bundleIdentifier,
                      title: observation.title,
                      url: observation.url,
                      browserMode: "normal"
                  ) == candidate.fingerprint else { return false }
        }
        return true
    }

    private func isCurrent(_ candidate: HistoryCaptureCandidate) -> Bool {
        guard let descriptor = descriptors[candidate.displayID] else { return false }
        return displayGenerations[candidate.displayID] == candidate.displayGeneration
            && descriptor.bounds == candidate.displayBounds
            && descriptor.pixelWidth == candidate.displayPixelWidth
            && descriptor.pixelHeight == candidate.displayPixelHeight
    }

    private func applicationNameForBundle(_ bundleIdentifier: String) -> String {
        if let name = NSWorkspace.shared.runningApplications
            .first(where: { $0.bundleIdentifier == bundleIdentifier })?.localizedName,
           !name.isEmpty {
            return name
        }
        if let applicationURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier),
           let name = Bundle(url: applicationURL)?.localizedInfoDictionary?["CFBundleDisplayName"] as? String,
           !name.isEmpty {
            return name
        }
        return chromeApplicationName(bundleIdentifier: bundleIdentifier) ?? bundleIdentifier
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        timer?.invalidate()
        timer = nil
        displayReconcileTimer?.invalidate()
        displayReconcileTimer = nil
        for displayTimer in displayTimers.values { displayTimer.invalidate() }
        displayTimers.removeAll(keepingCapacity: false)
        displaySupervisor.stop()
        pendingCandidates.removeAll()
        inputBuffer.removeAll(keepingCapacity: false)
        for capture in activeWindowCaptures.values { capture.cancel() }
        activeWindowCaptures.removeAll(keepingCapacity: false)
        for task in semanticTasks.values { task.cancel() }
        semanticTasks.removeAll(keepingCapacity: false)
        cancelHistorySemanticInference()
        FileHandle.standardInput.readabilityHandler = nil
    }

    deinit {
        stop()
    }
}
