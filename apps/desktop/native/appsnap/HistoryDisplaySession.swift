import CoreGraphics
import Foundation

struct HistoryDisplayDescriptor: Equatable {
    let displayID: CGDirectDisplayID
    let bounds: CGRect
    let pixelWidth: Int
    let pixelHeight: Int
}

enum HistoryDisplaySessionState: Equatable {
    case idle
    case capturing(token: String, deadline: TimeInterval)
    case paused
    case stopped
}

enum HistoryDisplaySessionTransition: Equatable {
    case added(CGDirectDisplayID)
    case removed(CGDirectDisplayID)
    case replaced(CGDirectDisplayID)
    case reordered([CGDirectDisplayID])
}

enum HistoryDisplayCaptureOutcome: Equatable {
    case succeeded
    case timedOut
    case cancelled
    case childExited
    case pipeClosed
    case invalidResponse
}

struct HistoryDisplaySession: Equatable {
    let descriptor: HistoryDisplayDescriptor
    private(set) var state: HistoryDisplaySessionState = .idle

    var isCapturing: Bool {
        if case .capturing = state { return true }
        return false
    }

    mutating func beginCapture(token: String, deadline: TimeInterval) -> Bool {
        guard !token.isEmpty, case .idle = state else { return false }
        state = .capturing(token: token, deadline: deadline)
        return true
    }

    mutating func finishCapture(token: String, outcome: HistoryDisplayCaptureOutcome) -> Bool {
        guard case let .capturing(activeToken, _) = state, activeToken == token else {
            return false
        }
        // Every terminal child outcome releases the per-display single-flight
        // slot. A bad response is not allowed to poison the next attempt.
        state = .idle
        return true
    }

    mutating func cancelCapture() -> Bool {
        guard isCapturing else { return false }
        state = .idle
        return true
    }

    mutating func pause() {
        state = .paused
    }

    mutating func resume() {
        if case .paused = state { state = .idle }
    }

    mutating func stop() {
        state = .stopped
    }
}

/// Owns only lifecycle state.  Actual ScreenCaptureKit work is deliberately
/// kept outside this registry so a child crash, pipe EOF, or timeout can
/// release one display without affecting another display's session.
struct HistoryDisplaySessionRegistry: Equatable {
    private(set) var sessions: [CGDirectDisplayID: HistoryDisplaySession] = [:]
    private(set) var order: [CGDirectDisplayID] = []
    private(set) var paused = false
    private(set) var stopped = false

    mutating func reconcile(
        _ descriptors: [HistoryDisplayDescriptor]
    ) -> [HistoryDisplaySessionTransition] {
        guard !stopped else { return [] }
        var unique: [CGDirectDisplayID: HistoryDisplayDescriptor] = [:]
        var nextOrder: [CGDirectDisplayID] = []
        for descriptor in descriptors {
            guard unique[descriptor.displayID] == nil else { continue }
            unique[descriptor.displayID] = descriptor
            nextOrder.append(descriptor.displayID)
        }
        var transitions: [HistoryDisplaySessionTransition] = []
        for displayID in order where unique[displayID] == nil {
            sessions.removeValue(forKey: displayID)
            transitions.append(.removed(displayID))
        }
        for displayID in nextOrder where sessions[displayID] == nil {
            guard let descriptor = unique[displayID] else { continue }
            sessions[displayID] = HistoryDisplaySession(descriptor: descriptor)
            transitions.append(.added(displayID))
        }
        // Geometry replacement invalidates the old child. Do not preserve an
        // in-flight token across a display replacement: the late child result
        // must be poisoned and the next round must start with a fresh slot.
        for displayID in nextOrder {
            guard let descriptor = unique[displayID], let current = sessions[displayID] else { continue }
            if current.descriptor != descriptor {
                sessions[displayID] = HistoryDisplaySession(descriptor: descriptor)
                transitions.append(.replaced(displayID))
            }
        }
        if nextOrder != order {
            transitions.append(.reordered(nextOrder))
        }
        order = nextOrder
        return transitions
    }

    mutating func beginCapture(
        displayID: CGDirectDisplayID,
        token: String,
        now: TimeInterval,
        timeout: TimeInterval = 6
    ) -> Bool {
        guard !paused, !stopped, let session = sessions[displayID], !session.isCapturing else {
            return false
        }
        var updated = session
        guard updated.beginCapture(token: token, deadline: now + max(0.001, timeout)) else {
            return false
        }
        sessions[displayID] = updated
        return true
    }

    mutating func finishCapture(
        displayID: CGDirectDisplayID,
        token: String,
        outcome: HistoryDisplayCaptureOutcome
    ) -> Bool {
        guard var session = sessions[displayID],
              session.finishCapture(token: token, outcome: outcome) else {
            return false
        }
        sessions[displayID] = session
        return true
    }

