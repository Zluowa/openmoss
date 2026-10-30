import CoreGraphics
import Darwin
import Foundation

#if canImport(AppKit)
import AppKit
#endif

private let historyScreenCaptureChildLineLimit = 16 * 1024
private let historyScreenCaptureChildTimeoutSeconds: TimeInterval = 6
private let historyScreenCaptureChildGraceSeconds: TimeInterval = 0.25
private let historyScreenCaptureMaximumDimension = 32_768
private let historyScreenCaptureMaximumFrameBytes = 64 * 1024 * 1024

struct HistoryScreenCaptureChildGeometry: Equatable {
    let width: Int
    let height: Int
}

struct HistoryScreenCaptureChildBrowserObservation: Equatable {
    let signature: String
    let stableObservations: Int
}

/// The child receives only the browser stability snapshot. Target window
/// attribution remains in the parent and is intentionally never sent over the
/// whole-display wire.
struct HistoryScreenCaptureChildPrivacyFilter: Equatable {
    let browserObservations: [String: HistoryScreenCaptureChildBrowserObservation]
}

enum HistoryScreenCaptureChildCommand: Equatable {
    case listDisplays
    case captureScreenshot(
        displayID: String,
        privacyFilter: HistoryScreenCaptureChildPrivacyFilter
    )
}

enum HistoryScreenCaptureChildParseError: Error, Equatable {
    case invalidJSON
    case objectRequired
    case unknownFields
    case missingField(String)
    case invalidField(String)
    case unsupportedCommand
}

enum HistoryDisplayCaptureFailure: Error, Equatable {
    case privacyDenied(HistoryPrivacyRejectionReason)
    case privacyUnknown
    case captureUnavailable
    case fingerprintFailed
    case deadlineExceeded
    case spawnFailed
    case childExited
    case pipeClosed
    case invalidResponse
    case shortFrame
    case trailingBytes
    case frameTooLarge
    case cancelled
}

/// Raw RGB exists only while the child response is being reduced to the fixed
/// 16x16 fingerprint. It is never part of a supervisor result.
private struct HistoryDisplayFrame {
    let width: Int
    let height: Int
    let rgbBytes: Data
}

struct HistoryDisplayCaptureResult {
    let descriptor: HistoryDisplayDescriptor
    let fingerprint: HistoryVisualFingerprint
}

private func historyJSONNumber(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFNumberGetTypeID(),
          number.doubleValue.isFinite,
          number.doubleValue.rounded() == number.doubleValue,
          number.doubleValue >= Double(Int.min),
          number.doubleValue <= Double(Int.max) else { return nil }
    return number.intValue
}

private func historyJSONUnsignedString(_ value: Any?) -> String? {
    guard let value = value as? String,
          !value.isEmpty,
          value.count <= 32,
          let number = UInt64(value),
          number <= UInt64(UInt32.max) else { return nil }
    return value
}

private func historyJSONBoundedString(_ value: Any?, maxLength: Int) -> String? {
    guard let value = value as? String, !value.isEmpty, value.count <= maxLength else { return nil }
    return value
}

private func parseHistoryScreenCaptureChildPrivacyFilter(
    _ value: Any?
) -> Result<HistoryScreenCaptureChildPrivacyFilter, HistoryScreenCaptureChildParseError> {
    guard let object = value as? [String: Any],
          Set(object.keys) == ["browser_observations"],
          let observationsObject = object["browser_observations"] as? [String: Any] else {
        return .failure(.invalidField("privacy_filter"))
    }

    var browserObservations: [String: HistoryScreenCaptureChildBrowserObservation] = [:]
    for (windowID, value) in observationsObject {
        guard historyJSONUnsignedString(windowID) != nil,
              let observation = value as? [String: Any],
              Set(observation.keys) == ["signature", "stable_observations"],
              let signature = historyJSONBoundedString(observation["signature"], maxLength: 1_024),
              let stableObservations = historyJSONNumber(observation["stable_observations"]),
              stableObservations >= 0,
              stableObservations <= 3 else {
            return .failure(.invalidField("browser_observations"))
        }
        browserObservations[windowID] = HistoryScreenCaptureChildBrowserObservation(
            signature: signature,
            stableObservations: stableObservations
        )
    }
    return .success(HistoryScreenCaptureChildPrivacyFilter(browserObservations: browserObservations))
}

func parseHistoryScreenCaptureChildCommand(
    _ data: Data
) -> Result<HistoryScreenCaptureChildCommand, HistoryScreenCaptureChildParseError> {
    guard data.count <= historyScreenCaptureChildLineLimit else {
        return .failure(.invalidField("line"))
    }
    guard let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
        return .failure(.invalidJSON)
    }
    guard let dictionary = object as? [String: Any] else {
        return .failure(.objectRequired)
    }
    guard let command = dictionary["request"] as? String else {
        return .failure(.missingField("request"))
    }
    switch command {
    case "list_displays":
        guard Set(dictionary.keys) == ["request"] else { return .failure(.unknownFields) }
        return .success(.listDisplays)
    case "capture_screenshot":
        let allowedFields: Set<String> = ["request", "display_id", "privacy_filter"]
        guard Set(dictionary.keys) == allowedFields,
              let displayID = historyJSONUnsignedString(dictionary["display_id"]) else {
            return .failure(Set(dictionary.keys).isSubset(of: allowedFields)
                ? .invalidField("capture_screenshot")
                : .unknownFields)
        }
        switch parseHistoryScreenCaptureChildPrivacyFilter(dictionary["privacy_filter"]) {
        case let .failure(error): return .failure(error)
        case let .success(privacyFilter):
            return .success(.captureScreenshot(displayID: displayID, privacyFilter: privacyFilter))
        }
    default:
        return .failure(.unsupportedCommand)
    }
}

private func historyScreenCaptureChildErrorPayload(
    code: String,
    message: String
) -> [String: Any] {
    [
        "status": "err",
        "payload": [
            "code": code,
            "message": message,
        ],
    ]
}

private func historyScreenCaptureChildPrivacyPayload(
    _ filter: HistoryPrivacyFilter
) -> [String: Any] {
    let observations = filter.browserObservationSnapshot().mapValues { observation in
        [
            "signature": observation.signature,
            "stable_observations": observation.stableObservations,
        ]
    }
    return ["browser_observations": observations]
}

private func historyScreenCaptureChildDisplayPayload(
    _ descriptor: HistoryDisplayDescriptor
) -> [String: Any] {
    // Keep this wire identical to the target Display shape: exactly id, name,
    // and a nested geometry object. No bundle/title/window data crosses the
    // helper boundary.
    [
        "id": String(descriptor.displayID),
        "name": historyDisplayName(for: descriptor.displayID),
        "geometry": [
            "width": descriptor.pixelWidth,
            "height": descriptor.pixelHeight,
        ],
    ]
}

