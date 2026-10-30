import CoreGraphics
import Foundation

#if canImport(AppKit)
import AppKit
#endif

/// The browser and video allow-list is deliberately explicit.  A display is
/// an all-or-nothing privacy boundary: one uncertain window rejects the whole
/// display rather than allowing a partial crop to leak around it.
enum HistoryBrowserFamily: String, Equatable {
    case chrome
    case safari
    case edge
    case firefox
    case unknown
    case notBrowser
}

enum HistoryPrivacyRejectionReason: String, Equatable {
    case chromeIncognitoTitle = "chrome_incognito_title"
    case safariPrivateBrowsingTitle = "safari_private_browsing_title"
    case videoConferencingBrowserTitle = "video_conferencing_browser_title"
    case videoConferencingAppTitle = "video_conferencing_app_title"
    case browserWindowUnstable = "browser_window_unstable"
    case browserWindowMissingTitle = "browser_window_missing_title"
    case staleObservation = "stale_observation"
    case unknownBrowser = "unknown_browser"
    case unsupportedBrowser = "unsupported_browser"
    case unknownSensitiveWindow = "unknown_sensitive_window"
}

enum HistoryPrivacyDecision: Equatable {
    case allowed
    case rejected(HistoryPrivacyRejectionReason)
}

struct HistoryDisplayWindowObservation: Equatable {
    let windowID: UInt32
    let bundleIdentifier: String?
    let title: String?
    let bounds: CGRect
    let observedAt: TimeInterval
    let signature: String

    init(
        windowID: UInt32,
        bundleIdentifier: String?,
        title: String?,
        bounds: CGRect,
        observedAt: TimeInterval,
        signature: String? = nil
    ) {
        self.windowID = windowID
        self.bundleIdentifier = bundleIdentifier
        self.title = title
        self.bounds = bounds
        self.observedAt = observedAt
        self.signature = signature ?? historyDisplayWindowSignature(
            windowID: windowID,
            bundleIdentifier: bundleIdentifier,
            title: title,
            bounds: bounds
        )
    }
}

private let historyChromeBrowserBundles: Set<String> = [
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.canary",
    "com.google.Chrome.dev"
]

private let historySafariBrowserBundles: Set<String> = [
    "com.apple.Safari",
    "com.apple.SafariTechnologyPreview"
]

private let historyEdgeBrowserBundles: Set<String> = [
    "com.microsoft.edgemac",
    "com.microsoft.edgemac.Beta",
    "com.microsoft.edgemac.Canary",
    "com.microsoft.edgemac.Dev"
]

private let historyFirefoxBrowserBundles: Set<String> = [
    "org.mozilla.firefox",
    "org.mozilla.firefoxdeveloperedition",
    "org.mozilla.nightly"
]

private let historyVideoApplicationBundles: Set<String> = [
    "us.zoom.xos",
    "us.zoom.ZoomHybridConf",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "com.microsoft.teams2.helper",
    "com.microsoft.teams2.modulehost"
]

private let historyVideoTitleMarkers = [
    "Google Meet",
    "meet.google.com",
    "Meet -",
    "zoom.us",
    "Microsoft Teams",
    "teams.microsoft.com",
    "teams.cloud.microsoft",
    "TeamsMeetingWindow"
]

func historyBrowserFamily(for bundleIdentifier: String?) -> HistoryBrowserFamily {
    guard let bundleIdentifier else { return .notBrowser }
    if historyChromeBrowserBundles.contains(bundleIdentifier) { return .chrome }
    if historySafariBrowserBundles.contains(bundleIdentifier) { return .safari }
    if historyEdgeBrowserBundles.contains(bundleIdentifier) { return .edge }
    if historyFirefoxBrowserBundles.contains(bundleIdentifier) { return .firefox }
    let lowered = bundleIdentifier.lowercased()
    if lowered.contains("browser") || lowered.contains("chrome") || lowered.contains("safari") ||
        lowered.contains("firefox") || lowered.contains("edgemac") {
        return .unknown
    }
    return .notBrowser
}