    mutating func cancelCapture(displayID: CGDirectDisplayID) -> Bool {
        guard var session = sessions[displayID], session.cancelCapture() else { return false }
        sessions[displayID] = session
        return true
    }

    mutating func expireCaptures(now: TimeInterval) -> [CGDirectDisplayID] {
        var expired: [CGDirectDisplayID] = []
        for displayID in order {
            guard let session = sessions[displayID],
                  case let .capturing(token, deadline) = session.state,
                  now >= deadline else { continue }
            _ = finishCapture(displayID: displayID, token: token, outcome: .timedOut)
            expired.append(displayID)
        }
        return expired
    }

    mutating func pause() {
        guard !stopped else { return }
        paused = true
        for displayID in order {
            guard var session = sessions[displayID] else { continue }
            _ = session.cancelCapture()
            session.pause()
            sessions[displayID] = session
        }
    }

    mutating func resume() {
        guard !stopped else { return }
        paused = false
        for displayID in order {
            guard var session = sessions[displayID] else { continue }
            session.resume()
            sessions[displayID] = session
        }
    }

    mutating func stop() {
        guard !stopped else { return }
        stopped = true
        paused = true
        for displayID in order {
            guard var session = sessions[displayID] else { continue }
            _ = session.cancelCapture()
            session.stop()
            sessions[displayID] = session
        }
    }

    func hasCaptureInFlight(on displayID: CGDirectDisplayID) -> Bool {
        sessions[displayID]?.isCapturing ?? false
    }

    func captureToken(for displayID: CGDirectDisplayID) -> String? {
        guard let session = sessions[displayID],
              case let .capturing(token, _) = session.state else { return nil }
        return token
    }
}

func historyActiveDisplayDescriptors() -> [HistoryDisplayDescriptor] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var displayIDs = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displayIDs, &count) == .success else { return [] }
    return displayIDs.prefix(Int(count)).compactMap { displayID in
        let bounds = CGDisplayBounds(displayID)
        let width = CGDisplayPixelsWide(displayID)
        let height = CGDisplayPixelsHigh(displayID)
        guard bounds.width > 0, bounds.height > 0, width > 0, height > 0 else { return nil }
        return HistoryDisplayDescriptor(
            displayID: displayID,
            bounds: bounds,
            pixelWidth: width,
            pixelHeight: height
        )
    }
}

func runHistoryDisplaySessionSelfTest() -> Bool {
    func display(_ id: UInt32, _ x: CGFloat = 0) -> HistoryDisplayDescriptor {
        HistoryDisplayDescriptor(
            displayID: id,
            bounds: CGRect(x: x, y: 0, width: 1_920, height: 1_080),
            pixelWidth: 1_920,
            pixelHeight: 1_080
        )
    }

    var registry = HistoryDisplaySessionRegistry()
    let first = registry.reconcile([display(1), display(2)])
    guard first.contains(.added(1)), first.contains(.added(2)),
          registry.order == [1, 2], registry.sessions.count == 2 else { return false }
    let reordered = registry.reconcile([display(2, 1_920), display(1)])
    guard reordered.contains(.reordered([2, 1])),
          registry.order == [2, 1] else { return false }
    let removed = registry.reconcile([display(2, 1_920)])
    guard removed.contains(.removed(1)), registry.sessions[1] == nil else { return false }

    guard registry.beginCapture(displayID: 2, token: "capture-2", now: 10, timeout: 1),
          !registry.beginCapture(displayID: 2, token: "overlap", now: 10, timeout: 1),
          registry.hasCaptureInFlight(on: 2) else { return false }
    guard registry.expireCaptures(now: 11) == [2],
          !registry.hasCaptureInFlight(on: 2) else { return false }
    guard registry.beginCapture(displayID: 2, token: "cancel", now: 12),
          registry.cancelCapture(displayID: 2),
          !registry.hasCaptureInFlight(on: 2) else { return false }

    guard registry.beginCapture(displayID: 2, token: "bad-response", now: 13),
          !registry.finishCapture(displayID: 2, token: "wrong", outcome: .invalidResponse),
          registry.finishCapture(displayID: 2, token: "bad-response", outcome: .pipeClosed),
          registry.beginCapture(displayID: 2, token: "crash", now: 14),
          registry.finishCapture(displayID: 2, token: "crash", outcome: .childExited) else { return false }

    registry.pause()
    guard registry.paused,
          !registry.beginCapture(displayID: 2, token: "paused", now: 15) else { return false }
    registry.resume()
    guard !registry.paused,
          registry.beginCapture(displayID: 2, token: "resumed", now: 16),
          registry.finishCapture(displayID: 2, token: "resumed", outcome: .succeeded) else { return false }
    registry.stop()
    guard registry.stopped,
          !registry.beginCapture(displayID: 2, token: "stopped", now: 17) else { return false }
    return true
}
