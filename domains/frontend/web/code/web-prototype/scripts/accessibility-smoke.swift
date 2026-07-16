import AppKit
import Foundation
import WebKit

enum AccessibilitySmokeError: Error, CustomStringConvertible {
    case timeout(String)
    case javascript(String)
    case assertion(String)

    var description: String {
        switch self {
        case .timeout(let message), .javascript(let message), .assertion(let message):
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
            throw AccessibilitySmokeError.timeout("Timed out while waiting for \(label)")
        }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.04))
    }
    return true
}

func settle(_ seconds: TimeInterval = 0.2) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.04))
    }
}

func jsString(_ value: String) -> String {
    let data = try! JSONEncoder().encode(value)
    return String(data: data, encoding: .utf8)!
}

func decodeObject(_ json: String, label: String) throws -> [String: Any] {
    guard let data = json.data(using: .utf8),
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw AccessibilitySmokeError.javascript("Could not decode \(label)")
    }
    return value
}

let targetURLString = ProcessInfo.processInfo.environment["LOOPOPS_WEB_URL"] ?? "http://127.0.0.1:8798/"
guard let targetURL = URL(string: targetURLString),
      ["http", "https"].contains(targetURL.scheme?.lowercased() ?? "") else {
    throw AccessibilitySmokeError.assertion("accessibility:smoke requires the same-origin Product server URL")
}

let outputURL = CommandLine.arguments.dropFirst().first
    .map { URL(fileURLWithPath: $0).standardizedFileURL }
    ?? URL(fileURLWithPath: "/private/tmp/loopops-accessibility-smoke-manifest.json")
try FileManager.default.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
)