func historyDisplayWindowIsVideo(
    bundleIdentifier: String?,
    title: String?
) -> Bool {
    if let bundleIdentifier, historyVideoApplicationBundles.contains(bundleIdentifier) {
        return true
    }
    guard let title, !title.isEmpty else { return false }
    return historyVideoTitleMarkers.contains { title.localizedCaseInsensitiveContains($0) }
}

func historyDisplayWindowVideoReason(
    bundleIdentifier: String?,
    title: String?
) -> HistoryPrivacyRejectionReason? {
    if let bundleIdentifier, historyVideoApplicationBundles.contains(bundleIdentifier) {
        return .videoConferencingAppTitle
    }
    guard let title, !title.isEmpty,
          historyVideoTitleMarkers.contains(where: { title.localizedCaseInsensitiveContains($0) }) else {
        return nil
    }
    return .videoConferencingBrowserTitle
}

func historyDisplayWindowPrivateReason(
    bundleIdentifier: String?,
    title: String?
) -> HistoryPrivacyRejectionReason? {
    guard let title, !title.isEmpty else { return nil }
    switch historyBrowserFamily(for: bundleIdentifier) {
    case .chrome where title.localizedCaseInsensitiveContains("(Incognito)") ||
        title.localizedCaseInsensitiveContains("Incognito"):
        return .chromeIncognitoTitle
    case .safari where title.localizedCaseInsensitiveContains("Private Browsing"):
        return .safariPrivateBrowsingTitle
    default:
        return nil
    }
}

func historyDisplayWindowSignature(
    windowID: UInt32,
    bundleIdentifier: String?,
    title: String?,
    bounds: CGRect
) -> String {
    [
        String(windowID),
        bundleIdentifier ?? "",
        title ?? "",
        String(format: "%.2f,%.2f,%.2f,%.2f", bounds.origin.x, bounds.origin.y, bounds.width, bounds.height)
    ].joined(separator: "\u{1f}")
}

struct HistoryWindowStabilityTracker: Equatable {
    private struct Entry: Equatable {
        var signature: String
        var count: Int
        var lastObservedAt: TimeInterval
    }

    private var entries: [UInt32: Entry] = [:]
    private let maximumStableCount = 3

    mutating func observe(
        windowID: UInt32,
        signature: String,
        at timestamp: TimeInterval
    ) -> Int {
        prune(olderThan: timestamp - HistoryPrivacyFilter.maximumObservationAge)
        if let entry = entries[windowID], entry.signature == signature {
            let nextCount = min(maximumStableCount, entry.count + 1)
            entries[windowID] = Entry(
                signature: signature,
                count: nextCount,
                lastObservedAt: timestamp
            )
            return nextCount
        }
        entries[windowID] = Entry(signature: signature, count: 1, lastObservedAt: timestamp)
        return 1
    }

    func count(for windowID: UInt32) -> Int {
        entries[windowID]?.count ?? 0
    }

    mutating func prune(olderThan timestamp: TimeInterval) {
        entries = entries.filter { $0.value.lastObservedAt >= timestamp }
    }

    mutating func removeAll() {
        entries.removeAll(keepingCapacity: false)
    }

    mutating func seed(
        windowID: UInt32,
        signature: String,
        stableObservations: Int,
        at timestamp: TimeInterval
    ) {
        guard !signature.isEmpty else { return }
        entries[windowID] = Entry(
            signature: signature,
            count: min(maximumStableCount, max(0, stableObservations)),
            lastObservedAt: timestamp
        )
    }

    func snapshot() -> [String: (signature: String, stableObservations: Int)] {
        Dictionary(uniqueKeysWithValues: entries.map { (String($0.key), ($0.value.signature, $0.value.count)) })
    }
}

struct HistoryPrivacyFilter: Equatable {
    static let maximumObservationAge: TimeInterval = 5

