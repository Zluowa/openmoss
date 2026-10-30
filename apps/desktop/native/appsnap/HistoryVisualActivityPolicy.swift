import CoreGraphics
import Foundation

/// The native history helper keeps only this fixed-size grayscale fingerprint
/// while deciding whether a captured frame is evidence. The source image is
/// never retained by this value.
struct HistoryVisualFingerprint: Equatable {
    static let dimension = 16
    static let sampleCount = dimension * dimension
    static let redWeight = 77
    static let greenWeight = 150
    static let blueWeight = 29
    static let materialDifferenceThreshold = 4.0

    let grayscaleValues: [UInt8]

    init?(grayscaleValues: [UInt8]) {
        guard grayscaleValues.count == Self.sampleCount else { return nil }
        self.grayscaleValues = grayscaleValues
    }

    /// Creates the same nearest-neighbor 16x16 grid used by the policy from a
    /// tightly packed RGBA source. This overload is intentionally pure so the
    /// helper self-test can exercise the reduction without Screen Recording.
    static func fromRGBA(
        width: Int,
        height: Int,
        rgbaBytes: [UInt8]
    ) -> HistoryVisualFingerprint? {
        guard width > 0, height > 0 else { return nil }
        let pixelCount = width.multipliedReportingOverflow(by: height)
        guard !pixelCount.overflow else { return nil }
        let byteCount = pixelCount.partialValue.multipliedReportingOverflow(by: 4)
        guard !byteCount.overflow,
              rgbaBytes.count >= byteCount.partialValue else {
            return nil
        }

        var values = [UInt8]()
        values.reserveCapacity(Self.sampleCount)
        for y in 0..<Self.dimension {
            let sourceY = min(height - 1, (y * height) / Self.dimension)
            for x in 0..<Self.dimension {
                let sourceX = min(width - 1, (x * width) / Self.dimension)
                let pixelOffset = (sourceY * width + sourceX) * 4
                values.append(grayscale(
                    red: rgbaBytes[pixelOffset],
                    green: rgbaBytes[pixelOffset + 1],
                    blue: rgbaBytes[pixelOffset + 2]
                ))
            }
        }
        return HistoryVisualFingerprint(grayscaleValues: values)
    }

    /// Reduces a captured CGImage into the fixed grid. The short-lived bitmap
    /// context is the only intermediate image allocation; callers must keep
    /// the returned fingerprint and release the source image immediately.
    static func fromFrame(_ image: CGImage) -> HistoryVisualFingerprint? {
        guard image.width > 0, image.height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil,
                  width: Self.dimension,
                  height: Self.dimension,
                  bitsPerComponent: 8,
                  bytesPerRow: Self.dimension * 4,
                  space: colorSpace,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            return nil
        }

        context.interpolationQuality = .none
        context.draw(
            image,
            in: CGRect(
                x: 0,
                y: 0,
                width: Self.dimension,
                height: Self.dimension
            )
        )
        guard let data = context.data else { return nil }
        let byteCount = Self.sampleCount * 4
        let rgbaBytes = data.bindMemory(to: UInt8.self, capacity: byteCount)
        return fromRGBA(
            width: Self.dimension,
            height: Self.dimension,
            rgbaBytes: Array(UnsafeBufferPointer(start: rgbaBytes, count: byteCount))
        )
    }

    static func meanAbsoluteByteDifference(
        between left: HistoryVisualFingerprint,
        and right: HistoryVisualFingerprint
    ) -> Double {
        let total = zip(left.grayscaleValues, right.grayscaleValues).reduce(into: 0) {
            $0 += abs(Int($1.0) - Int($1.1))
        }
        return Double(total) / Double(Self.sampleCount)
    }

    static func isMaterialChange(
        between left: HistoryVisualFingerprint,
        and right: HistoryVisualFingerprint
    ) -> Bool {
        meanAbsoluteByteDifference(between: left, and: right) >= Self.materialDifferenceThreshold
    }

    private static func grayscale(red: UInt8, green: UInt8, blue: UInt8) -> UInt8 {
        UInt8((Self.redWeight * Int(red) + Self.greenWeight * Int(green) + Self.blueWeight * Int(blue)) >> 8)
    }
}