private func historyDisplayName(for displayID: CGDirectDisplayID) -> String {
    #if canImport(AppKit)
    let screenNumberKey = NSDeviceDescriptionKey("NSScreenNumber")
    if let screen = NSScreen.screens.first(where: { screen in
        (screen.deviceDescription[screenNumberKey] as? NSNumber)?.uint32Value == displayID
    }) {
        let localizedName = screen.localizedName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !localizedName.isEmpty { return localizedName }
    }
    #endif
    return "Display \(displayID)"
}

private func historyRGBData(from image: CGImage) -> Data? {
    guard image.width > 0,
          image.height > 0,
          image.width <= historyScreenCaptureMaximumDimension,
          image.height <= historyScreenCaptureMaximumDimension else { return nil }
    let pixelCount = image.width.multipliedReportingOverflow(by: image.height)
    let rgbaByteCount = pixelCount.partialValue.multipliedReportingOverflow(by: 4)
    let rgbByteCount = pixelCount.partialValue.multipliedReportingOverflow(by: 3)
    guard !pixelCount.overflow,
          !rgbaByteCount.overflow,
          !rgbByteCount.overflow,
          rgbaByteCount.partialValue <= historyScreenCaptureMaximumFrameBytes * 2,
          rgbByteCount.partialValue <= historyScreenCaptureMaximumFrameBytes,
          pixelCount.partialValue > 0,
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil,
              width: image.width,
              height: image.height,
              bitsPerComponent: 8,
              bytesPerRow: image.width * 4,
              space: colorSpace,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else { return nil }

    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    guard let pointer = context.data else { return nil }
    let pixelCountValue = pixelCount.partialValue
    let rgba = UnsafeBufferPointer(
        start: pointer.assumingMemoryBound(to: UInt8.self),
        count: rgbaByteCount.partialValue
    )
    var rgb = Data(count: rgbByteCount.partialValue)
    rgb.withUnsafeMutableBytes { destination in
        guard let destinationBase = destination.baseAddress else { return }
        let output = destinationBase.assumingMemoryBound(to: UInt8.self)
        for index in 0..<pixelCountValue {
            output[index * 3] = rgba[index * 4]
            output[index * 3 + 1] = rgba[index * 4 + 1]
            output[index * 3 + 2] = rgba[index * 4 + 2]
        }
    }
    return rgb
}

private func historyFingerprintFromRGB(
    width: Int,
    height: Int,
    rgbBytes: Data
) -> HistoryVisualFingerprint? {
    guard width > 0,
          height > 0,
          width <= historyScreenCaptureMaximumDimension,
          height <= historyScreenCaptureMaximumDimension else { return nil }
    let pixelCount = width.multipliedReportingOverflow(by: height)
    let byteCount = pixelCount.partialValue.multipliedReportingOverflow(by: 3)
    guard !pixelCount.overflow,
          !byteCount.overflow,
          byteCount.partialValue == rgbBytes.count,
          byteCount.partialValue <= historyScreenCaptureMaximumFrameBytes else { return nil }

    var rgba = [UInt8]()
    rgba.reserveCapacity(HistoryVisualFingerprint.sampleCount * 4)
    rgbBytes.withUnsafeBytes { source in
        guard let sourceBase = source.baseAddress else { return }
        let input = sourceBase.assumingMemoryBound(to: UInt8.self)
        for y in 0..<HistoryVisualFingerprint.dimension {
            let sourceY = min(height - 1, (y * height) / HistoryVisualFingerprint.dimension)
            for x in 0..<HistoryVisualFingerprint.dimension {
                let sourceX = min(width - 1, (x * width) / HistoryVisualFingerprint.dimension)
                let index = (sourceY * width + sourceX) * 3
                rgba.append(input[index])
                rgba.append(input[index + 1])
                rgba.append(input[index + 2])
                rgba.append(255)
            }
        }
    }
    return HistoryVisualFingerprint.fromRGBA(
        width: HistoryVisualFingerprint.dimension,
        height: HistoryVisualFingerprint.dimension,
        rgbaBytes: rgba
    )
}

private func captureHistoryDisplayFrameSafely(
    descriptor: HistoryDisplayDescriptor,
    observations: [HistoryDisplayWindowObservation]?,
    filter: inout HistoryPrivacyFilter,
    requestedPrivacyFilter: HistoryScreenCaptureChildPrivacyFilter,
    now: TimeInterval,
    deadlineMilliseconds: Int,
    imageProvider: () -> CGImage?,
    clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
) -> Result<HistoryDisplayFrame, HistoryDisplayCaptureFailure> {
    guard let observations else { return .failure(.privacyUnknown) }

    // Seed is only a previous local stability snapshot. assessDisplay always
    // re-reads and validates every visible window, including private/video/
    // unknown/unsupported browser windows, before a full-display cadence tick.
    filter.seedBrowserObservations(requestedPrivacyFilter.browserObservations, at: now)
    let privacyDecision = filter.assessDisplay(
        bounds: descriptor.bounds,
        observations: observations,
        now: now
    )
    guard case .allowed = privacyDecision else {
        if case let .rejected(reason) = privacyDecision {
            return .failure(.privacyDenied(reason))
        }
        return .failure(.privacyUnknown)
    }

    let startedAt = clock()
    guard let image = imageProvider(),
          let rgbBytes = historyRGBData(from: image) else {
        return .failure(.captureUnavailable)
    }
    // The CGImage and RGB buffer are local to this reduction call. The caller
    // must reduce the returned frame immediately and never pass it to OCR.
    guard (clock() - startedAt) * 1_000 <= Double(deadlineMilliseconds) else {
        return .failure(.deadlineExceeded)
    }
    return .success(HistoryDisplayFrame(width: image.width, height: image.height, rgbBytes: rgbBytes))
}

/// Compatibility reducer used by the visual self-test. Production receives
/// only the fixed fingerprint from the display supervisor.
func captureHistoryDisplaySafely(
    descriptor: HistoryDisplayDescriptor,
    observations: [HistoryDisplayWindowObservation]?,
    filter: inout HistoryPrivacyFilter,
    now: TimeInterval,
    deadlineMilliseconds: Int,
    imageProvider: () -> CGImage?,
    clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
) -> Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure> {
    let request = HistoryScreenCaptureChildPrivacyFilter(browserObservations: [:])
    switch captureHistoryDisplayFrameSafely(
        descriptor: descriptor,
        observations: observations,
        filter: &filter,
        requestedPrivacyFilter: request,
        now: now,
        deadlineMilliseconds: deadlineMilliseconds,
        imageProvider: imageProvider,
        clock: clock
    ) {
    case let .failure(error): return .failure(error)
    case let .success(frame):
        guard let fingerprint = historyFingerprintFromRGB(
            width: frame.width,
            height: frame.height,
            rgbBytes: frame.rgbBytes
        ) else { return .failure(.fingerprintFailed) }
        return .success(fingerprint)
    }
}