    private(set) var stability = HistoryWindowStabilityTracker()

    mutating func assessDisplay(
        bounds displayBounds: CGRect,
        observations: [HistoryDisplayWindowObservation],
        now: TimeInterval
    ) -> HistoryPrivacyDecision {
        stability.prune(olderThan: now - Self.maximumObservationAge)
        for observation in observations where observation.bounds.intersects(displayBounds) {
            guard now >= observation.observedAt,
                  now - observation.observedAt <= Self.maximumObservationAge else {
                return .rejected(.staleObservation)
            }

            let title = observation.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let browserFamily = historyBrowserFamily(for: observation.bundleIdentifier)
            guard browserFamily == .notBrowser || title?.isEmpty == false else {
                return .rejected(.browserWindowMissingTitle)
            }

            // Only Chrome and Safari have a verified, locale-independent
            // private-mode adapter in this helper. Edge/Firefox variants are
            // advertised as unsupported and never enter a capture decision.
            switch browserFamily {
            case .edge, .firefox:
                return .rejected(.unsupportedBrowser)
            case .unknown:
                return .rejected(.unknownBrowser)
            case .chrome, .safari, .notBrowser:
                break
            }

            if let reason = historyDisplayWindowPrivateReason(
                bundleIdentifier: observation.bundleIdentifier,
                title: title
            ) {
                return .rejected(reason)
            }
            if let videoReason = historyDisplayWindowVideoReason(
                bundleIdentifier: observation.bundleIdentifier,
                title: title
            ) {
                return .rejected(videoReason)
            }

            switch browserFamily {
            case .chrome, .safari:
                let count = stability.observe(
                    windowID: observation.windowID,
                    signature: observation.signature,
                    at: observation.observedAt
                )
                guard count >= 3 else {
                    return .rejected(.browserWindowUnstable)
                }
            case .edge, .firefox, .unknown:
                return .rejected(.unsupportedBrowser)
            case .notBrowser:
                break
            }
        }
        return .allowed
    }

    mutating func reset() {
        stability.removeAll()
    }

    mutating func seedBrowserObservations(
        _ observations: [String: HistoryScreenCaptureChildBrowserObservation],
        at timestamp: TimeInterval
    ) {
        for (windowID, observation) in observations {
            guard let id = UInt32(windowID) else { continue }
            stability.seed(
                windowID: id,
                signature: observation.signature,
                stableObservations: observation.stableObservations,
                at: timestamp
            )
        }
    }

    func browserObservationSnapshot() -> [String: HistoryScreenCaptureChildBrowserObservation] {
        Dictionary(uniqueKeysWithValues: stability.snapshot().map { key, value in
            (
                key,
                HistoryScreenCaptureChildBrowserObservation(
                    signature: value.signature,
                    stableObservations: value.stableObservations
                )
            )
        })
    }
}