func runHistoryVisualActivityPolicySelfTest() -> Bool {
    let redPixel: [UInt8] = [255, 0, 0, 255]
    let greenPixel: [UInt8] = [0, 255, 0, 255]
    let bluePixel: [UInt8] = [0, 0, 255, 255]
    let whitePixel: [UInt8] = [255, 255, 255, 255]
    let quadrantBytes = redPixel + greenPixel + bluePixel + whitePixel
    guard let quadrants = HistoryVisualFingerprint.fromRGBA(
        width: 2,
        height: 2,
        rgbaBytes: quadrantBytes
    ), quadrants.grayscaleValues.count == HistoryVisualFingerprint.sampleCount else {
        return false
    }
    guard let provider = CGDataProvider(data: Data(quadrantBytes) as CFData),
          let image = CGImage(
              width: 2,
              height: 2,
              bitsPerComponent: 8,
              bitsPerPixel: 32,
              bytesPerRow: 2 * 4,
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
              provider: provider,
              decode: nil,
              shouldInterpolate: false,
              intent: .defaultIntent
          ),
          let frameFingerprint = HistoryVisualFingerprint.fromFrame(image),
          frameFingerprint == quadrants else {
        return false
    }
    let redValue = UInt8((HistoryVisualFingerprint.redWeight * 255) >> 8)
    let greenValue = UInt8((HistoryVisualFingerprint.greenWeight * 255) >> 8)
    let blueValue = UInt8((HistoryVisualFingerprint.blueWeight * 255) >> 8)
    guard quadrants.grayscaleValues[0] == redValue,
          quadrants.grayscaleValues[7] == redValue,
          quadrants.grayscaleValues[8] == greenValue,
          quadrants.grayscaleValues[127] == greenValue,
          quadrants.grayscaleValues[128] == blueValue,
          quadrants.grayscaleValues[247] == blueValue,
          quadrants.grayscaleValues[248] == 255,
          quadrants.grayscaleValues[255] == 255 else {
        return false
    }

    guard let zero = HistoryVisualFingerprint(
        grayscaleValues: [UInt8](repeating: 0, count: HistoryVisualFingerprint.sampleCount)
    ), let visual = HistoryVisualFingerprint(
        grayscaleValues: [UInt8](repeating: 4, count: HistoryVisualFingerprint.sampleCount)
    ), let incremental = HistoryVisualFingerprint(
        grayscaleValues: [UInt8](repeating: 2, count: HistoryVisualFingerprint.sampleCount)
    ) else {
        return false
    }
    var belowThreshold = [UInt8](repeating: 4, count: HistoryVisualFingerprint.sampleCount)
    belowThreshold[0] = 3
    guard let below = HistoryVisualFingerprint(grayscaleValues: belowThreshold),
          HistoryVisualFingerprint.meanAbsoluteByteDifference(
              between: zero,
              and: below
          ) < HistoryVisualFingerprint.materialDifferenceThreshold,
          !HistoryVisualFingerprint.isMaterialChange(between: zero, and: below),
          HistoryVisualFingerprint.meanAbsoluteByteDifference(
              between: zero,
              and: visual
          ) == HistoryVisualFingerprint.materialDifferenceThreshold,
          HistoryVisualFingerprint.isMaterialChange(between: zero, and: visual) else {
        return false
    }

    guard HistoryVisualActivityState.current.rawValue == "Current",
          HistoryVisualActivityState.current.code == 4,
          HistoryVisualEvidenceReason.firstFrame.rawValue == "FirstFrame",
          HistoryVisualEvidenceReason.firstFrame.code == 0,
          HistoryVisualEvidenceReason.visualChange.rawValue == "VisualChange",
          HistoryVisualEvidenceReason.visualChange.code == 1,
          HistoryVisualEvidenceReason.heartbeat.rawValue == "Heartbeat",
          HistoryVisualEvidenceReason.heartbeat.code == 2,
          HistoryVisualEvidenceReason.minuteBucket.rawValue == "MinuteBucket",
          HistoryVisualEvidenceReason.minuteBucket.code == 3 else {
        return false
    }

    var cadence = HistoryVisualActivityPolicy()
    let first = cadence.recordCapture(fingerprint: zero, monotonicAt: 0, wallClockAt: 0, duration: 0)
    let unchangedOne = cadence.recordCapture(fingerprint: zero, monotonicAt: 5, wallClockAt: 5, duration: 0)
    let unchangedTwo = cadence.recordCapture(fingerprint: zero, monotonicAt: 20, wallClockAt: 20, duration: 0)
    let unchangedThree = cadence.recordCapture(fingerprint: zero, monotonicAt: 35, wallClockAt: 35, duration: 0)
    guard first.state == .evidence(.firstFrame), first.nextDelay == 5,
          unchangedOne.state == .current, unchangedOne.nextDelay == 15,
          unchangedTwo.state == .current, unchangedTwo.nextDelay == 15,
          unchangedThree.state == .current, unchangedThree.nextDelay == 30,
          unchangedOne.evidenceReason == nil else {
        return false
    }

    var visualPolicy = HistoryVisualActivityPolicy()
    _ = visualPolicy.recordCapture(fingerprint: zero, monotonicAt: 0, wallClockAt: 0, duration: 0)
    let visualChange = visualPolicy.recordCapture(fingerprint: visual, monotonicAt: 5, wallClockAt: 5, duration: 0)
    guard visualChange.state == .evidence(.visualChange),
          visualChange.evidenceReason != nil else {
        return false
    }

    var accumulatedPolicy = HistoryVisualActivityPolicy()
    _ = accumulatedPolicy.recordCapture(fingerprint: zero, monotonicAt: 0, wallClockAt: 0, duration: 0)
    let accumulatedCurrent = accumulatedPolicy.recordCapture(
        fingerprint: incremental,
        monotonicAt: 5,
        wallClockAt: 5,
        duration: 0
    )
    let accumulatedChange = accumulatedPolicy.recordCapture(
        fingerprint: visual,
        monotonicAt: 20,
        wallClockAt: 20,
        duration: 0
    )
    guard accumulatedCurrent.state == .current,
          accumulatedChange.state == .evidence(.visualChange),
          accumulatedChange.nextDelay == 5 else {
        return false
    }

    var heartbeatPolicy = HistoryVisualActivityPolicy()
    _ = heartbeatPolicy.recordCapture(fingerprint: zero, monotonicAt: 0, wallClockAt: 120, duration: 0)
    let heartbeat = heartbeatPolicy.recordCapture(fingerprint: zero, monotonicAt: 60, wallClockAt: 120, duration: 0)
    guard heartbeat.state == .evidence(.heartbeat) else { return false }

    var minutePolicy = HistoryVisualActivityPolicy()
    _ = minutePolicy.recordCapture(fingerprint: zero, monotonicAt: 0, wallClockAt: 59, duration: 0)
    let minute = minutePolicy.recordCapture(fingerprint: zero, monotonicAt: 5, wallClockAt: 60, duration: 0)
    guard minute.state == .evidence(.minuteBucket) else { return false }

    var wallJumpPolicy = HistoryVisualActivityPolicy()
    _ = wallJumpPolicy.recordCapture(fingerprint: zero, monotonicAt: 0, wallClockAt: 120, duration: 0)
    let wallJump = wallJumpPolicy.recordCapture(fingerprint: zero, monotonicAt: 5, wallClockAt: 3_600, duration: 0)
    guard wallJump.state == .evidence(.minuteBucket),
          wallJump.state != .evidence(.heartbeat) else { return false }

    var recentInputPolicy = HistoryVisualActivityPolicy()
    _ = recentInputPolicy.recordCapture(fingerprint: zero, monotonicAt: 0, wallClockAt: 0, duration: 0)
    let recentInput = recentInputPolicy.recordCapture(
        fingerprint: zero,
        monotonicAt: 5,
        wallClockAt: 5,
        duration: 0,
        recentUserInput: true
    )
    guard recentInput.nextDelay == 1 else { return false }

    var slowPolicy = HistoryVisualActivityPolicy()
    _ = slowPolicy.recordCapture(fingerprint: zero, monotonicAt: 0, wallClockAt: 0, duration: 0)
    let slowCapture = slowPolicy.recordCapture(fingerprint: zero, monotonicAt: 5, wallClockAt: 5, duration: 1.5001)
    guard slowCapture.nextDelay == 30 else { return false }

    var failurePolicy = HistoryVisualActivityPolicy()
    let failure = failurePolicy.recordFailure(at: 5)
    guard failure.state == .current, failure.nextDelay == 60 else { return false }

    var idlePolicy = HistoryVisualActivityPolicy()
    guard !idlePolicy.handleIdlePoll(idleSeconds: nil),
          !idlePolicy.samplingPaused,
          !idlePolicy.handleIdlePoll(idleSeconds: 299),
          idlePolicy.handleIdlePoll(idleSeconds: 300),
          !idlePolicy.handleIdlePoll(idleSeconds: 299) else {
        return false
    }
    return true
}