private func emitHistoryScreenCaptureChildPayload(
    _ payload: [String: Any],
    to output: FileHandle
) {
    guard JSONSerialization.isValidJSONObject(payload),
          var data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
        return
    }
    data.append(0x0a)
    try? output.write(contentsOf: data)
}

private func emitHistoryScreenCaptureChildFrame(
    _ frame: HistoryDisplayFrame,
    to output: FileHandle
) {
    try? output.write(contentsOf: frame.rgbBytes)
}

/// The child uses strict JSONL plus a bounded raw-frame response. The raw
/// frame is reduced to a fixed fingerprint in the parent supervisor and never
/// reaches semantic OCR/model code or a persistent history observation.
func runHistoryScreenCaptureChildProtocol(
    input: FileHandle = .standardInput,
    output: FileHandle = .standardOutput,
    displayProvider: () -> [HistoryDisplayDescriptor] = historyActiveDisplayDescriptors,
    imageProvider: (CGDirectDisplayID) -> CGImage? = { CGDisplayCreateImage($0) },
    windowObservationProvider: (CGDirectDisplayID, TimeInterval) -> [HistoryDisplayWindowObservation]? = {
        historyDisplayWindowObservations(displayID: $0, now: $1)
    },
    clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
) {
    var inputBuffer = Data()
    var privacyFilters: [CGDirectDisplayID: HistoryPrivacyFilter] = [:]
    while true {
        guard let chunk = try? input.read(upToCount: 16 * 1024), !chunk.isEmpty else { break }
        inputBuffer.append(chunk)
        if inputBuffer.count > historyScreenCaptureChildLineLimit {
            emitHistoryScreenCaptureChildPayload(
                historyScreenCaptureChildErrorPayload(
                    code: "line_too_large",
                    message: "The child command line exceeds the bounded protocol limit."
                ),
                to: output
            )
            inputBuffer.removeAll(keepingCapacity: false)
            continue
        }
        while let newline = inputBuffer.firstIndex(of: 0x0a) {
            let line = Data(inputBuffer.prefix(upTo: newline))
            inputBuffer.removeSubrange(...newline)
            guard !line.isEmpty else {
                emitHistoryScreenCaptureChildPayload(
                    historyScreenCaptureChildErrorPayload(code: "invalid_json", message: "Empty command line."),
                    to: output
                )
                continue
            }
            switch parseHistoryScreenCaptureChildCommand(line) {
            case let .failure(error):
                emitHistoryScreenCaptureChildPayload(
                    historyScreenCaptureChildErrorPayload(
                        code: "invalid_request",
                        message: String(describing: error)
                    ),
                    to: output
                )
            case let .success(command):
                switch command {
                case .listDisplays:
                    emitHistoryScreenCaptureChildPayload([
                        "status": "ok",
                        "payload": displayProvider().map(historyScreenCaptureChildDisplayPayload),
                    ], to: output)
                case let .captureScreenshot(displayIDString, requestedPrivacyFilter):
                    guard let displayNumber = UInt32(displayIDString),
                          let descriptor = displayProvider().first(where: { $0.displayID == displayNumber }) else {
                        emitHistoryScreenCaptureChildPayload(
                            historyScreenCaptureChildErrorPayload(
                                code: "display_unavailable",
                                message: "Display is unavailable."
                            ),
                            to: output
                        )
                        continue
                    }
                    var privacyFilter = privacyFilters[displayNumber] ?? HistoryPrivacyFilter()
                    let now = clock()
                    let capture = captureHistoryDisplayFrameSafely(
                        descriptor: descriptor,
                        observations: windowObservationProvider(displayNumber, now),
                        filter: &privacyFilter,
                        requestedPrivacyFilter: requestedPrivacyFilter,
                        now: now,
                        deadlineMilliseconds: Int(historyScreenCaptureChildTimeoutSeconds * 1_000),
                        imageProvider: { imageProvider(displayNumber) },
                        clock: clock
                    )
                    privacyFilters[displayNumber] = privacyFilter
                    guard case let .success(frame) = capture else {
                        let (code, message): (String, String)
                        switch capture {
                        case .failure(.privacyDenied(let reason)):
                            (code, message) = ("privacy_denied", reason.rawValue)
                        case .failure(.privacyUnknown):
                            (code, message) = ("privacy_unknown", "Display privacy could not be established.")
                        case .failure(.captureUnavailable):
                            (code, message) = ("capture_failed", "Display capture failed closed.")
                        case .failure(.deadlineExceeded):
                            (code, message) = ("capture_timed_out", "Display capture exceeded its deadline.")
                        default:
                            (code, message) = ("capture_failed", "Display capture failed closed.")
                        }
                        emitHistoryScreenCaptureChildPayload(
                            historyScreenCaptureChildErrorPayload(code: code, message: message),
                            to: output
                        )
                        continue
                    }
                    emitHistoryScreenCaptureChildPayload([
                        "status": "ok",
                        "payload": [
                            "safe_to_persist": true,
                            "width": frame.width,
                            "height": frame.height,
                            "privacy_filter": historyScreenCaptureChildPrivacyPayload(privacyFilter),
                        ],
                    ], to: output)
                    emitHistoryScreenCaptureChildFrame(frame, to: output)
                }
            }
        }
    }
    if !inputBuffer.isEmpty {
        emitHistoryScreenCaptureChildPayload(
            historyScreenCaptureChildErrorPayload(
                code: "invalid_json",
                message: "The final command line was not newline terminated."
            ),
            to: output
        )
    }
}