let reducedMotionMatchMedia = WKUserScript(
    source: """
    (() => {
      const nativeMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        if (!/prefers-reduced-motion\\s*:\\s*reduce/i.test(query)) return nativeMatchMedia(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return true; }
        };
      };
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: true
)

let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
configuration.userContentController.addUserScript(reducedMotionMatchMedia)

let initialViewport = NSSize(width: 1280, height: 820)
let webView = WKWebView(
    frame: NSRect(origin: .zero, size: initialViewport),
    configuration: configuration
)
let window = NSWindow(
    contentRect: NSRect(x: -2400, y: -2400, width: initialViewport.width, height: initialViewport.height),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.contentView = webView
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(webView)

let navigationWaiter = NavigationWaiter()
webView.navigationDelegate = navigationWaiter
webView.load(URLRequest(url: targetURL))
try spinUntil("initial navigation", timeout: 20) { navigationWaiter.finished }
if let error = navigationWaiter.failed {
    throw error
}

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
        let nsError = evalError as NSError
        let message = nsError.userInfo["WKJavaScriptExceptionMessage"] as? String
        throw AccessibilitySmokeError.javascript(message ?? evalError.localizedDescription)
    }
    return result
}

func waitForSelector(_ selector: String, timeout: TimeInterval = 15) throws {
    try spinUntil("selector \(selector)", timeout: timeout) {
        ((try? evaluate("Boolean(document.querySelector(\(jsString(selector))))")) as? Bool) == true
    }
}

func waitForText(_ selector: String, _ expected: String, timeout: TimeInterval = 12) throws {
    try spinUntil("\(selector) text \(expected)", timeout: timeout) {
        let script = "document.querySelector(\(jsString(selector)))?.textContent?.trim() || ''"
        return ((try? evaluate(script)) as? String) == expected
    }
}

func clickTestID(_ testID: String) throws {
    try evaluate("""
    (() => {
      const element = document.querySelector('[data-testid=\(jsString(testID))]');
      if (!element) throw new Error('Missing test id: ' + \(jsString(testID)));
      element.click();
      return true;
    })()
    """)
    settle()
}

func resize(width: CGFloat, height: CGFloat, zoom: CGFloat) {
    let size = NSSize(width: width, height: height)
    window.setContentSize(size)
    webView.setFrameSize(size)
    webView.pageZoom = zoom
    webView.layoutSubtreeIfNeeded()
    window.displayIfNeeded()
    settle(0.35)
}

func sendKey(code: UInt16, characters: String, modifiers: NSEvent.ModifierFlags = []) {
    window.makeFirstResponder(webView)
    let timestamp = ProcessInfo.processInfo.systemUptime
    for type in [NSEvent.EventType.keyDown, NSEvent.EventType.keyUp] {
        if let event = NSEvent.keyEvent(
            with: type,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: timestamp,
            windowNumber: window.windowNumber,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: code
        ) {
            window.sendEvent(event)
        }
    }
    settle(0.12)
}

func sendTab(reverse: Bool = false) {
    sendKey(code: 48, characters: "\t", modifiers: reverse ? [.shift] : [])
}

func sendEscape() {
    sendKey(code: 53, characters: "\u{1b}")
}

struct RouteExpectation {
    let id: String
    let surfaceSelector: String
    let primarySelector: String
    let englishTitle: String
    let chineseTitle: String
}

let routes = [
    RouteExpectation(
        id: "loops",
        surfaceSelector: "[data-testid='loopops.loops.board']",
        primarySelector: "[data-testid='loopops.topbar.primary.create-loop']",
        englishTitle: "Loop lifecycle",
        chineseTitle: "工作流生命周期"
    ),
    RouteExpectation(
        id: "skills",
        surfaceSelector: "[data-testid='loopops.skills.surface']",
        primarySelector: "[data-testid='loopops.skills.create']",
        englishTitle: "Skills",
        chineseTitle: "技能"
    ),
    RouteExpectation(
        id: "library",
        surfaceSelector: "[data-testid='loopops.library.surface']",
        primarySelector: "[data-testid='loopops.global-create']",
        englishTitle: "Team library",
        chineseTitle: "团队资源库"
    ),
]

try waitForSelector(routes[0].surfaceSelector, timeout: 20)
try waitForText("h1", routes[0].englishTitle, timeout: 20)

var failures: [String] = []
var zoomEvidence: [[String: Any]] = []
var labelEvidence: [[String: Any]] = []

func record(_ condition: Bool, _ message: String) {
    if !condition {
        failures.append(message)
    }
}

// Apply the production reduced-motion media rules to this isolated WebView. WKWebView has no
// public media-feature override, so the script also injects matchMedia(reduce) before app startup.
let reducedMotionJSON = try evaluate("""
(() => {
  const snippets = [];
  const scan = (rules) => {
    for (const rule of [...rules]) {
      if (rule.type === CSSRule.MEDIA_RULE && /prefers-reduced-motion\\s*:\\s*reduce/i.test(rule.conditionText || '')) {
        snippets.push([...rule.cssRules].map((child) => child.cssText).join('\\n'));
      } else if (rule.cssRules && rule.type !== CSSRule.STYLE_RULE) {
        scan(rule.cssRules);
      }
    }
  };
  for (const sheet of [...document.styleSheets]) {
    try { scan(sheet.cssRules); } catch (error) { /* Cross-origin sheets are not inspectable. */ }
  }
  const style = document.createElement('style');
  style.dataset.accessibilitySmokeReducedMotion = 'true';
  style.textContent = snippets.join('\\n');
  document.head.append(style);

  const probe = document.createElement('span');
  probe.className = 'spin';
  probe.style.position = 'fixed';
  probe.style.left = '-100px';
  probe.style.width = '12px';
  probe.style.height = '12px';
  document.body.append(probe);

  const milliseconds = (value) => Math.max(0, ...value.split(',').map((part) => {
    const text = part.trim();
    return text.endsWith('ms') ? Number.parseFloat(text) : Number.parseFloat(text) * 1000;
  }).filter(Number.isFinite), 0);
  const violations = [];
  let maxAnimationMs = 0;
  let maxTransitionMs = 0;
  for (const element of [...document.querySelectorAll('*')]) {
    const computed = getComputedStyle(element);
    const animationMs = milliseconds(computed.animationDuration);
    const transitionMs = milliseconds(computed.transitionDuration);
    maxAnimationMs = Math.max(maxAnimationMs, animationMs);
    maxTransitionMs = Math.max(maxTransitionMs, transitionMs);
    if (computed.animationName !== 'none' && animationMs > 1) {
      violations.push({ kind: 'animation', tag: element.tagName.toLowerCase(), durationMs: animationMs, name: computed.animationName });
    }
    if (transitionMs > 1) {
      violations.push({ kind: 'transition', tag: element.tagName.toLowerCase(), durationMs: transitionMs, property: computed.transitionProperty });
    }
  }
  const probeStyle = getComputedStyle(probe);
  const result = {
    matchMediaReduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    reducedRuleCount: snippets.length,
    rootScrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    probeAnimationName: probeStyle.animationName,
    probeAnimationDurationMs: milliseconds(probeStyle.animationDuration),
    maxAnimationMs,
    maxTransitionMs,
    violations: violations.slice(0, 20)
  };
  probe.remove();
  return JSON.stringify(result);
})()
""") as? String ?? "{}"
let reducedMotionEvidence = try decodeObject(reducedMotionJSON, label: "reduced-motion evidence")
record(reducedMotionEvidence["matchMediaReduce"] as? Bool == true, "Reduced-motion matchMedia override was not active")
record((reducedMotionEvidence["reducedRuleCount"] as? NSNumber)?.intValue ?? 0 > 0, "No prefers-reduced-motion: reduce rule was found")
record((reducedMotionEvidence["probeAnimationDurationMs"] as? NSNumber)?.doubleValue ?? .infinity <= 1, "Key spinner animation remains sustained under reduced motion")
record((reducedMotionEvidence["maxAnimationMs"] as? NSNumber)?.doubleValue ?? .infinity <= 1, "A page animation remains sustained under reduced motion")
record((reducedMotionEvidence["maxTransitionMs"] as? NSNumber)?.doubleValue ?? .infinity <= 1, "A page transition remains sustained under reduced motion")
record((reducedMotionEvidence["violations"] as? [[String: Any]] ?? []).isEmpty, "Reduced-motion computed styles contain long-running animation or transition declarations")

for width in [1280, 390] {
    resize(width: CGFloat(width), height: width == 390 ? 844 : 800, zoom: 2.0)
    for route in routes {
        try clickTestID("loopops.nav.\(route.id)")
        try waitForSelector(route.surfaceSelector)
        try waitForText("h1", route.englishTitle)
        let json = try evaluate("""
        (() => {
          const primary = document.querySelector(\(jsString(route.primarySelector)));
          if (primary) primary.scrollIntoView({ block: 'center', inline: 'nearest' });
          const rect = primary?.getBoundingClientRect();
          const style = primary ? getComputedStyle(primary) : null;
          let focusReached = false;
          if (primary) {
            primary.focus({ preventScroll: true });
            focusReached = document.activeElement === primary;
          }
          return JSON.stringify({
            route: \(jsString(route.id)),
            viewportWidth: \(width),
            cssViewportWidth: document.documentElement.clientWidth,
            pageZoom: 2,
            documentScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.body.scrollWidth > document.documentElement.clientWidth + 1,
            primaryFound: Boolean(primary),
            primaryVisible: Boolean(primary && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0),
            primaryInViewport: Boolean(rect && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight),
            primaryDisabled: Boolean(primary?.disabled || primary?.getAttribute('aria-disabled') === 'true'),
            primaryFocusReached: focusReached,
            primaryLabel: (primary?.getAttribute('aria-label') || primary?.textContent || primary?.title || '').trim()
          });
        })()
        """) as? String ?? "{}"
        let evidence = try decodeObject(json, label: "zoom evidence")
        zoomEvidence.append(evidence)
        let prefix = "\(width)px at 200% / \(route.id)"
        record(evidence["horizontalOverflow"] as? Bool == false, "\(prefix): page-level horizontal overflow")
        record(evidence["primaryFound"] as? Bool == true, "\(prefix): primary action is missing")
        record(evidence["primaryVisible"] as? Bool == true, "\(prefix): primary action is not visible")
        record(evidence["primaryInViewport"] as? Bool == true, "\(prefix): primary action cannot be scrolled into the viewport")
        record(evidence["primaryDisabled"] as? Bool == false, "\(prefix): primary action is disabled")
        record(evidence["primaryFocusReached"] as? Bool == true, "\(prefix): primary action cannot receive focus")
        record(!(evidence["primaryLabel"] as? String ?? "").isEmpty, "\(prefix): primary action has no accessible label")
    }
}

resize(width: 1280, height: 820, zoom: 1.0)
for locale in ["en", "zh"] {
    try clickTestID("loopops.locale.\(locale)")
    for theme in ["light", "dark"] {
        try clickTestID("loopops.theme.\(theme)")
        for route in routes {
            try clickTestID("loopops.nav.\(route.id)")
            try waitForSelector(route.surfaceSelector)
            try waitForText("h1", locale == "en" ? route.englishTitle : route.chineseTitle)
            let json = try evaluate("""
            (() => {
              const selectors = [
                '[data-testid="loopops.nav.skills"]',
                '[data-testid="loopops.nav.loops"]',
                '[data-testid="loopops.nav.library"]',
                '[data-testid="loopops.global-create"]',
                '[data-testid="loopops.inbox"]',
                '[data-testid="loopops.account-menu"]',
                \(jsString(route.primarySelector))
              ];
              const elements = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
              const accessibleName = (element) => {
                const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
                  .map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
                const labels = element.labels ? [...element.labels].map((label) => label.textContent || '').join(' ').trim() : '';
                return (element.getAttribute('aria-label') || labelledBy || labels || element.textContent || element.title || element.placeholder || '').trim();
              };
              const entries = elements.map((element) => ({
                tag: element.tagName.toLowerCase(),
                testId: element.dataset.testid || '',
                ariaLabel: element.hasAttribute('aria-label') ? (element.getAttribute('aria-label') || '').trim() : null,
                accessibleName: accessibleName(element)
              }));
              return JSON.stringify({
                locale: \(jsString(locale)),
                theme: \(jsString(theme)),
                route: \(jsString(route.id)),
                htmlLang: document.documentElement.lang,
                appliedTheme: document.documentElement.dataset.theme || '',
                controlCount: entries.length,
                emptyAriaLabels: entries.filter((entry) => entry.ariaLabel !== null && !entry.ariaLabel),
                unnamedControls: entries.filter((entry) => !entry.accessibleName),
                controls: entries
              });
            })()
            """) as? String ?? "{}"
            let evidence = try decodeObject(json, label: "label evidence")
            labelEvidence.append(evidence)
            let prefix = "\(locale)/\(theme)/\(route.id)"
            let expectedControlCount = route.id == "library" ? 6 : 7
            record((evidence["controlCount"] as? NSNumber)?.intValue ?? 0 >= expectedControlCount, "\(prefix): key control set is incomplete")
            record((evidence["emptyAriaLabels"] as? [[String: Any]] ?? []).isEmpty, "\(prefix): a key aria-label is empty")
            record((evidence["unnamedControls"] as? [[String: Any]] ?? []).isEmpty, "\(prefix): a key control has no accessible name")
            record(evidence["appliedTheme"] as? String == theme, "\(prefix): requested theme did not apply")
        }
    }
}

try clickTestID("loopops.locale.en")
try clickTestID("loopops.theme.light")
try clickTestID("loopops.nav.skills")
try waitForSelector("[data-testid='loopops.skills.surface']")

let openerID = "loopops.global-create"
let opened = try evaluate("""
(() => {
  const opener = document.querySelector('[data-testid=\(jsString(openerID))]');
  if (!opener) return false;
  opener.focus({ preventScroll: true });
  opener.click();
  return true;
})()
""") as? Bool ?? false
record(opened, "Dialog opener is missing")
try waitForSelector("[data-testid='loopops.global-create.skill']")
try clickTestID("loopops.global-create.skill")
try waitForSelector("[role='dialog'][aria-modal='true']")
settle(0.25)

let dialogOpenJSON = try evaluate("""
(() => {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const focusableSelector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  const focusables = dialog ? [...dialog.querySelectorAll(focusableSelector)].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }) : [];
  return JSON.stringify({
    dialogFound: Boolean(dialog),
    dialogLabel: (dialog?.getAttribute('aria-label') || (dialog?.getAttribute('aria-labelledby') || '').split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')).trim(),
    focusInside: Boolean(dialog?.contains(document.activeElement)),
    focusableCount: focusables.length,
    activeTestId: document.activeElement?.dataset?.testid || '',
    firstTestId: focusables[0]?.dataset?.testid || '',
    lastTestId: focusables.at(-1)?.dataset?.testid || ''
  });
})()
""") as? String ?? "{}"
let dialogOpenEvidence = try decodeObject(dialogOpenJSON, label: "dialog-open evidence")
record(dialogOpenEvidence["dialogFound"] as? Bool == true, "Dialog did not open")
record(!(dialogOpenEvidence["dialogLabel"] as? String ?? "").isEmpty, "Dialog has no accessible label")
record(dialogOpenEvidence["focusInside"] as? Bool == true, "Focus did not enter the dialog")
record((dialogOpenEvidence["focusableCount"] as? NSNumber)?.intValue ?? 0 >= 2, "Dialog does not expose enough focusable controls")

try evaluate("""
(() => {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const first = dialog?.querySelector('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
  first?.focus({ preventScroll: true });
})()
""")
sendTab(reverse: true)
let reverseTrapJSON = try evaluate("""
(() => {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  return JSON.stringify({
    focusInside: Boolean(dialog?.contains(document.activeElement)),
    activeTestId: document.activeElement?.dataset?.testid || '',
    activeTag: document.activeElement?.tagName?.toLowerCase() || ''
  });
})()
""") as? String ?? "{}"
let reverseTrapEvidence = try decodeObject(reverseTrapJSON, label: "reverse focus-trap evidence")
record(reverseTrapEvidence["focusInside"] as? Bool == true, "Shift+Tab escaped the dialog")

try evaluate("""
(() => {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const controls = dialog ? [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')] : [];
  controls.at(-1)?.focus({ preventScroll: true });
})()
""")
sendTab()
let forwardTrapJSON = try evaluate("""
(() => {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  return JSON.stringify({
    focusInside: Boolean(dialog?.contains(document.activeElement)),
    activeTestId: document.activeElement?.dataset?.testid || '',
    activeTag: document.activeElement?.tagName?.toLowerCase() || ''
  });
})()
""") as? String ?? "{}"
let forwardTrapEvidence = try decodeObject(forwardTrapJSON, label: "forward focus-trap evidence")
record(forwardTrapEvidence["focusInside"] as? Bool == true, "Tab escaped the dialog")

sendEscape()
let escapedClosed = (try? spinUntil("dialog close on Escape", timeout: 2) {
    ((try? evaluate("!document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')")) as? Bool) == true
}) ?? false
record(escapedClosed, "Escape did not close the dialog")
let focusRestored = (try? spinUntil("dialog opener focus restoration", timeout: 1) {
    ((try? evaluate("document.activeElement?.dataset?.testid === \(jsString(openerID))")) as? Bool) == true
}) ?? false
record(focusRestored, "Dialog focus was not restored to its opener")
let focusAfterClose = try evaluate("JSON.stringify({ tag: document.activeElement?.tagName?.toLowerCase() || '', testId: document.activeElement?.dataset?.testid || '', text: document.activeElement?.textContent?.trim().slice(0, 80) || '' })") as? String ?? "{}"

let dialogEvidence: [String: Any] = [
    "open": dialogOpenEvidence,
    "reverseTrap": reverseTrapEvidence,
    "forwardTrap": forwardTrapEvidence,
    "escapeClosed": escapedClosed,
    "focusRestored": focusRestored,
    "focusAfterClose": try decodeObject(focusAfterClose, label: "focus after dialog close"),
]

let manifest: [String: Any] = [
    "schemaVersion": "loopops-accessibility-smoke-v1",
    "targetURL": targetURL.absoluteString,
    "reducedMotion": reducedMotionEvidence,
    "zoom": zoomEvidence,
    "labels": labelEvidence,
    "dialog": dialogEvidence,
    "failures": failures,
]
let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
try manifestData.write(to: outputURL)

if failures.isEmpty {
    print("web_accessibility_smoke=pass")
    print("web_accessibility_zoom_cases=\(zoomEvidence.count)")
    print("web_accessibility_label_cases=\(labelEvidence.count)")
    print("web_accessibility_manifest=\(outputURL.path)")
} else {
    FileHandle.standardError.write("web_accessibility_smoke=fail\n".data(using: .utf8)!)
    for failure in failures {
        FileHandle.standardError.write(("- \(failure)\n").data(using: .utf8)!)
    }
    FileHandle.standardError.write(("web_accessibility_manifest=\(outputURL.path)\n").data(using: .utf8)!)
    exit(1)
}