enum HistoryVisualEvidenceReason: String, Equatable {
    case firstFrame = "FirstFrame"
    case visualChange = "VisualChange"
    case heartbeat = "Heartbeat"
    case minuteBucket = "MinuteBucket"

    var code: Int {
        switch self {
        case .firstFrame: return 0
        case .visualChange: return 1
        case .heartbeat: return 2
        case .minuteBucket: return 3
        }
    }
}

enum HistoryVisualActivityState: Equatable {
    case current
    case evidence(HistoryVisualEvidenceReason)

    var rawValue: String {
        switch self {
        case .current:
            return "Current"
        case let .evidence(reason):
            return reason.rawValue
        }
    }

    var code: Int {
        switch self {
        case .current: return 4
        case let .evidence(reason): return reason.code
        }
    }
}

struct HistoryVisualCaptureDecision: Equatable {
    let state: HistoryVisualActivityState
    let nextDelay: TimeInterval

    var evidenceReason: HistoryVisualEvidenceReason? {
        guard case let .evidence(reason) = state else { return nil }
        return reason
    }
}

/// Pure state machine recovered from the frozen native behavior. It decides
/// evidence and the next bounded sample delay but has no timers, permissions,
/// persistence, or UI dependencies.
struct HistoryVisualActivityPolicy {
    static let materialDifferenceThreshold = 4.0
    static let heartbeatInterval: TimeInterval = 60.0
    static let recentInputDelay: TimeInterval = 1.0
    static let firstUnchangedDelay: TimeInterval = 5.0
    static let repeatedUnchangedDelay: TimeInterval = 15.0
    static let settledUnchangedDelay: TimeInterval = 30.0
    static let slowCaptureThreshold: TimeInterval = 1.5
    static let failureDelay: TimeInterval = 60.0
    static let idlePauseThreshold: TimeInterval = 300.0