private func parseHistoryScreenCaptureChildMetadata(
    _ metadata: Data
) -> Result<(width: Int, height: Int), HistoryDisplayCaptureFailure> {
    guard let object = try? JSONSerialization.jsonObject(with: metadata),
          let response = object as? [String: Any],
          Set(response.keys) == ["payload", "status"],
          response["status"] as? String == "ok",
          let payload = response["payload"] as? [String: Any],
          Set(payload.keys) == ["height", "privacy_filter", "safe_to_persist", "width"],
          (payload["safe_to_persist"] as? Bool) == true,
          let width = historyJSONNumber(payload["width"]),
          let height = historyJSONNumber(payload["height"]),
          width > 0,
          height > 0,
          width <= historyScreenCaptureMaximumDimension,
          height <= historyScreenCaptureMaximumDimension,
          let privacyFilter = payload["privacy_filter"] as? [String: Any],
          Set(privacyFilter.keys) == ["browser_observations"],
          privacyFilter["browser_observations"] is [String: Any] else {
        return .failure(.invalidResponse)
    }
    let pixelCount = width.multipliedReportingOverflow(by: height)
    let rgbByteCount = pixelCount.partialValue.multipliedReportingOverflow(by: 3)
    guard !pixelCount.overflow,
          !rgbByteCount.overflow,
          rgbByteCount.partialValue <= historyScreenCaptureMaximumFrameBytes else {
        return .failure(.frameTooLarge)
    }
    return .success((width: width, height: height))
}

private func readHistoryScreenCaptureChildResponse(
    from output: FileHandle
) -> Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure> {
    var metadataBuffer = Data()
    while metadataBuffer.firstIndex(of: 0x0a) == nil {
        guard let chunk = try? output.read(upToCount: 4 * 1024),
              !chunk.isEmpty else {
            return .failure(.pipeClosed)
        }
        metadataBuffer.append(chunk)
        guard metadataBuffer.count <= historyScreenCaptureChildLineLimit + 1 else {
            return .failure(.invalidResponse)
        }
    }
    guard let newline = metadataBuffer.firstIndex(of: 0x0a) else {
        return .failure(.invalidResponse)
    }
    let metadata = Data(metadataBuffer.prefix(upTo: newline))
    let parsedMetadata: (width: Int, height: Int)
    switch parseHistoryScreenCaptureChildMetadata(metadata) {
    case let .failure(error): return .failure(error)
    case let .success(value): parsedMetadata = value
    }

    let pixelCount = parsedMetadata.width * parsedMetadata.height
    let expectedByteCount = pixelCount * 3
    guard expectedByteCount <= historyScreenCaptureMaximumFrameBytes else {
        return .failure(.frameTooLarge)
    }
    var frameBytes = Data(metadataBuffer.dropFirst(newline + 1))
    guard frameBytes.count <= expectedByteCount else { return .failure(.trailingBytes) }
    while frameBytes.count < expectedByteCount {
        let remaining = expectedByteCount - frameBytes.count
        guard let chunk = try? output.read(upToCount: min(4 * 1024, remaining)),
              !chunk.isEmpty else {
            return .failure(.shortFrame)
        }
        frameBytes.append(chunk)
        guard frameBytes.count <= expectedByteCount else { return .failure(.trailingBytes) }
    }
    if let trailing = try? output.read(upToCount: 1), !trailing.isEmpty {
        return .failure(.trailingBytes)
    }
    guard let fingerprint = historyFingerprintFromRGB(
        width: parsedMetadata.width,
        height: parsedMetadata.height,
        rgbBytes: frameBytes
    ) else { return .failure(.fingerprintFailed) }
    // frameBytes is released as this function returns; only the fixed grid
    // crosses the process boundary.
    return .success(fingerprint)
}

/// A child is considered finished only after its process has exited. Timeout,
/// cancellation, hot-unplug and stop all use TERM, bounded grace, SIGKILL,
/// waitUntilExit, then one poisoned completion.
private final class HistoryDisplayChildProcess {
    typealias Completion = (Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure>) -> Void

    private let executableURL: URL
    private let arguments: [String]
    private let request: Data
    private let timeout: TimeInterval
    private let completion: Completion
    private let lock = NSLock()
    private var process: Process?
    private var outputHandle: FileHandle?
    private var inputHandle: FileHandle?
    private var requestedResult: Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure>?
    private var waitingForExit = false
    private var delivered = false

    init(
        executableURL: URL,
        arguments: [String],
        request: Data,
        timeout: TimeInterval,
        completion: @escaping Completion
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.request = request
        self.timeout = timeout
        self.completion = completion
    }

    func start() {
        let input = Pipe()
        let output = Pipe()
        let child = Process()
        child.executableURL = executableURL
        child.arguments = arguments
        child.standardInput = input
        child.standardOutput = output
        child.standardError = FileHandle.standardError
        lock.lock()
        inputHandle = input.fileHandleForWriting
        outputHandle = output.fileHandleForReading
        process = child
        lock.unlock()
        do {
            try child.run()
        } catch {
            lock.lock()
            process = nil
            let failedInput = inputHandle
            let failedOutput = outputHandle
            inputHandle = nil
            outputHandle = nil
            lock.unlock()
            try? failedInput?.close()
            try? failedOutput?.close()
            requestFinish(.failure(.spawnFailed), terminate: false)
            return
        }
        do {
            try input.fileHandleForWriting.write(contentsOf: request)
            try input.fileHandleForWriting.close()
        } catch {
            requestFinish(.failure(.pipeClosed), terminate: true)
            return
        }
        // These closures intentionally retain the child object until the
        // reader, bounded termination path, and wait/delivery path finish.
        // The supervisor removes its strong child reference only from the
        // single delivery gate, so a deinit cannot strand a live Process.
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            guard let outputHandle = self.outputHandleSnapshot() else {
                self.requestFinish(.failure(.pipeClosed), terminate: true)
                return
            }
            self.requestFinish(readHistoryScreenCaptureChildResponse(from: outputHandle), terminate: true)
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [self] in
            self.requestFinish(.failure(.deadlineExceeded), terminate: true)
        }
    }

    func cancel() {
        requestFinish(.failure(.cancelled), terminate: true)
    }

    private func outputHandleSnapshot() -> FileHandle? {
        lock.lock()
        defer { lock.unlock() }
        return outputHandle
    }

    private func requestFinish(
        _ result: Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure>,
        terminate: Bool
    ) {
        lock.lock()
        guard requestedResult == nil else {
            lock.unlock()
            return
        }
        requestedResult = result
        let child = process
        let shouldStartWait = child != nil && !waitingForExit
        if shouldStartWait { waitingForExit = true }
        lock.unlock()

        guard let child else {
            deliverAfterExit(process: nil, result: result, terminationStatus: nil)
            return
        }
        if terminate, child.isRunning {
            child.terminate()
            DispatchQueue.global(qos: .utility).asyncAfter(
                deadline: .now() + historyScreenCaptureChildGraceSeconds
            ) { [self, child] in
                guard child.isRunning else { return }
                kill(child.processIdentifier, SIGKILL)
                self.closeOutputToInterruptReader()
            }
        }
        if shouldStartWait {
            DispatchQueue.global(qos: .utility).async { [self, child] in
                child.waitUntilExit()
                self.deliverAfterExit(
                    process: child,
                    result: self.requestedResultSnapshot(),
                    terminationStatus: child.terminationStatus
                )
            }
        }
    }

    private func requestedResultSnapshot() -> Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure>? {
        lock.lock()
        defer { lock.unlock() }
        return requestedResult
    }

    private func closeOutputToInterruptReader() {
        lock.lock()
        let output = outputHandle
        outputHandle = nil
        lock.unlock()
        try? output?.close()
    }

    private func deliverAfterExit(
        process: Process?,
        result: Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure>?,
        terminationStatus: Int32?
    ) {
        lock.lock()
        guard !delivered else {
            lock.unlock()
            return
        }
        delivered = true
        let finalResult = result ?? requestedResult
        let status = terminationStatus ?? process?.terminationStatus
        let input = inputHandle
        let output = outputHandle
        inputHandle = nil
        outputHandle = nil
        lock.unlock()
        try? input?.close()
        try? output?.close()

        guard let finalResult else {
            completion(.failure(.childExited))
            return
        }
        if case .failure(.pipeClosed) = finalResult,
           let status,
           status != 0 {
            completion(.failure(.childExited))
        } else {
            completion(finalResult)
        }
    }
}

