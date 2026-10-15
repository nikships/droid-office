// A native control for the display-side numbers: a full-screen Metal window with a bar that moves a little on every
// display link tick, with no browser involved. display-trace records it the same way it records the app, so what it
// shows is the floor of the capture tool and the window server on this display, before Chromium is blamed for anything.
//
//   swiftc -O native-control.swift -o native-control
//   native-control [--seconds 12] [--out ticks.json] [--fps 120]
//
// It prints `ready` after the first frame is presented. --out writes the display link's own tick times (CLOCK_MONOTONIC_RAW
// ns, the same clock display-trace uses) and when each drawable was presented (also CLOCK_MONOTONIC_RAW ns).
import AppKit
import Metal
import QuartzCore

struct Args {
    var seconds = 12.0
    var out: String? = nil
    var fps = 120
}

func parseArgs() -> Args {
    var a = Args()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let flag = it.next() {
        guard let value = it.next() else { break }
        switch flag {
        case "--seconds": a.seconds = Double(value) ?? a.seconds
        case "--out": a.out = value
        case "--fps": a.fps = Int(value) ?? a.fps
        default: break
        }
    }
    return a
}

let args = parseArgs()

let source = """
#include <metal_stdlib>
using namespace metal;
struct Out { float4 position [[position]]; };
struct Bar { float x0; float x1; };
vertex Out vs(uint vid [[vertex_id]], constant Bar &bar [[buffer(0)]]) {
    float2 corners[6] = { float2(0, -1), float2(1, -1), float2(0, 1), float2(0, 1), float2(1, -1), float2(1, 1) };
    float2 c = corners[vid];
    Out o;
    o.position = float4(mix(bar.x0, bar.x1, c.x), c.y, 0, 1);
    return o;
}
fragment float4 fs() { return float4(1, 1, 1, 1); }
"""

final class Renderer: NSObject {
    let device = MTLCreateSystemDefaultDevice()!
    lazy var queue = device.makeCommandQueue()!
    let layer = CAMetalLayer()
    var pipeline: MTLRenderPipelineState!
    var x = 0.0
    var ticks: [Double] = []
    var presented: [Double] = []
    var first = true
    var width = 1.0

    override init() {
        super.init()
        layer.device = device
        layer.pixelFormat = .bgra8Unorm
        layer.framebufferOnly = true
        layer.maximumDrawableCount = 3
        let lib = try! device.makeLibrary(source: source, options: nil)
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = lib.makeFunction(name: "vs")
        d.fragmentFunction = lib.makeFunction(name: "fs")
        d.colorAttachments[0].pixelFormat = .bgra8Unorm
        pipeline = try! device.makeRenderPipelineState(descriptor: d)
    }

    @objc func tick(_ link: CADisplayLink) {
        ticks.append(Renderer.monotonicNs())
        guard let drawable = layer.nextDrawable() else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0.063, green: 0.094, blue: 0.125, alpha: 1)
        pass.colorAttachments[0].storeAction = .store
        let w = Double(drawable.texture.width)
        let barWidth = 240.0
        x = (x + 18.0).truncatingRemainder(dividingBy: max(1, w - barWidth))
        var bar = (Float(x / w * 2 - 1), Float((x + barWidth) / w * 2 - 1))
        let cb = queue.makeCommandBuffer()!
        let enc = cb.makeRenderCommandEncoder(descriptor: pass)!
        enc.setRenderPipelineState(pipeline)
        enc.setVertexBytes(&bar, length: MemoryLayout.size(ofValue: bar), index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)
        enc.endEncoding()
        cb.present(drawable)
        drawable.addPresentedHandler { [weak self] d in
            guard let self else { return }
            // presentedTime is in seconds of mach_absolute_time (CACurrentMediaTime's clock).
            self.presented.append(Renderer.monotonicNs(fromAbsoluteSeconds: d.presentedTime))
            if self.first {
                self.first = false
                print("ready")
                fflush(stdout)
            }
        }
        cb.commit()
    }

    /// CLOCK_MONOTONIC_RAW in ns: the clock display-trace converts ScreenCaptureKit times to.
    static func monotonicNs() -> Double { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) }

    /// A mach_absolute_time stamp (seconds, as CACurrentMediaTime counts it) moved to the CLOCK_MONOTONIC_RAW domain.
    static func monotonicNs(fromAbsoluteSeconds s: Double) -> Double {
        s * 1e9 + Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) - CACurrentMediaTime() * 1e9
    }
}

final class App: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let renderer = Renderer()

    func applicationDidFinishLaunching(_ note: Notification) {
        let screen = NSScreen.screens[0]
        window = NSWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.level = .screenSaver
        window.backgroundColor = .black
        let view = NSView(frame: screen.frame)
        view.wantsLayer = true
        renderer.layer.frame = view.bounds
        renderer.layer.contentsScale = screen.backingScaleFactor
        renderer.layer.drawableSize = CGSize(width: screen.frame.width * screen.backingScaleFactor, height: screen.frame.height * screen.backingScaleFactor)
        view.layer = renderer.layer
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        NSCursor.hide()
        let link = view.displayLink(target: renderer, selector: #selector(Renderer.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: Float(args.fps), maximum: Float(args.fps), preferred: Float(args.fps))
        link.add(to: .main, forMode: .common)
        DispatchQueue.main.asyncAfter(deadline: .now() + args.seconds) { [self] in finish(link) }
    }

    func finish(_ link: CADisplayLink) {
        link.invalidate()
        if let out = args.out {
            let json: [String: Any] = ["ticksNs": renderer.ticks, "presentedNs": renderer.presented]
            if let data = try? JSONSerialization.data(withJSONObject: json) { try? data.write(to: URL(fileURLWithPath: out)) }
        }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = App()
app.delegate = delegate
app.run()
