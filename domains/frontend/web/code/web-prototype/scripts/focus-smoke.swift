import AppKit
import Foundation
import WebKit

enum FocusSmokeError: Error, CustomStringConvertible {
    case timeout(String)
    case javascript(String)
    case assertion(String)
    case missingFile(String)

    var description: String {
        switch self {
        case .timeout(let message), .javascript(let message), .assertion(let message), .missingFile(let message):
            return message
        }
    }
}

final class NavigationWaiter: NSObject, WKNavigationDelegate {
    var finished = false
    var failed: Error?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finished = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed = error
        finished = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed = error
        finished = true
    }
}

@discardableResult
func spinUntil(_ label: String, timeout: TimeInterval = 15, _ done: () -> Bool) throws -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !done() {
        if Date() > deadline {
            throw FocusSmokeError.timeout("Timed out while waiting for \(label)")
        }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return true
}

func settle(_ seconds: TimeInterval = 0.18) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.04))
    }
}

func jsString(_ value: String) -> String {
    let data = try! JSONEncoder().encode(value)
    return String(data: data, encoding: .utf8)!
}

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let rootURL = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let defaultOutputURL = rootURL
    .deletingLastPathComponent()
    .appendingPathComponent("product-design-audit-web", isDirectory: true)
let outputURL = CommandLine.arguments.dropFirst().first.map { URL(fileURLWithPath: $0).standardizedFileURL } ?? defaultOutputURL
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

let targetURLString = ProcessInfo.processInfo.environment["LOOPOPS_WEB_URL"] ?? "http://127.0.0.1:5184/"
let targetURL: URL
if let parsedURL = URL(string: targetURLString), parsedURL.scheme != nil {
    targetURL = parsedURL
} else {
    targetURL = URL(fileURLWithPath: targetURLString)
}
if targetURL.scheme == "file", !FileManager.default.fileExists(atPath: targetURL.path) {
    throw FocusSmokeError.missingFile("focus:smoke local file does not exist: \(targetURL.path)")
}

let viewport = NSRect(x: 0, y: 0, width: 1280, height: 820)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let webView = WKWebView(frame: viewport, configuration: configuration)
let window = NSWindow(
    contentRect: NSRect(x: -2200, y: -2200, width: viewport.width, height: viewport.height),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.contentView = webView
window.orderFrontRegardless()

let navigationWaiter = NavigationWaiter()
webView.navigationDelegate = navigationWaiter
if targetURL.scheme == "file" {
    webView.loadFileURL(targetURL, allowingReadAccessTo: targetURL.deletingLastPathComponent())
} else {
    webView.load(URLRequest(url: targetURL))
}
try spinUntil("initial navigation", timeout: 20) { navigationWaiter.finished }
if let error = navigationWaiter.failed {
    throw error
}
settle(0.4)

@discardableResult
func evaluate(_ javascript: String, timeout: TimeInterval = 10) throws -> Any? {
    var result: Any?
    var evalError: Error?
    var finished = false
    webView.evaluateJavaScript(javascript) { value, error in
        result = value
        evalError = error
        finished = true
    }
    try spinUntil("javascript evaluation", timeout: timeout) { finished }
    if let evalError {
        throw FocusSmokeError.javascript(evalError.localizedDescription)
    }
    return result
}

func assertCheck(_ condition: Bool, _ message: String) throws {
    if !condition {
        throw FocusSmokeError.assertion(message)
    }
}

func clickTestID(_ testID: String) throws {
    let script = """
    (() => {
      const el = document.querySelector('[data-testid="\(testID)"]');
      if (!el) return false;
      el.click();
      return true;
    })()
    """
    let clicked = try evaluate(script) as? Bool ?? false
    try assertCheck(clicked, "Missing test id: \(testID)")
    settle()
}

func focusSnapshot() throws -> [String: Any] {
    let script = """
    (() => {
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const labelFor = (el) => (el.getAttribute('aria-label') || el.textContent || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 90);
      const controls = [...document.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && isVisible(el))
        .map((el, index) => {
          let focused = (() => {
            try { el.focus({ preventScroll: true }); return document.activeElement === el; }
            catch (error) { return false; }
          })();
          return {
            index,
            tag: el.tagName.toLowerCase(),
            text: labelFor(el),
            testid: el.dataset.testid || '',
            active: focused
          };
        });
      return JSON.stringify({
        h1: document.querySelector('h1')?.textContent.trim() || '',
        controlCount: controls.length,
        unlabeled: controls.filter((item) => !item.text),
        focusFailures: controls.filter((item) => !item.active),
        testids: controls.map((item) => item.testid).filter(Boolean)
      });
    })()
    """
    guard let json = try evaluate(script) as? String,
          let data = json.data(using: .utf8),
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw FocusSmokeError.javascript("Could not decode focus snapshot")
    }
    return value
}

struct SurfaceExpectation {
    let navID: String?
    let h1: String
    let minControls: Int
}

let expectations = [
    SurfaceExpectation(navID: nil, h1: "Loop lifecycle", minControls: 20),
    SurfaceExpectation(navID: "skills", h1: "Skills", minControls: 20),
    SurfaceExpectation(navID: "library", h1: "Team library", minControls: 12),
]

var manifest: [[String: Any]] = []

for expectation in expectations {
    if let navID = expectation.navID {
        try clickTestID("loopops.nav.\(navID)")
    }
    let snapshot = try focusSnapshot()
    try assertCheck(snapshot["h1"] as? String == expectation.h1, "Unexpected h1 for \(expectation.h1)")
    let actualControlCount = snapshot["controlCount"] as? Int ?? 0
    try assertCheck(actualControlCount >= expectation.minControls, "Too few controls for \(expectation.h1): expected at least \(expectation.minControls), found \(actualControlCount)")
    try assertCheck((snapshot["unlabeled"] as? [[String: Any]] ?? []).isEmpty, "Unlabeled focusable controls for \(expectation.h1)")
    try assertCheck((snapshot["focusFailures"] as? [[String: Any]] ?? []).isEmpty, "Focus failures for \(expectation.h1)")
    manifest.append(snapshot)
}

let manifestURL = outputURL.appendingPathComponent("focus-smoke-manifest.json")
let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
try data.write(to: manifestURL)

print("web_focus_smoke=pass")
print("web_focus_smoke_surfaces=\(manifest.count)")
print("web_focus_smoke_manifest=\(manifestURL.path)")