/// Thread-safe per-display child supervisor. No registry or child dictionary
/// is exposed without the lock; a child remains in-flight until waitUntilExit
/// has completed, even after a timeout/cancel request.
final class HistoryDisplayCaptureSupervisor {
    typealias Completion = (Result<HistoryDisplayCaptureResult, HistoryDisplayCaptureFailure>) -> Void
    typealias ArgumentsProvider = (HistoryDisplayDescriptor) -> [String]

    private let executableURL: URL?
    private let argumentsProvider: ArgumentsProvider
    private let timeout: TimeInterval
    private let stateLock = NSLock()
    private var registryStorage = HistoryDisplaySessionRegistry()
    private var children: [CGDirectDisplayID: HistoryDisplayChildProcess] = [:]
    private var stopped = false

    init(
        executableURL: URL? = Bundle.main.executableURL,
        timeout: TimeInterval = historyScreenCaptureChildTimeoutSeconds,
        argumentsProvider: @escaping ArgumentsProvider = { _ in ["--screen-capture-child"] }
    ) {
        self.executableURL = executableURL
        self.timeout = timeout
        self.argumentsProvider = argumentsProvider
    }

    func hasCaptureInFlight(on displayID: CGDirectDisplayID) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return children[displayID] != nil || registryStorage.hasCaptureInFlight(on: displayID)
    }

    @discardableResult
    func reconcile(_ descriptors: [HistoryDisplayDescriptor]) -> [HistoryDisplaySessionTransition] {
        stateLock.lock()
        guard !stopped else {
            stateLock.unlock()
            return []
        }
        let transitions = registryStorage.reconcile(descriptors)
        stateLock.unlock()
        for transition in transitions {
            switch transition {
            case let .removed(displayID), let .replaced(displayID):
                cancel(displayID: displayID)
            case .added, .reordered:
                break
            }
        }
        return transitions
    }

    @discardableResult
    func capture(
        descriptor: HistoryDisplayDescriptor,
        privacyFilter: HistoryScreenCaptureChildPrivacyFilter,
        now: TimeInterval,
        completion: @escaping Completion
    ) -> Bool {
        guard let executableURL else {
            completion(.failure(.spawnFailed))
            return false
        }
        let token = UUID().uuidString
        let request: [String: Any] = [
            "request": "capture_screenshot",
            "display_id": String(descriptor.displayID),
            "privacy_filter": [
                "browser_observations": privacyFilter.browserObservations.mapValues {
                    ["signature": $0.signature, "stable_observations": $0.stableObservations]
                },
            ],
        ]
        guard var requestData = try? JSONSerialization.data(withJSONObject: request) else {
            completion(.failure(.invalidResponse))
            return false
        }
        requestData.append(0x0a)
        let child = HistoryDisplayChildProcess(
            executableURL: executableURL,
            arguments: argumentsProvider(descriptor),
            request: requestData,
            timeout: timeout
        ) { [weak self] result in
            self?.finish(
                displayID: descriptor.displayID,
                token: token,
                descriptor: descriptor,
                result: result,
                completion: completion
            )
        }

        stateLock.lock()
        guard !stopped,
              children[descriptor.displayID] == nil,
              registryStorage.beginCapture(
                  displayID: descriptor.displayID,
                  token: token,
                  now: now,
                  timeout: timeout
              ) else {
            stateLock.unlock()
            completion(.failure(.cancelled))
            return false
        }
        children[descriptor.displayID] = child
        stateLock.unlock()
        child.start()
        return true
    }

    private func finish(
        displayID: CGDirectDisplayID,
        token: String,
        descriptor: HistoryDisplayDescriptor,
        result: Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure>,
        completion: @escaping Completion
    ) {
        stateLock.lock()
        children.removeValue(forKey: displayID)
        let accepted = registryStorage.finishCapture(
            displayID: displayID,
            token: token,
            outcome: historyDisplayCaptureOutcome(for: result)
        )
        let isStopped = stopped
        stateLock.unlock()
        guard accepted, !isStopped else { return }
        switch result {
        case let .failure(error): completion(.failure(error))
        case let .success(fingerprint):
            completion(.success(HistoryDisplayCaptureResult(
                descriptor: descriptor,
                fingerprint: fingerprint
            )))
        }
    }

    func cancel(displayID: CGDirectDisplayID) {
        stateLock.lock()
        let child = children[displayID]
        if child == nil {
            _ = registryStorage.cancelCapture(displayID: displayID)
        }
        stateLock.unlock()
        // Do not remove the child or release the registry slot before the
        // process has exited; the child callback is the poison gate.
        child?.cancel()
    }

    func stop() {
        stateLock.lock()
        guard !stopped else {
            stateLock.unlock()
            return
        }
        stopped = true
        let activeChildren = Array(children.values)
        registryStorage.stop()
        stateLock.unlock()
        for child in activeChildren { child.cancel() }
    }
}

private func historyDisplayCaptureOutcome(
    for result: Result<HistoryVisualFingerprint, HistoryDisplayCaptureFailure>
) -> HistoryDisplayCaptureOutcome {
    switch result {
    case .success: return .succeeded
    case .failure(.deadlineExceeded): return .timedOut
    case .failure(.cancelled): return .cancelled
    case .failure(.childExited): return .childExited
    case .failure(.pipeClosed): return .pipeClosed
    default: return .invalidResponse
    }
}

private func historyDisplayCaptureTestFilter() -> HistoryScreenCaptureChildPrivacyFilter {
    HistoryScreenCaptureChildPrivacyFilter(browserObservations: [:])
}