/// Reads only bounded window metadata needed for the privacy decision.  The
/// caller must never serialize this array; titles and bundle IDs stay inside
/// the helper and are discarded after the decision.
func historyDisplayWindowObservations(
    displayID: CGDirectDisplayID,
    now: TimeInterval
) -> [HistoryDisplayWindowObservation]? {
    let displayBounds = CGDisplayBounds(displayID)
    guard displayBounds.width > 0, displayBounds.height > 0,
          let windowInfo = CGWindowListCopyWindowInfo(
              [.optionOnScreenOnly, .excludeDesktopElements],
              kCGNullWindowID
          ) as? [[String: Any] ] else {
        return nil
    }
    return windowInfo.compactMap { candidate in
        guard let layer = candidate[kCGWindowLayer as String] as? NSNumber,
              layer.intValue == 0,
              (candidate[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
              let boundsDictionary = candidate[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              bounds.width >= 2,
              bounds.height >= 2,
              bounds.intersects(displayBounds),
              let windowNumber = candidate[kCGWindowNumber as String] as? NSNumber else {
            return nil
        }
        let processID = (candidate[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        #if canImport(AppKit)
        let bundleIdentifier = processID.flatMap {
            NSRunningApplication(processIdentifier: pid_t($0))?.bundleIdentifier
        }
        #else
        let bundleIdentifier: String? = nil
        #endif
        let title = candidate[kCGWindowName as String] as? String
        return HistoryDisplayWindowObservation(
            windowID: windowNumber.uint32Value,
            bundleIdentifier: bundleIdentifier,
            title: title,
            bounds: bounds,
            observedAt: now,
            signature: historyDisplayWindowSignature(
                windowID: windowNumber.uint32Value,
                bundleIdentifier: bundleIdentifier,
                title: title,
                bounds: bounds
            )
        )
    }
}

func runHistoryPrivacyFilterSelfTest() -> Bool {
    let display = CGRect(x: 0, y: 0, width: 1_920, height: 1_080)
    func observation(
        _ id: UInt32,
        _ bundle: String,
        _ title: String?,
        _ time: TimeInterval = 100,
        _ bounds: CGRect = CGRect(x: 0, y: 0, width: 1_000, height: 800),
        _ signature: String? = nil
    ) -> HistoryDisplayWindowObservation {
        HistoryDisplayWindowObservation(
            windowID: id,
            bundleIdentifier: bundle,
            title: title,
            bounds: bounds,
            observedAt: time,
            signature: signature
        )
    }

    let verifiedBundles = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.google.Chrome.dev",
        "com.apple.Safari", "com.apple.SafariTechnologyPreview"
    ]
    for (index, bundle) in verifiedBundles.enumerated() {
        var filter = HistoryPrivacyFilter()
        let first = observation(UInt32(index + 1), bundle, "Normal tab")
        guard filter.assessDisplay(bounds: display, observations: [first], now: 100) == .rejected(.browserWindowUnstable),
              filter.assessDisplay(bounds: display, observations: [first], now: 100) == .rejected(.browserWindowUnstable),
              filter.assessDisplay(bounds: display, observations: [first], now: 100) == .allowed else {
            return false
        }
    }
    for (index, bundle) in [
        "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Canary", "com.microsoft.edgemac.Dev",
        "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly"
    ].enumerated() {
        var filter = HistoryPrivacyFilter()
        guard filter.assessDisplay(
            bounds: display,
            observations: [observation(UInt32(index + 12), bundle, "Normal tab")],
            now: 100
        ) == .rejected(.unsupportedBrowser) else { return false }
    }

    var privateFilter = HistoryPrivacyFilter()
    guard privateFilter.assessDisplay(
        bounds: display,
        observations: [observation(20, "com.google.Chrome", "Docs (Incognito)")],
        now: 100
    ) == .rejected(.chromeIncognitoTitle) else { return false }
    guard privateFilter.assessDisplay(
        bounds: display,
        observations: [observation(21, "com.apple.Safari", "Private Browsing")],
        now: 100
    ) == .rejected(.safariPrivateBrowsingTitle) else { return false }

    let videoBundles = [
        "us.zoom.xos", "us.zoom.ZoomHybridConf", "com.microsoft.teams", "com.microsoft.teams2",
        "com.microsoft.teams2.helper", "com.microsoft.teams2.modulehost"
    ]
    for (index, bundle) in videoBundles.enumerated() {
        guard privateFilter.assessDisplay(
            bounds: display,
            observations: [observation(UInt32(index + 30), bundle, "Meeting")],
            now: 100
        ) == .rejected(.videoConferencingAppTitle) else { return false }
    }
    for marker in ["Google Meet", "meet.google.com", "Meet -", "zoom.us", "Microsoft Teams",
                   "teams.microsoft.com", "teams.cloud.microsoft", "TeamsMeetingWindow"] {
        guard privateFilter.assessDisplay(
            bounds: display,
            observations: [observation(60, "com.example.app", marker)],
            now: 100
        ) == .rejected(.videoConferencingBrowserTitle) else { return false }
    }

    guard privateFilter.assessDisplay(
        bounds: display,
        observations: [observation(70, "com.example.editor", nil)],
        now: 100
    ) == .allowed,
        privateFilter.assessDisplay(
            bounds: display,
            observations: [observation(70, "com.example.unknown-browser", "Unknown")],
            now: 100
        ) == .rejected(.unknownBrowser),
        privateFilter.assessDisplay(
            bounds: display,
            observations: [observation(71, "com.google.Chrome", "Tab", 90)],
            now: 100
        ) == .rejected(.staleObservation) else { return false }

    var signatureFilter = HistoryPrivacyFilter()
    let stable = observation(80, "com.google.Chrome", "Tab")
    _ = signatureFilter.assessDisplay(bounds: display, observations: [stable], now: 100)
    _ = signatureFilter.assessDisplay(bounds: display, observations: [stable], now: 100)
    guard signatureFilter.assessDisplay(
        bounds: display,
        observations: [observation(80, "com.google.Chrome", "Other")],
        now: 100
    ) == .rejected(.browserWindowUnstable) else { return false }

    var boundsFilter = HistoryPrivacyFilter()
    let boundsStable = observation(81, "com.google.Chrome", "Tab")
    _ = boundsFilter.assessDisplay(bounds: display, observations: [boundsStable], now: 100)
    _ = boundsFilter.assessDisplay(bounds: display, observations: [boundsStable], now: 100)
    guard boundsFilter.assessDisplay(
        bounds: display,
        observations: [observation(
            81,
            "com.google.Chrome",
            "Tab",
            100,
            CGRect(x: 0, y: 0, width: 999, height: 800)
        )],
        now: 100
    ) == .rejected(.browserWindowUnstable) else { return false }

    var seededFilter = HistoryPrivacyFilter()
    seededFilter.seedBrowserObservations(
        ["82": HistoryScreenCaptureChildBrowserObservation(
            signature: "old-signature",
            stableObservations: 3
        )],
        at: 100
    )
    guard seededFilter.assessDisplay(
        bounds: display,
        observations: [observation(82, "com.google.Chrome", "Tab")],
        now: 100
    ) == .rejected(.browserWindowUnstable) else { return false }

    let safe = observation(90, "com.example.editor", "Untitled document")
    var safeFilter = HistoryPrivacyFilter()
    guard safeFilter.assessDisplay(bounds: display, observations: [safe], now: 100) == .allowed else {
        return false
    }

    let outside = observation(91, "com.google.Chrome", "Private Browsing", 100, CGRect(x: 2_000, y: 0, width: 800, height: 600))
    guard safeFilter.assessDisplay(bounds: display, observations: [outside], now: 100) == .allowed else {
        return false
    }

    var mixedFilter = HistoryPrivacyFilter()
    let mixedSafe = observation(92, "com.example.editor", "Document")
    let mixedPrivate = observation(93, "com.google.Chrome", "Private (Incognito)")
    guard mixedFilter.assessDisplay(bounds: display, observations: [mixedSafe, mixedPrivate], now: 100)
        == .rejected(.chromeIncognitoTitle) else { return false }

    var displayOneFilter = HistoryPrivacyFilter()
    let displayTwo = CGRect(x: 1_920, y: 0, width: 1_920, height: 1_080)
    let displayOneSafe = observation(94, "com.example.editor", "Document", 100, display)
    let displayTwoPrivate = observation(95, "com.google.Chrome", "Private (Incognito)", 100, displayTwo)
    guard displayOneFilter.assessDisplay(
        bounds: display,
        observations: [displayOneSafe],
        now: 100
    ) == .allowed,
        displayOneFilter.assessDisplay(
            bounds: displayTwo,
            observations: [displayTwoPrivate],
            now: 100
        ) == .rejected(.chromeIncognitoTitle) else { return false }
    return true
}
