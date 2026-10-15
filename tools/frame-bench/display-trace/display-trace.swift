// display-trace: records when the display's picture changes, as ScreenCaptureKit reports it.
//
// ScreenCaptureKit hands over a frame each time the window server composes a new picture of the display, stamped with
// `displayTime`: the mach host time of the refresh it was composed for. This tool captures the main display at the
// display's refresh rate, shrinks every frame to a coarse luma grid inside the chosen region, and records for each frame
// its displayTime and how much the grid changed from the frame before. The harness (bench.mjs) injects input at a known
// `process.hrtime` (the same clock: mach_absolute_time in nanoseconds) and finds the first frame that changed after it.
//
//   display-trace --out trace.json [--seconds 30] [--region x,y,w,h] [--grid 32x20] [--fps 120] [--display 1]
//
// It prints `ready` once frames are flowing, records until --seconds, SIGINT or SIGTERM, then writes the JSON and exits.
// Needs Screen Recording permission for the process that starts it.

import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

struct Arguments {
    var out = "display-trace.json"
    var seconds = 30.0
    var region: CGRect?
    var gridW = 32
    var gridH = 20
    var fps = 120
    var display = 0
}

func parse() -> Arguments {
    var a = Arguments()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let flag = it.next() {
        guard let value = it.next() else { fputs("display-trace: \(flag) needs a value\n", stderr); exit(2) }
        switch flag {
        case "--out": a.out = value
        case "--seconds": a.seconds = Double(value) ?? a.seconds
        case "--fps": a.fps = Int(value) ?? a.fps
        case "--display": a.display = Int(value) ?? 0
        case "--grid":
            let p = value.split(separator: "x").compactMap { Int($0) }
            if p.count == 2 { a.gridW = p[0]; a.gridH = p[1] }
        case "--region":
            let p = value.split(separator: ",").compactMap { Double($0) }
            if p.count == 4 { a.region = CGRect(x: p[0], y: p[1], width: p[2], height: p[3]) }
        default: fputs("display-trace: unknown flag \(flag)\n", stderr); exit(2)
        }
    }
    return a
}

struct Frame {
    var displayNs: UInt64
    var receivedNs: UInt64
    var diff: Double
    var status: Int
}

var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
func ns(_ ticks: UInt64) -> UInt64 { ticks &* UInt64(timebase.numer) / UInt64(timebase.denom) }

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let gridW: Int
    let gridH: Int
    var previous: [UInt8]?
    var frames: [Frame] = []
    var first: (() -> Void)?
    let lock = NSLock()

    init(gridW: Int, gridH: Int) {
        self.gridW = gridW
        self.gridH = gridH
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        let received = ns(mach_absolute_time())
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]], let info = attachments.first else { return }
        let status = (info[.status] as? Int).flatMap { SCFrameStatus(rawValue: $0) }
        guard status == .complete, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let displayTicks = (info[.displayTime] as? UInt64) ?? 0
        let grid = luma(pixels)
        lock.lock()
        let diff: Double
        if let previous, previous.count == grid.count {
            var sum = 0
            for i in 0..<grid.count { sum += abs(Int(grid[i]) - Int(previous[i])) }
            diff = Double(sum) / Double(grid.count)
        } else { diff = 0 }
        previous = grid
        frames.append(Frame(displayNs: ns(displayTicks), receivedNs: received, diff: diff, status: status?.rawValue ?? -1))
        lock.unlock()
        if let first { self.first = nil; first() }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("display-trace: the stream stopped: \(error.localizedDescription)\n", stderr)
    }

    /// Mean luma of each cell of a gridW×gridH grid over the frame's pixels.
    func luma(_ buffer: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let w = CVPixelBufferGetWidth(buffer)
        let h = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else { return [] }
        var out = [UInt8](repeating: 0, count: gridW * gridH)
        for gy in 0..<gridH {
            let y0 = gy * h / gridH
            let y1 = max(y0 + 1, (gy + 1) * h / gridH)
            for gx in 0..<gridW {
                let x0 = gx * w / gridW
                let x1 = max(x0 + 1, (gx + 1) * w / gridW)
                var sum = 0
                var count = 0
                for y in stride(from: y0, to: y1, by: 2) {
                    let row = base + y * rowBytes
                    for x in stride(from: x0, to: x1, by: 2) {
                        let p = row + x * 4
                        let b = Int(p[0]), g = Int(p[1]), r = Int(p[2])
                        sum += (b * 29 + g * 150 + r * 77) >> 8
                        count += 1
                    }
                }
                out[gy * gridW + gx] = UInt8(count > 0 ? sum / count : 0)
            }
        }
        return out
    }
}

let args = parse()
guard CGPreflightScreenCaptureAccess() else {
    fputs("display-trace: no Screen Recording permission for this process. Grant it in System Settings → Privacy & Security → Screen & System Audio Recording to the app that starts this tool.\n", stderr)
    exit(3)
}

let recorder = Recorder(gridW: args.gridW, gridH: args.gridH)
let done = DispatchSemaphore(value: 0)
var stream: SCStream?

func finish() {
    let group = DispatchGroup()
    group.enter()
    if let stream { stream.stopCapture { _ in group.leave() } } else { group.leave() }
    group.wait()
    recorder.lock.lock()
    let frames = recorder.frames
    recorder.lock.unlock()
    var text = "{\"clock\":\"mach_absolute_time ns\",\"frames\":[\n"
    text += frames.map { "{\"t\":\($0.displayNs),\"r\":\($0.receivedNs),\"d\":\(String(format: "%.3f", $0.diff)),\"s\":\($0.status)}" }.joined(separator: ",\n")
    text += "\n]}\n"
    do { try text.write(toFile: args.out, atomically: true, encoding: .utf8) } catch { fputs("display-trace: \(error)\n", stderr); exit(1) }
    print("wrote \(frames.count) frames to \(args.out)")
    exit(0)
}

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard args.display < content.displays.count else { fputs("display-trace: no display \(args.display)\n", stderr); exit(1) }
        let display = content.displays[args.display]
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        let region = args.region ?? CGRect(x: 0, y: 0, width: display.width, height: display.height)
        config.sourceRect = region
        config.width = args.gridW * 8
        config.height = args.gridH * 8
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(args.fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.queueDepth = 8
        let s = SCStream(filter: filter, configuration: config, delegate: recorder)
        try s.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: DispatchQueue(label: "display-trace", qos: .userInteractive))
        recorder.first = { print("ready") ; fflush(stdout) }
        stream = s
        try await s.startCapture()
    } catch {
        fputs("display-trace: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigint.setEventHandler { finish() }
sigterm.setEventHandler { finish() }
sigint.resume()
sigterm.resume()
DispatchQueue.main.asyncAfter(deadline: .now() + args.seconds) { finish() }
dispatchMain()