private func historyDisplayCaptureFixtureMetadata(width: Int = 1, height: Int = 1) -> String {
    "{\"status\":\"ok\",\"payload\":{\"safe_to_persist\":true,\"width\":\(width),\"height\":\(height),\"privacy_filter\":{\"browser_observations\":{}}}}"
}

func runHistoryDisplayCaptureSupervisorSelfTest() -> Bool {
    let descriptor = HistoryDisplayDescriptor(
        displayID: 42,
        bounds: CGRect(x: 0, y: 0, width: 2, height: 2),
        pixelWidth: 1,
        pixelHeight: 1
    )
    let metadata = historyDisplayCaptureFixtureMetadata()
    let script = "printf '%s\\n' '\(metadata)'; printf '\\001\\002\\003'"

    func waitForPIDFile(_ url: URL, timeout: TimeInterval = 1) -> pid_t? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let pidString = try? String(contentsOf: url),
               let pid = pid_t(pidString.trimmingCharacters(in: .whitespacesAndNewlines)),
               pid > 0 {
                return pid
            }
            usleep(10_000)
        }
        return nil
    }

    func processIsGone(_ pid: pid_t) -> Bool {
        guard pid > 0, kill(pid, 0) == -1 else { return false }
        return errno == ESRCH
    }

    func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 3) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(10_000)
        }
        return condition()
    }

    func validScript(pidFile: URL? = nil, delay: TimeInterval = 0) -> String {
        let pidLine = pidFile.map { "echo $$ > '\($0.path)'; " } ?? ""
        return "\(pidLine)sleep \(delay); printf '%s\\n' '\(metadata)'; printf '\\001\\002\\003'"
    }

    func ignoringTERMscript(pidFile: URL) -> String {
        "echo $$ > '\(pidFile.path)'; trap '' TERM; while true; do :; done"
    }

    func newPIDFile(_ label: String) -> URL {
        URL(fileURLWithPath: "/private/tmp/hel39-history-\(label)-\(UUID().uuidString)")
    }

    let supervisor = HistoryDisplayCaptureSupervisor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        timeout: 2,
        argumentsProvider: { _ in ["-c", script] }
    )
    _ = supervisor.reconcile([descriptor])
    let finished = DispatchSemaphore(value: 0)
    var success = false
    _ = supervisor.capture(
        descriptor: descriptor,
        privacyFilter: historyDisplayCaptureTestFilter(),
        now: 0
    ) { result in
        if case let .success(value) = result {
            success = value.fingerprint.grayscaleValues.count == HistoryVisualFingerprint.sampleCount
        }
        finished.signal()
    }
    guard finished.wait(timeout: .now() + 3) == .success, success,
          !supervisor.hasCaptureInFlight(on: descriptor.displayID) else {
        supervisor.stop()
        return false
    }
    supervisor.stop()

    let secondDescriptor = HistoryDisplayDescriptor(
        displayID: 43,
        bounds: CGRect(x: 2, y: 0, width: 2, height: 2),
        pixelWidth: 1,
        pixelHeight: 1
    )
    let firstPIDFile = newPIDFile("two-first")
    let secondPIDFile = newPIDFile("two-second")
    let multiSupervisor = HistoryDisplayCaptureSupervisor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        timeout: 2,
        argumentsProvider: { descriptor in
            let pidFile = descriptor.displayID == 42 ? firstPIDFile : secondPIDFile
            return ["-c", validScript(pidFile: pidFile, delay: 0.2)]
        }
    )
    _ = multiSupervisor.reconcile([descriptor, secondDescriptor])
    let multiFinished = DispatchSemaphore(value: 0)
    let multiLock = NSLock()
    var multiSuccessCount = 0
    var multiCallbackCount = 0
    for multiDescriptor in [descriptor, secondDescriptor] {
        _ = multiSupervisor.capture(
            descriptor: multiDescriptor,
            privacyFilter: historyDisplayCaptureTestFilter(),
            now: 0
        ) { result in
            multiLock.lock()
            multiCallbackCount += 1
            if case .success = result {
                multiSuccessCount += 1
            }
            multiLock.unlock()
            multiFinished.signal()
        }
    }
    guard let firstPID = waitForPIDFile(firstPIDFile),
          let secondPID = waitForPIDFile(secondPIDFile),
          firstPID != secondPID,
          kill(firstPID, 0) == 0,
          kill(secondPID, 0) == 0 else {
        multiSupervisor.stop()
        return false
    }
    let reorderTransitions = multiSupervisor.reconcile([secondDescriptor, descriptor])
    guard reorderTransitions.contains(.reordered([43, 42])),
          kill(firstPID, 0) == 0,
          kill(secondPID, 0) == 0,
          multiFinished.wait(timeout: .now() + 3) == .success,
          multiFinished.wait(timeout: .now() + 3) == .success else {
        multiSupervisor.stop()
        return false
    }
    multiLock.lock()
    let capturedBoth = multiSuccessCount == 2 && multiCallbackCount == 2
    multiLock.unlock()
    guard capturedBoth else {
        multiSupervisor.stop()
        return false
    }
    multiSupervisor.stop()
    guard waitUntil({ processIsGone(firstPID) && processIsGone(secondPID) }) else {
        return false
    }
    try? FileManager.default.removeItem(at: firstPIDFile)
    try? FileManager.default.removeItem(at: secondPIDFile)

    // A geometry replacement poisons the old token. The old child must be
    // killed and reaped before the replacement can claim the same display.
    let geometryPIDFile = newPIDFile("geometry-old")
    let replacementPIDFile = newPIDFile("geometry-new")
    let geometryDescriptor = HistoryDisplayDescriptor(
        displayID: 50,
        bounds: CGRect(x: 0, y: 0, width: 2, height: 2),
        pixelWidth: 1,
        pixelHeight: 1
    )
    let replacementDescriptor = HistoryDisplayDescriptor(
        displayID: 50,
        bounds: CGRect(x: 0, y: 0, width: 3, height: 2),
        pixelWidth: 2,
        pixelHeight: 1
    )
    let geometrySupervisor = HistoryDisplayCaptureSupervisor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        timeout: 2,
        argumentsProvider: { descriptor in
            let pidFile = descriptor.pixelWidth == 1 ? geometryPIDFile : replacementPIDFile
            return ["-c", descriptor.pixelWidth == 1
                ? ignoringTERMscript(pidFile: pidFile)
                : validScript(pidFile: pidFile)]
        }
    )
    _ = geometrySupervisor.reconcile([geometryDescriptor])
    let geometryOldFinished = DispatchSemaphore(value: 0)
    let geometryLock = NSLock()
    var geometryCallbackCount = 0
    _ = geometrySupervisor.capture(
        descriptor: geometryDescriptor,
        privacyFilter: historyDisplayCaptureTestFilter(),
        now: 0
    ) { _ in
        geometryLock.lock()
        geometryCallbackCount += 1
        geometryLock.unlock()
        geometryOldFinished.signal()
    }
    guard let geometryPID = waitForPIDFile(geometryPIDFile) else {
        geometrySupervisor.stop()
        return false
    }
    let replacementTransitions = geometrySupervisor.reconcile([replacementDescriptor])
    guard replacementTransitions.contains(.replaced(50)),
          waitUntil({ processIsGone(geometryPID) }),
          waitUntil({ !geometrySupervisor.hasCaptureInFlight(on: 50) }) else {
        geometrySupervisor.stop()
        return false
    }
    // No external callback is allowed for the poisoned old token.
    guard geometryOldFinished.wait(timeout: .now() + 0.1) == .timedOut else {
        geometrySupervisor.stop()
        return false
    }
    geometryLock.lock()
    let oldCallbackSuppressed = geometryCallbackCount == 0
    geometryLock.unlock()
    guard oldCallbackSuppressed else {
        geometrySupervisor.stop()
        return false
    }
    let replacementFinished = DispatchSemaphore(value: 0)
    _ = geometrySupervisor.capture(
        descriptor: replacementDescriptor,
        privacyFilter: historyDisplayCaptureTestFilter(),
        now: 1
    ) { result in
        geometryLock.lock()
        if case .success = result { geometryCallbackCount += 1 }
        geometryLock.unlock()
        replacementFinished.signal()
    }
    guard let replacementPID = waitForPIDFile(replacementPIDFile),
          replacementFinished.wait(timeout: .now() + 3) == .success,
          waitUntil({ processIsGone(replacementPID) }) else {
        geometrySupervisor.stop()
        return false
    }
    geometryLock.lock()
    let replacementCallbackDelivered = geometryCallbackCount == 1
    geometryLock.unlock()
    geometrySupervisor.stop()
    guard replacementCallbackDelivered else { return false }
    try? FileManager.default.removeItem(at: geometryPIDFile)
    try? FileManager.default.removeItem(at: replacementPIDFile)

    // Removing a display while its child is blocked follows the same poison
    // path, but the old completion must not be delivered after removal.
    let removedPIDFile = newPIDFile("removed")
    let removedDescriptor = HistoryDisplayDescriptor(
        displayID: 51,
        bounds: CGRect(x: 4, y: 0, width: 2, height: 2),
        pixelWidth: 1,
        pixelHeight: 1
    )
    let removedSupervisor = HistoryDisplayCaptureSupervisor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        timeout: 2,
        argumentsProvider: { _ in ["-c", ignoringTERMscript(pidFile: removedPIDFile)] }
    )
    _ = removedSupervisor.reconcile([removedDescriptor])
    let removedLock = NSLock()
    var removedCallbackCount = 0
    _ = removedSupervisor.capture(
        descriptor: removedDescriptor,
        privacyFilter: historyDisplayCaptureTestFilter(),
        now: 0
    ) { _ in
        removedLock.lock()
        removedCallbackCount += 1
        removedLock.unlock()
    }
    guard let removedPID = waitForPIDFile(removedPIDFile) else {
        removedSupervisor.stop()
        return false
    }
    let removedTransitions = removedSupervisor.reconcile([])
    guard removedTransitions.contains(.removed(51)),
          waitUntil({ processIsGone(removedPID) }),
          waitUntil({ !removedSupervisor.hasCaptureInFlight(on: 51) }) else {
        removedSupervisor.stop()
        return false
    }
    usleep(100_000)
    removedLock.lock()
    let removedCallbackSuppressed = removedCallbackCount == 0
    removedLock.unlock()
    removedSupervisor.stop()
    guard removedCallbackSuppressed else { return false }
    try? FileManager.default.removeItem(at: removedPIDFile)

    // stop() also waits for the actual child to exit; the registry alone is
    // not considered sufficient evidence of cancellation.
    let stoppedPIDFile = newPIDFile("stopped")
    let stoppedDescriptor = HistoryDisplayDescriptor(
        displayID: 52,
        bounds: CGRect(x: 6, y: 0, width: 2, height: 2),
        pixelWidth: 1,
        pixelHeight: 1
    )
    let stoppedSupervisor = HistoryDisplayCaptureSupervisor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        timeout: 2,
        argumentsProvider: { _ in ["-c", ignoringTERMscript(pidFile: stoppedPIDFile)] }
    )
    _ = stoppedSupervisor.reconcile([stoppedDescriptor])
    let stoppedLock = NSLock()
    var stoppedCallbackCount = 0
    _ = stoppedSupervisor.capture(
        descriptor: stoppedDescriptor,
        privacyFilter: historyDisplayCaptureTestFilter(),
        now: 0
    ) { _ in
        stoppedLock.lock()
        stoppedCallbackCount += 1
        stoppedLock.unlock()
    }
    guard let stoppedPID = waitForPIDFile(stoppedPIDFile) else {
        stoppedSupervisor.stop()
        return false
    }
    stoppedSupervisor.stop()
    guard waitUntil({ processIsGone(stoppedPID) }),
          waitUntil({ !stoppedSupervisor.hasCaptureInFlight(on: 52) }) else {
        return false
    }
    usleep(100_000)
    stoppedLock.lock()
    let stoppedCallbackSuppressed = stoppedCallbackCount == 0
    stoppedLock.unlock()
    guard stoppedCallbackSuppressed else { return false }
    try? FileManager.default.removeItem(at: stoppedPIDFile)

    func runFixture(
        descriptorID: UInt32,
        fixtureScript: String,
        timeout: TimeInterval,
        expected: HistoryDisplayCaptureFailure?
    ) -> Bool {
        let fixtureDescriptor = HistoryDisplayDescriptor(
            displayID: descriptorID,
            bounds: CGRect(x: 0, y: 0, width: 2, height: 2),
            pixelWidth: 1,
            pixelHeight: 1
        )
        let fixtureSupervisor = HistoryDisplayCaptureSupervisor(
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            timeout: timeout,
            argumentsProvider: { _ in ["-c", fixtureScript] }
        )
        _ = fixtureSupervisor.reconcile([fixtureDescriptor])
        let finishedFixture = DispatchSemaphore(value: 0)
        var resultFailure: HistoryDisplayCaptureFailure?
        _ = fixtureSupervisor.capture(
            descriptor: fixtureDescriptor,
            privacyFilter: historyDisplayCaptureTestFilter(),
            now: 0
        ) { result in
            if case let .failure(failure) = result { resultFailure = failure }
            finishedFixture.signal()
        }
        let completed = finishedFixture.wait(timeout: .now() + 3) == .success
        fixtureSupervisor.stop()
        guard completed else { return false }
        return expected.map { resultFailure == $0 } ?? (resultFailure == nil)
    }

    guard runFixture(
        descriptorID: 44,
        fixtureScript: "printf '%s\\n' '\(metadata)'; printf '\\001\\002\\003'",
        timeout: 1,
        expected: nil
    ), runFixture(
        descriptorID: 45,
        fixtureScript: "printf 'bad-json\\n'",
        timeout: 1,
        expected: .invalidResponse
    ), runFixture(
        descriptorID: 46,
        fixtureScript: "printf '%s\\n' '\(metadata)'; printf '\\001\\002'",
        timeout: 1,
        expected: .shortFrame
    ), runFixture(
        descriptorID: 47,
        fixtureScript: "printf '%s\\n' '\(metadata)'; printf '\\001\\002\\003\\004'",
        timeout: 1,
        expected: .trailingBytes
    ), runFixture(
        descriptorID: 48,
        fixtureScript: "exit 1",
        timeout: 1,
        expected: .childExited
    ) else { return false }

    let missingExecutable = HistoryDisplayCaptureSupervisor(
        executableURL: URL(fileURLWithPath: "/private/tmp/hel39-no-such-history-helper"),
        timeout: 1
    )
    _ = missingExecutable.reconcile([descriptor])
    let spawnFinished = DispatchSemaphore(value: 0)
    var spawnFailure: HistoryDisplayCaptureFailure?
    _ = missingExecutable.capture(
        descriptor: descriptor,
        privacyFilter: historyDisplayCaptureTestFilter(),
        now: 0
    ) { result in
        if case let .failure(failure) = result { spawnFailure = failure }
        spawnFinished.signal()
    }
    guard spawnFinished.wait(timeout: .now() + 2) == .success,
          spawnFailure == .spawnFailed else {
        missingExecutable.stop()
        return false
    }
    missingExecutable.stop()

    let pidFile = newPIDFile("timeout")
    let timeoutSupervisor = HistoryDisplayCaptureSupervisor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        timeout: 0.05,
        argumentsProvider: { _ in
            ["-c", "echo $$ > '\(pidFile.path)'; trap '' TERM; while true; do :; done"]
        }
    )
    _ = timeoutSupervisor.reconcile([descriptor])
    let timeoutFinished = DispatchSemaphore(value: 0)
    var timeoutFailure: HistoryDisplayCaptureFailure?
    _ = timeoutSupervisor.capture(
        descriptor: descriptor,
        privacyFilter: historyDisplayCaptureTestFilter(),
        now: 0
    ) { result in
        if case let .failure(failure) = result { timeoutFailure = failure }
        timeoutFinished.signal()
    }
    guard let timeoutPID = waitForPIDFile(pidFile),
          timeoutFinished.wait(timeout: .now() + 3) == .success,
          timeoutFailure == .deadlineExceeded,
          !timeoutSupervisor.hasCaptureInFlight(on: descriptor.displayID),
          processIsGone(timeoutPID) else {
        timeoutSupervisor.stop()
        return false
    }
    try? FileManager.default.removeItem(at: pidFile)
    timeoutSupervisor.stop()

    guard case .failure(.unknownFields) = parseHistoryScreenCaptureChildCommand(
        Data(#"{"request":"capture_screenshot","display_id":"42","geometry":{},"privacy_filter":{"browser_observations":{}}}"#.utf8)
    ), case .failure(.invalidJSON) = parseHistoryScreenCaptureChildCommand(Data("{".utf8)) else {
        return false
    }
    return true
}