    private(set) var previousFingerprint: HistoryVisualFingerprint?
    private(set) var lastEvidenceFingerprint: HistoryVisualFingerprint?
    private(set) var unchangedStreak = 0
    private(set) var lastEvidenceMonotonicAt: TimeInterval?
    private(set) var lastMinuteBucket: Int?
    private(set) var samplingPaused = false

    static func cadenceDelay(for unchangedStreak: Int) -> TimeInterval {
        switch unchangedStreak {
        case ...0:
            return firstUnchangedDelay
        case 1...2:
            return repeatedUnchangedDelay
        default:
            return settledUnchangedDelay
        }
    }

    mutating func handleIdlePoll(idleSeconds: TimeInterval?) -> Bool {
        guard let idleSeconds else {
            // An unavailable idle query must fail open: do not invent a
            // 300-second idle state or request another privacy permission.
            samplingPaused = false
            return false
        }
        samplingPaused = idleSeconds >= Self.idlePauseThreshold
        return samplingPaused
    }

    mutating func recordCapture(
        fingerprint: HistoryVisualFingerprint,
        monotonicAt: TimeInterval,
        wallClockAt: TimeInterval,
        duration: TimeInterval,
        recentUserInput: Bool = false
    ) -> HistoryVisualCaptureDecision {
        let minuteBucket = Int(floor(wallClockAt / 60.0))
        let state: HistoryVisualActivityState

        if let previousFingerprint {
            let changedFromPrevious = HistoryVisualFingerprint.isMaterialChange(
                between: previousFingerprint,
                and: fingerprint
            )
            if changedFromPrevious {
                unchangedStreak = 0
            } else {
                unchangedStreak += 1
            }

            if let lastEvidenceFingerprint,
               HistoryVisualFingerprint.isMaterialChange(
                   between: lastEvidenceFingerprint,
                   and: fingerprint
               ) {
                state = .evidence(.visualChange)
            } else if let lastEvidenceMonotonicAt,
                      monotonicAt - lastEvidenceMonotonicAt >= Self.heartbeatInterval {
                state = .evidence(.heartbeat)
            } else if let lastMinuteBucket, lastMinuteBucket != minuteBucket {
                state = .evidence(.minuteBucket)
            } else {
                state = .current
            }
        } else {
            state = .evidence(.firstFrame)
            unchangedStreak = 0
        }

        previousFingerprint = fingerprint
        lastMinuteBucket = minuteBucket
        if state == .evidence(.visualChange) {
            unchangedStreak = 0
        }
        if case .evidence = state {
            lastEvidenceMonotonicAt = monotonicAt
            lastEvidenceFingerprint = fingerprint
        }

        return HistoryVisualCaptureDecision(
            state: state,
            nextDelay: nextDelay(
                duration: duration,
                recentUserInput: recentUserInput,
                failed: false
            )
        )
    }

    mutating func recordFailure(at _: TimeInterval) -> HistoryVisualCaptureDecision {
        HistoryVisualCaptureDecision(state: .current, nextDelay: Self.failureDelay)
    }

    private func nextDelay(
        duration: TimeInterval,
        recentUserInput: Bool,
        failed: Bool
    ) -> TimeInterval {
        if failed { return Self.failureDelay }
        if duration > Self.slowCaptureThreshold { return Self.settledUnchangedDelay }
        if recentUserInput { return Self.recentInputDelay }
        return Self.cadenceDelay(for: unchangedStreak)
    }
}