func runHistoryScreenCaptureChildSelfTest() -> Bool {
    let fixtureDescriptor = HistoryDisplayDescriptor(
        displayID: 42,
        bounds: CGRect(x: 0, y: 0, width: 2, height: 2),
        pixelWidth: 1,
        pixelHeight: 1
    )
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
    guard case .success(.listDisplays) = parseHistoryScreenCaptureChildCommand(
        Data(#"{"request":"list_displays"}"#.utf8)
    ), case let .success(.captureScreenshot(displayID, parsedFilter)) = parseHistoryScreenCaptureChildCommand(
        Data(#"{"request":"capture_screenshot","display_id":"42","privacy_filter":{"browser_observations":{}}}"#.utf8)
    ), displayID == "42", parsedFilter.browserObservations.isEmpty,
          case .failure(.unknownFields) = parseHistoryScreenCaptureChildCommand(
              Data(#"{"request":"list_displays","unexpected":true}"#.utf8)
          ) else { return false }

    let listPayload = historyScreenCaptureChildDisplayPayload(fixtureDescriptor)
    guard Set(listPayload.keys) == Set(["geometry", "id", "name"]),
          listPayload["id"] as? String == "42",
          let listName = listPayload["name"] as? String,
          !listName.isEmpty,
          let geometry = listPayload["geometry"] as? [String: Any],
          Set(geometry.keys) == Set(["height", "width"]),
          historyJSONNumber(geometry["width"]) == 1,
          historyJSONNumber(geometry["height"]) == 1 else { return false }

    let observation = HistoryDisplayWindowObservation(
        windowID: 7,
        bundleIdentifier: "com.example.fixture",
        title: "Fixture",
        bounds: fixtureDescriptor.bounds,
        observedAt: 100
    )
    var filter = HistoryPrivacyFilter()
    var calls = 0
    guard case .success = captureHistoryDisplaySafely(
        descriptor: fixtureDescriptor,
        observations: [observation],
        filter: &filter,
        now: 100,
        deadlineMilliseconds: 1_000,
        imageProvider: {
            calls += 1
            return image
        },
        clock: { 100 }
    ), calls == 1 else { return false }
    var privateFilter = HistoryPrivacyFilter()
    let privateObservation = HistoryDisplayWindowObservation(
        windowID: 8,
        bundleIdentifier: "com.google.Chrome",
        title: "Private (Incognito)",
        bounds: fixtureDescriptor.bounds,
        observedAt: 100
    )
    guard captureHistoryDisplaySafely(
        descriptor: fixtureDescriptor,
        observations: [privateObservation],
        filter: &privateFilter,
        now: 100,
        deadlineMilliseconds: 1_000,
        imageProvider: { image },
        clock: { 100 }
    ) == .failure(.privacyDenied(.chromeIncognitoTitle)) else { return false }
    return runHistoryDisplayCaptureSupervisorSelfTest()
}
