import AppKit
import Foundation
import WebKit

enum CaptureError: Error, CustomStringConvertible {
    case timeout(String)
    case javascript(String)
    case navigation(String)
    case assertion(String)
    case unavailable(String)
    case snapshot(String)
    case imageEncoding(String)

    var description: String {
        switch self {
        case .timeout(let message), .javascript(let message), .navigation(let message),
             .assertion(let message), .unavailable(let message), .snapshot(let message),
             .imageEncoding(let message):
            return message
        }
    }
}

struct EvidenceViewport: Codable {
    let width: Int
    let height: Int

    var rect: NSRect {
        NSRect(x: 0, y: 0, width: width, height: height)
    }

    var json: [String: Any] {
        ["width": width, "height": height]
    }
}

struct PreparedState: Decodable {
    let route: String
    let objectId: String
    let objectState: String
    let selector: String
    let viewport: EvidenceViewport?
    let locale: String?
    let theme: String?
    let interactionPreconditions: [String]?
    let structuralAssertions: [String]?
}

struct HttpResult {
    let status: Int
    let headers: [AnyHashable: Any]
    let data: Data
}

final class NavigationWaiter: NSObject, WKNavigationDelegate {
    var finished = false
    var failed: Error?

    func reset() {
        finished = false
        failed = nil
    }

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

final class CaptureContext {
    var readyLoopId = ""
    var draftLoopId = ""
    var createdLoopId = ""
    var skillId = ""
    var skillDraftId = ""
    var teamLoopId = ""
    var teamSkillId = ""
    var updateReleaseId = ""
    var runId = ""
}

let viewport1440 = EvidenceViewport(width: 1440, height: 1024)
let viewport1280 = EvidenceViewport(width: 1280, height: 800)
let viewport390 = EvidenceViewport(width: 390, height: 844)
let viewportReference = EvidenceViewport(width: 1487, height: 1058)
let requiredViewportMatrix = [viewportReference, viewport1440, viewport1280, viewport390]
let requiredScreenIds: Set<String> = [
    "loop-lifecycle-board", "loop-create", "loop-ai-proposal-review", "loop-builder-outline",
    "loop-builder-canvas", "loop-run-waiting-review", "loop-run-completed", "loop-publish-review",
    "loop-team-library-update", "loop-overview", "loop-builder-definition", "loop-run-preflight",
    "skills-library", "skill-detail", "skill-create", "skill-upload-import",
    "skill-edit-files-permissions", "skill-validation-test", "skill-versions-diff-usage",
    "skill-publish-update-impact", "team-library-search", "team-library-skill-detail",
    "team-library-loop-detail", "team-library-publish-review", "team-library-update-impact",
    "global-create", "inbox-needs-attention", "state-loading", "state-first-use", "state-empty",
    "state-populated", "state-empty-search", "state-validation-error", "state-needs-setup",
    "state-blocked", "state-offline", "state-reconnecting", "state-permission-denied",
    "state-revision-conflict", "state-server-error", "state-update-available", "state-success",
    "state-recovery", "loop-builder-outline-mobile", "loop-builder-canvas-mobile",
    "loop-builder-library-mobile",
]
let formatter = ISO8601DateFormatter()
let environment = ProcessInfo.processInfo.environment
let commandArguments = Array(CommandLine.arguments.dropFirst())
func commandOption(_ name: String) -> String? {
    let prefix = "--\(name)="
    return commandArguments.first(where: { $0.hasPrefix(prefix) }).map { String($0.dropFirst(prefix.count)) }
}
let allowMutations = environment["LOOPOPS_CAPTURE_ALLOW_MUTATIONS"] == "1" || commandArguments.contains("--allow-mutations")
let captureUserId = (environment["LOOPOPS_CAPTURE_USER_ID"] ?? commandOption("user") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
let captureWorkspaceId = (environment["LOOPOPS_CAPTURE_WORKSPACE_ID"] ?? commandOption("workspace") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let webRootURL = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let defaultOutputURL = webRootURL
    .deletingLastPathComponent()
    .appendingPathComponent("product-design-audit-web", isDirectory: true)
let outputURL = commandArguments.first(where: { !$0.hasPrefix("--") })
    .map { URL(fileURLWithPath: $0).standardizedFileURL }
    ?? defaultOutputURL
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

let targetURLString = environment["LOOPOPS_WEB_URL"] ?? commandOption("url") ?? "http://127.0.0.1:8798/"
guard let targetURL = URL(string: targetURLString),
      ["127.0.0.1", "localhost", "::1"].contains(targetURL.host ?? "") else {
    throw CaptureError.navigation("LOOPOPS_WEB_URL must use a localhost origin")
}

let preparedStates: [String: PreparedState] = try {
    guard let path = environment["LOOPOPS_EVIDENCE_STATE_FILE"], !path.isEmpty else { return [:] }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    return try JSONDecoder().decode([String: PreparedState].self, from: data)
}()

var viewport = viewport1440.rect
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let webView = WKWebView(frame: viewport, configuration: configuration)
let window = NSWindow(
    contentRect: NSRect(x: 20, y: 20, width: viewport.width, height: viewport.height),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.contentView = webView
window.orderFrontRegardless()
let navigationWaiter = NavigationWaiter()
webView.navigationDelegate = navigationWaiter

var shots: [[String: Any]] = []
var failures: [[String: Any]] = []
let context = CaptureContext()

@discardableResult
func spinUntil(_ label: String, timeout: TimeInterval = 20, _ done: () -> Bool) throws -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !done() {
        if Date() > deadline { throw CaptureError.timeout("Timed out while waiting for \(label)") }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return true
}

func settle(_ seconds: TimeInterval = 0.25) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
}

func httpRequest(_ url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil) throws -> HttpResult {
    var result: HttpResult?
    var failure: Error?
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.httpShouldHandleCookies = false
    headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
    let semaphore = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        if let error { failure = error; return }
        guard let response = response as? HTTPURLResponse else {
            failure = CaptureError.navigation("Missing HTTP response for \(url.path)")
            return
        }
        result = HttpResult(status: response.statusCode, headers: response.allHeaderFields, data: data ?? Data())
    }.resume()
    if semaphore.wait(timeout: .now() + 30) == .timedOut {
        throw CaptureError.timeout("Timed out requesting \(url.path)")
    }
    if let failure { throw failure }
    guard let result else { throw CaptureError.navigation("No HTTP response for \(url.path)") }
    return result
}

func jsonObject(_ data: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw CaptureError.assertion("Product API response was not a JSON object")
    }
    return value
}

func apiURL(_ path: String) throws -> URL {
    guard let value = URL(string: path, relativeTo: targetURL)?.absoluteURL, value.host == targetURL.host else {
        throw CaptureError.navigation("Invalid Product API URL: \(path)")
    }
    return value
}

func bootstrapIdentity(_ userId: String, _ workspaceId: String) throws -> HttpResult {
    let response = try httpRequest(try apiURL("/api/workbench/v1/workspace"), headers: [
        "X-Workbench-Test-User": userId,
        "X-Workbench-Test-Workspace": workspaceId,
    ])
    guard response.status == 200 else {
        throw CaptureError.unavailable("Product API test identity bootstrap returned \(response.status)")
    }
    return response
}

func responseHeader(_ result: HttpResult, _ name: String) -> String {
    for (key, value) in result.headers where String(describing: key).caseInsensitiveCompare(name) == .orderedSame {
        return String(describing: value)
    }
    return ""
}

func authenticatedMutationHeaders(_ bootstrap: HttpResult, idempotencyKey: String, ifMatch: String? = nil) throws -> [String: String] {
    let body = try jsonObject(bootstrap.data)
    let data = body["data"] as? [String: Any]
    let session = data?["session"] as? [String: Any]
    let csrf = session?["csrfToken"] as? String ?? ""
    let cookie = responseHeader(bootstrap, "Set-Cookie").split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
    guard !csrf.isEmpty, !cookie.isEmpty else {
        throw CaptureError.assertion("Product API bootstrap did not provide mutation credentials")
    }
    var headers = [
        "Cookie": cookie,
        "X-Workbench-CSRF": csrf,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
        "Origin": "\(targetURL.scheme ?? "http")://\(targetURL.host ?? "127.0.0.1")\(targetURL.port.map { ":\($0)" } ?? "")",
        "Sec-Fetch-Site": "same-origin",
    ]
    if let ifMatch { headers["If-Match"] = ifMatch }
    return headers
}

func apiEnvelope(_ data: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["schemaVersion": "workbench-api-v1", "data": data])
}

func installWebSession(from bootstrap: HttpResult) throws {
    let rawCookie = String(describing: bootstrap.headers["Set-Cookie"] ?? bootstrap.headers["set-cookie"] ?? "")
    let pair = rawCookie.split(separator: ";", maxSplits: 1).first?.split(separator: "=", maxSplits: 1).map(String.init) ?? []
    guard pair.count == 2, let host = targetURL.host else {
        throw CaptureError.assertion("Product API bootstrap did not return a browser session")
    }
    var existing: [HTTPCookie] = []
    var read = false
    configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in existing = cookies; read = true }
    try spinUntil("existing browser cookies") { read }
    for cookie in existing {
        var deleted = false
        configuration.websiteDataStore.httpCookieStore.delete(cookie) { deleted = true }
        try spinUntil("browser cookie removal") { deleted }
    }
    var properties: [HTTPCookiePropertyKey: Any] = [
        .originURL: targetURL,
        .domain: host,
        .path: "/",
        .name: pair[0],
        .value: pair[1],
    ]
    if targetURL.scheme == "https" { properties[.secure] = "TRUE" }
    guard let cookie = HTTPCookie(properties: properties) else {
        throw CaptureError.assertion("Could not construct the isolated browser session")
    }
    var installed = false
    configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { installed = true }
    try spinUntil("browser session installation") { installed }
}

func inviteViewer(owner: HttpResult, viewerId: String) throws {
    let ownerBody = try jsonObject(owner.data)
    let data = ownerBody["data"] as? [String: Any]
    let session = data?["session"] as? [String: Any]
    let csrf = session?["csrfToken"] as? String ?? ""
    let cookie = String(describing: owner.headers["Set-Cookie"] ?? owner.headers["set-cookie"] ?? "")
        .split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
    guard !csrf.isEmpty, !cookie.isEmpty else {
        throw CaptureError.assertion("Owner session is incomplete")
    }
    let payload = try JSONSerialization.data(withJSONObject: [
        "schemaVersion": "workbench-api-v1",
        "data": ["userId": viewerId, "displayName": "Visual review member", "role": "viewer"],
    ])
    let origin = "\(targetURL.scheme ?? "http")://\(targetURL.host ?? "127.0.0.1")\(targetURL.port.map { ":\($0)" } ?? "")"
    let response = try httpRequest(
        try apiURL("/api/workbench/v1/workspace/memberships"),
        method: "POST",
        headers: [
            "Cookie": cookie,
            "Origin": origin,
            "Sec-Fetch-Site": "same-origin",
            "X-Workbench-CSRF": csrf,
            "Idempotency-Key": "visual-evidence-viewer-membership",
            "Content-Type": "application/json",
        ],
        body: payload
    )
    guard response.status == 201 || response.status == 409 else {
        throw CaptureError.unavailable("Viewer membership preparation returned \(response.status)")
    }
}

func jsString(_ value: String) -> String {
    let data = try! JSONEncoder().encode(value)
    return String(data: data, encoding: .utf8)!
}

@discardableResult
func evaluate(_ javascript: String, timeout: TimeInterval = 20) throws -> Any? {
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
        let exception = nsError.userInfo["WKJavaScriptExceptionMessage"] as? String
        throw CaptureError.javascript(exception ?? evalError.localizedDescription)
    }
    return result
}

func routeURL(_ route: String) throws -> URL {
    guard route.hasPrefix("/"), !route.hasPrefix("//"),
          !route.lowercased().contains(".html"),
          let url = URL(string: route, relativeTo: targetURL)?.absoluteURL,
          url.host == targetURL.host else {
        throw CaptureError.navigation("Evidence route must be a same-origin React route: \(route)")
    }
    return url
}

func navigate(_ route: String) throws {
    navigationWaiter.reset()
    webView.load(URLRequest(url: try routeURL(route)))
    try spinUntil("navigation to \(route)", timeout: 30) { navigationWaiter.finished }
    if let error = navigationWaiter.failed { throw error }
    try waitForVisibleSelector("[data-testid='loopops.prototype.shell']", timeout: 30)
}

func currentRoute() throws -> String {
    try evaluate("location.pathname + location.search") as? String ?? ""
}

func resizeViewport(_ target: EvidenceViewport) {
    viewport = target.rect
    window.setContentSize(viewport.size)
    webView.frame = viewport
    settle(target.width <= 420 ? 0.8 : 0.3)
}

func waitForVisibleSelector(_ selector: String, timeout: TimeInterval = 25) throws {
    let expression = """
    (() => {
      const el = document.querySelector(\(jsString(selector)));
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    })()
    """
    try spinUntil("visible selector \(selector)", timeout: timeout) {
        ((try? evaluate(expression)) as? Bool) == true
    }
}

func clickTestID(_ testID: String) throws {
    try evaluate("""
    (() => {
      const el = document.querySelector('[data-testid="\(testID)"]');
      if (!el) throw new Error('Missing test id: \(testID)');
      if (el.disabled) throw new Error('Disabled test id: \(testID)');
      el.click();
      return true;
    })()
    """)
    settle(0.2)
}

func clickSelector(_ selector: String) throws {
    try evaluate("""
    (() => {
      const el = document.querySelector(\(jsString(selector)));
      if (!el) throw new Error('Missing selector: ' + \(jsString(selector)));
      if (el.disabled) throw new Error('Disabled selector: ' + \(jsString(selector)));
      el.click();
      return true;
    })()
    """)
    settle(0.2)
}

func setFormValue(_ selector: String, _ value: String) throws {
    try evaluate("""
    (() => {
      const el = document.querySelector(\(jsString(selector)));
      if (!el) throw new Error('Missing field: ' + \(jsString(selector)));
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
      if (setter) setter.call(el, \(jsString(value))); else el.value = \(jsString(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
    """)
    settle(0.08)
}

func setPresentation(locale: String, theme: String) throws {
    guard ["en", "zh"].contains(locale), ["light", "dark"].contains(theme) else {
        throw CaptureError.assertion("Unsupported locale/theme: \(locale)/\(theme)")
    }
    try clickTestID("loopops.locale.\(locale)")
    try clickTestID("loopops.theme.\(theme)")
    try spinUntil("locale/theme \(locale)/\(theme)") {
        ((try? evaluate("document.documentElement.dataset.locale === '\(locale)' && document.documentElement.dataset.theme === '\(theme)'")) as? Bool) == true
    }
}

func prepareForCapture(_ target: EvidenceViewport) throws {
    try spinUntil("font rendering", timeout: 15) {
        ((try? evaluate("!document.fonts || document.fonts.status === 'loaded'")) as? Bool) == true
    }
    webView.layoutSubtreeIfNeeded()
    window.displayIfNeeded()
    settle(target.width <= 420 ? 1.2 : 0.6)
}

func pageInfo() throws -> [String: Any] {
    let result = try evaluate("""
    (() => {
      const overflowDetails = [...document.querySelectorAll('body *')]
        .filter((el) => !el.closest('[data-testid="loopops.builder.canvas"]'))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            testId: el.getAttribute('data-testid') || '',
            text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width)
          };
        })
        .filter((item) => item.right > document.documentElement.clientWidth + 1 || item.left < -1)
        .slice(0, 8)
        .map((item) => `${item.tag}#${item.testId} right=${item.right} width=${item.width} text=${item.text}`);
      return {
        h1: document.querySelector('h1')?.textContent.trim() || '',
        h2s: [...document.querySelectorAll('h2')].slice(0, 8).map((el) => el.textContent.trim()),
        hasHorizontalOverflow: overflowDetails.length > 0,
        overflowDetails,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth
      };
    })()
    """)
    return result as? [String: Any] ?? [:]
}

func snapshot(_ filename: String, target: EvidenceViewport) throws -> URL {
    var image: NSImage?
    var snapshotError: Error?
    var finished = false
    let configuration = WKSnapshotConfiguration()
    configuration.rect = target.rect
    webView.takeSnapshot(with: configuration) { capturedImage, error in
        image = capturedImage
        snapshotError = error
        finished = true
    }
    try spinUntil("snapshot \(filename)", timeout: 20) { finished }
    if let snapshotError { throw CaptureError.snapshot(snapshotError.localizedDescription) }
    guard let tiffData = image?.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiffData),
          let pngData = bitmap.representation(using: .png, properties: [:]) else {
        throw CaptureError.imageEncoding("Could not encode \(filename) as PNG")
    }
    let fileURL = outputURL.appendingPathComponent(filename)
    try pngData.write(to: fileURL)
    return fileURL
}

func performCapture(
    screenId: String,
    category: String,
    referencePath: String?,
    filename: String,
    route: String,
    objectId: String,
    objectState: String,
    target: EvidenceViewport,
    locale: String,
    theme: String,
    interactionPreconditions: [String],
    structuralAssertions: [String],
    requiredSelectors: [String],
    visibleDeviations: [String] = [],
    resetScroll: Bool = true,
    prepare: () throws -> Void = {}
) throws -> [String: Any] {
    guard !screenId.isEmpty, !objectId.isEmpty, !objectState.isEmpty,
          !interactionPreconditions.isEmpty, !structuralAssertions.isEmpty else {
        throw CaptureError.assertion("Incomplete evidence metadata for \(screenId)")
    }
    guard requiredViewportMatrix.contains(where: { $0.width == target.width && $0.height == target.height }) else {
        throw CaptureError.assertion("Unsupported evidence viewport for \(screenId): \(target.width)x\(target.height)")
    }
    resizeViewport(target)
    try navigate(route)
    try setPresentation(locale: locale, theme: theme)
    try prepare()
    for selector in requiredSelectors { try waitForVisibleSelector(selector) }
    let actualRoute = try currentRoute()
    guard actualRoute.hasPrefix(route.split(separator: "?").first.map(String.init) ?? route) else {
        throw CaptureError.assertion("Unexpected route for \(screenId): \(actualRoute)")
    }
    if resetScroll {
        try evaluate("window.scrollTo(0, 0); true")
    }
    try prepareForCapture(target)
    let capturedAt = formatter.string(from: Date())
    let fileURL = try snapshot(filename, target: target)
    let info = try pageInfo()
    let h1 = info["h1"] as? String ?? ""
    guard !h1.isEmpty else { throw CaptureError.assertion("Missing h1 for \(screenId)") }
    let overflow = info["hasHorizontalOverflow"] as? Bool ?? true
    let overflowDetails = info["overflowDetails"] as? [String] ?? ["Overflow measurement unavailable"]
    guard !overflow, overflowDetails.isEmpty else {
        throw CaptureError.assertion("Horizontal overflow for \(screenId): \(overflowDetails.joined(separator: " | "))")
    }
    return [
        "screenId": screenId,
        "evidenceCategory": category,
        "referencePath": referencePath ?? NSNull(),
        "actualPath": fileURL.path,
        "actualRoute": actualRoute,
        "objectId": objectId,
        "objectState": objectState,
        "viewport": target.json,
        "locale": locale,
        "theme": theme,
        "capturedAt": capturedAt,
        "interactionPreconditions": interactionPreconditions,
        "structuralAssertions": structuralAssertions,
        "visibleDeviations": visibleDeviations,
        "manualVerdict": [
            "status": "pending",
            "reviewer": NSNull(),
            "reviewedAt": NSNull(),
        ],
        "h1": h1,
        "h2s": info["h2s"] as? [String] ?? [],
        "hasHorizontalOverflow": false,
        "overflowDetails": [],
        "clientWidth": info["clientWidth"] as? Int ?? target.width,
        "clientHeight": info["clientHeight"] as? Int ?? target.height,
        "scrollWidth": info["scrollWidth"] as? Int ?? target.width,
    ]
}

@discardableResult
func attemptCapture(
    screenId: String,
    category: String,
    referencePath: String? = nil,
    filename: String,
    route: String,
    objectId: String,
    objectState: String,
    target: EvidenceViewport,
    locale: String,
    theme: String,
    interactionPreconditions: [String],
    structuralAssertions: [String],
    requiredSelectors: [String],
    visibleDeviations: [String] = [],
    resetScroll: Bool = true,
    prepare: () throws -> Void = {}
) -> [String: Any]? {
    do {
        let shot = try performCapture(
            screenId: screenId,
            category: category,
            referencePath: referencePath,
            filename: filename,
            route: route,
            objectId: objectId,
            objectState: objectState,
            target: target,
            locale: locale,
            theme: theme,
            interactionPreconditions: interactionPreconditions,
            structuralAssertions: structuralAssertions,
            requiredSelectors: requiredSelectors,
            visibleDeviations: visibleDeviations,
            resetScroll: resetScroll,
            prepare: prepare
        )
        shots.append(shot)
        return shot
    } catch {
        recordFailure(
            screenId: screenId,
            category: category,
            referencePath: referencePath,
            route: route,
            objectId: objectId,
            objectState: objectState,
            target: target,
            locale: locale,
            theme: theme,
            interactionPreconditions: interactionPreconditions,
            structuralAssertions: structuralAssertions,
            error: error
        )
        return nil
    }
}

func recordFailure(
    screenId: String,
    category: String,
    referencePath: String?,
    route: String,
    objectId: String,
    objectState: String,
    target: EvidenceViewport,
    locale: String,
    theme: String,
    interactionPreconditions: [String],
    structuralAssertions: [String],
    error: Error
) {
    failures.append([
        "screenId": screenId,
        "evidenceCategory": category,
        "referencePath": referencePath ?? NSNull(),
        "actualPath": NSNull(),
        "actualRoute": route,
        "objectId": objectId.isEmpty ? NSNull() : objectId,
        "objectState": objectState,
        "viewport": target.json,
        "locale": locale,
        "theme": theme,
        "capturedAt": formatter.string(from: Date()),
        "interactionPreconditions": interactionPreconditions,
        "structuralAssertions": structuralAssertions,
        "visibleDeviations": ["Capture failed: \(error)"],
        "manualVerdict": ["status": "pending", "reviewer": NSNull(), "reviewedAt": NSNull()],
        "error": String(describing: error),
    ])
}

func requireId(_ value: String, _ label: String) throws -> String {
    guard !value.isEmpty else { throw CaptureError.unavailable("No reproducible \(label) exists in the current Product API workspace") }
    return value
}

func testIdSuffix(_ selector: String, prefix: String) throws -> String {
    let value = try evaluate("document.querySelector(\(jsString(selector)))?.getAttribute('data-testid') || ''") as? String ?? ""
    return value.hasPrefix(prefix) ? String(value.dropFirst(prefix.count)) : ""
}

func discoverContext() throws {
    resizeViewport(viewport1440)
    try navigate("/loops")
    try setPresentation(locale: "en", theme: "light")
    try waitForVisibleSelector("[data-testid='loopops.loops.board']")
    context.readyLoopId = try evaluate("""
    (() => {
      const buttons = [...document.querySelectorAll('[data-testid^="loopops.loops.action."]')];
      const button = buttons.find((item) => item.closest('[data-loop-stage="ready"]'));
      return button?.getAttribute('data-testid')?.replace('loopops.loops.action.', '') || '';
    })()
    """) as? String ?? ""
    context.draftLoopId = try evaluate("""
    (() => {
      const buttons = [...document.querySelectorAll('[data-testid^="loopops.loops.action."]')];
      const button = buttons.find((item) => item.closest('[data-loop-stage="draft"]'));
      return button?.getAttribute('data-testid')?.replace('loopops.loops.action.', '') || '';
    })()
    """) as? String ?? ""

    try navigate("/skills")
    try setPresentation(locale: "en", theme: "light")
    try waitForVisibleSelector("[data-testid='loopops.skills.surface']")
    context.skillId = try evaluate("document.querySelector('.skillsTable [role=\"row\"][data-row-id]')?.getAttribute('data-row-id') || ''") as? String ?? ""
    context.skillDraftId = try evaluate("""
    (() => {
      const rows = [...document.querySelectorAll('.skillsTable [role="row"][data-row-id]')];
      const draft = rows.find((row) => row.querySelector('[data-testid^="loopops.skills.add."]')?.disabled === true);
      return draft?.getAttribute('data-row-id') || '';
    })()
    """) as? String ?? ""
    if context.skillDraftId.isEmpty && allowMutations {
        let evidenceSkillName = "Decision follow-up writer"
        try clickTestID("loopops.global-create")
        try clickTestID("loopops.global-create.skill")
        try waitForVisibleSelector("[data-testid='loopops.create-skill.name']")
        try setFormValue("[data-testid='loopops.create-skill.name']", evidenceSkillName)
        try setFormValue("[data-testid='loopops.create-skill.description']", "Turns meeting notes into a concise action list with clear owners and due dates.")
        try setFormValue("[data-testid='loopops.create-skill.category']", "Meeting operations")
        try clickTestID("loopops.create-skill.submit")
        try waitForVisibleSelector("[data-testid='loopops.create-skill.package-review']", timeout: 90)
        let acknowledgementVisible = try evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-skill.executable-acknowledgement\"]'))") as? Bool == true
        if acknowledgementVisible {
            try evaluate("document.querySelector('[data-testid=\"loopops.create-skill.executable-acknowledgement\"]')?.click(); true")
        }
        try clickTestID("loopops.create-skill.create-draft")
        try spinUntil("created Skill route", timeout: 90) { ((try? currentRoute()) ?? "").hasPrefix("/skills/") }
        let createdSkillId = try currentRoute().split(separator: "/").dropFirst().first.map(String.init) ?? ""
        context.skillDraftId = createdSkillId
        if context.skillId.isEmpty { context.skillId = createdSkillId }
        try navigate("/skills")
        try setPresentation(locale: "en", theme: "light")
    }

    try navigate("/library")
    try setPresentation(locale: "en", theme: "light")
    try waitForVisibleSelector("[data-testid='loopops.library.surface']")
    let assets = try evaluate("""
    [...document.querySelectorAll('[data-testid^="loopops.library.open."]')].map((button) => {
      const row = button.closest('.teamAssetRow');
      const kind = row?.querySelector('.teamAssetIdentity small')?.textContent?.trim().toLowerCase() || '';
      return { testId: button.getAttribute('data-testid'), kind };
    })
    """) as? [[String: Any]] ?? []
    for asset in assets {
        guard let testId = asset["testId"] as? String else { continue }
        let kind = (asset["kind"] as? String ?? "").lowercased()
        try clickTestID(testId)
        try spinUntil("Team library object route") {
            ((try? currentRoute()) ?? "/library") != "/library"
        }
        let route = try currentRoute()
        if route.hasPrefix("/library/loops/") && context.teamLoopId.isEmpty {
            context.teamLoopId = String(route.dropFirst("/library/loops/".count))
        } else if route.hasPrefix("/library/skills/") && context.teamSkillId.isEmpty {
            context.teamSkillId = String(route.dropFirst("/library/skills/".count))
        } else if kind.contains("loop") && context.teamLoopId.isEmpty {
            context.teamLoopId = String(route.split(separator: "/").last ?? "")
        } else if kind.contains("skill") && context.teamSkillId.isEmpty {
            context.teamSkillId = String(route.split(separator: "/").last ?? "")
        }
        try navigate("/library")
        try setPresentation(locale: "en", theme: "light")
    }
    context.updateReleaseId = try testIdSuffix(
        "[data-testid^='loopops.library.review-update.']",
        prefix: "loopops.library.review-update."
    )
    if context.updateReleaseId.isEmpty && allowMutations {
        let installedOlderRelease = try evaluate("""
        (() => {
          const rows = [...document.querySelectorAll('.teamAssetTable > .teamAssetRow:not(.teamAssetHeader)')];
          const groups = new Map();
          rows.forEach((row) => {
            const title = row.querySelector('.teamAssetIdentity strong')?.textContent?.trim() || '';
            if (!groups.has(title)) groups.set(title, []);
            groups.get(title).push(row);
          });
          for (const group of groups.values()) {
            if (group.length < 2) continue;
            const candidate = [...group].reverse().find((row) => [...row.querySelectorAll('.teamAssetActions button')].some((button) => /install/i.test(button.textContent || '')));
            const button = candidate && [...candidate.querySelectorAll('.teamAssetActions button')].find((item) => /install/i.test(item.textContent || ''));
            if (button) { button.click(); return true; }
          }
          return false;
        })()
        """) as? Bool == true
        if installedOlderRelease {
            try waitForVisibleSelector("[data-testid^='loopops.library.review-update.']", timeout: 45)
            context.updateReleaseId = try testIdSuffix(
                "[data-testid^='loopops.library.review-update.']",
                prefix: "loopops.library.review-update."
            )
        }
    }
}

func ensureFiveBuilderSteps() throws {
    let resourceModes = ["skills", "materials", "gates", "outputs"]
    for attempt in 0..<8 {
        let current = try evaluate("Math.max(document.querySelectorAll('.outlineList > li').length, document.querySelectorAll('.canvasNode').length)") as? Int ?? 0
        if current >= 5 { return }
        let resourceMode = resourceModes[attempt % resourceModes.count]
        let filterId = "loopops.builder.palette.filter.\(resourceMode)"
        let filterExists = try evaluate("Boolean(document.querySelector('[data-testid=\"\(filterId)\"]'))") as? Bool == true
        if filterExists {
            try clickTestID(filterId)
            settle(0.1)
        }
        let preferredIndex = attempt == 2 ? 1 : 0
        let added = try evaluate("""
        (() => {
          const buttons = [...document.querySelectorAll('.resourcePanel .libraryAddButton')];
          const available = buttons.filter((item) => !item.disabled && item.offsetParent !== null);
          const button = available[\(preferredIndex)] || available[0];
          if (!button) return false;
          button.click();
          return true;
        })()
        """) as? Bool == true
        if !added { continue }
        try spinUntil("next Builder step", timeout: 12) {
            ((try? evaluate("Math.max(document.querySelectorAll('.outlineList > li').length, document.querySelectorAll('.canvasNode').length)")) as? Int ?? 0) > current
        }
    }
    throw CaptureError.unavailable("Five real Builder steps could not be assembled from the available Skill picker resources")
}

func normalizeBuilderEvidenceSteps() throws {
    let duplicateReviewId = try evaluate("""
    (() => {
      const nodes = [...document.querySelectorAll('.canvasNode')];
      const hasMaterial = nodes.some((node) => ['material', 'knowledge'].includes(node.dataset.nodeType || ''));
      const reviews = nodes.filter((node) => (node.dataset.nodeType || '').includes('review') || (node.dataset.nodeType || '').includes('gate'));
      return !hasMaterial && reviews.length > 1 ? (reviews[1].dataset.nodeId || '') : '';
    })()
    """) as? String ?? ""
    guard !duplicateReviewId.isEmpty else { return }

    let previousCount = try evaluate("document.querySelectorAll('.canvasNode').length") as? Int ?? 0
    try clickTestID("loopops.builder.node.\(duplicateReviewId).delete")
    try spinUntil("duplicate review step removed", timeout: 12) {
        ((try? evaluate("document.querySelectorAll('.canvasNode').length")) as? Int ?? previousCount) < previousCount
    }
    try clickTestID("loopops.builder.palette.filter.materials")
    settle(0.1)
    let added = try evaluate("""
    (() => {
      const button = [...document.querySelectorAll('.resourcePanel .libraryAddButton')]
        .find((item) => !item.disabled && item.offsetParent !== null);
      if (!button) return false;
      button.click();
      return true;
    })()
    """) as? Bool == true
    guard added else { throw CaptureError.unavailable("A material step was not available for the Builder evidence graph") }
    try spinUntil("material Builder step added", timeout: 12) {
        ((try? evaluate("document.querySelectorAll('.canvasNode').length")) as? Int ?? 0) >= previousCount
    }
}

func connectBuilderSequence() throws {
    let joined = try evaluate("""
    (() => {
      const score = (type) => {
        if (type === 'start' || type === 'input') return 0;
        if (type === 'skill' || type === 'transform' || type === 'material') return 1;
        if (type.includes('review') || type.includes('gate')) return 2;
        if (type === 'output' || type === 'result') return 3;
        return 1;
      };
      return [...document.querySelectorAll('.canvasNode')]
        .map((node, index) => {
          const flow = [...node.querySelectorAll('.nodeFlowSection b')].map((item) => item.textContent?.trim() || '-');
          return { id: node.dataset.nodeId, type: node.dataset.nodeType || '', index, hasInput: flow[0] !== '-', hasOutput: flow[1] !== '-' };
        })
        .filter((node) => node.id && node.hasOutput && (score(node.type) === 0 || node.hasInput))
        .sort((left, right) => score(left.type) - score(right.type) || left.index - right.index)
        .map((node) => node.id)
        .join('|');
    })()
    """) as? String ?? ""
    let ids = joined.split(separator: "|").map(String.init)
    guard ids.count >= 3 else { throw CaptureError.unavailable("The Builder did not expose a connectable start, review, and result sequence") }

    for index in 0..<(ids.count - 1) {
        try clickTestID("loopops.builder.node.\(ids[index]).output")
        settle(0.08)
        try clickTestID("loopops.builder.node.\(ids[index + 1]).input")
        settle(0.12)
        let bannerVisible = try evaluate("Boolean(document.querySelector('[data-testid=\"loopops.builder.connection-banner\"]'))") as? Bool == true
        if bannerVisible {
            try clickTestID("loopops.builder.connection.cancel")
            settle(0.05)
        }
    }
}

func ensureBuilderOpen(_ loopId: String) throws {
    let builderVisible = try evaluate("Boolean(document.querySelector('[data-testid=\"loopops.templates.surface\"]'))") as? Bool == true
    if builderVisible { return }

    try navigate("/loops")
    try setPresentation(locale: "en", theme: "light")
    try waitForVisibleSelector("[data-testid='loopops.loops.board']")
    let opened = try evaluate("""
    (() => {
      const card = [...document.querySelectorAll('[data-workflow-id]')]
        .find((item) => item.getAttribute('data-workflow-id') === \(jsString(loopId)));
      const button = card?.querySelector('.lifecycleCardTitle');
      if (!button) return false;
      button.click();
      return true;
    })()
    """) as? Bool == true
    guard opened else { throw CaptureError.unavailable("Editable Loop card was not available on the lifecycle board") }
    try waitForVisibleSelector("[data-testid='loopops.templates.surface']", timeout: 45)
}

func captureProposal() {
    let screenId = "loop-ai-proposal-review"
    let reference = "wiki/design/skill-loop-cloud-workbench-v1/key-frames/02-review-ai-proposal.png"
    let preconditions = [
        "A writable Product API workspace is active",
        "LOOPOPS_CAPTURE_ALLOW_MUTATIONS=1 explicitly permits creating the evidence Loop",
        "The configured Builder provider returns a real proposal",
    ]
    let assertions = ["The proposal review is visible", "Apply and dismiss actions are visible", "No draft graph mutation occurs before confirmation"]
    guard allowMutations else {
        recordFailure(screenId: screenId, category: "loop-reference", referencePath: reference, route: "/loops/new", objectId: "", objectState: "proposal-review", target: viewportReference, locale: "en", theme: "light", interactionPreconditions: preconditions, structuralAssertions: assertions, error: CaptureError.unavailable("Mutation capture is disabled; set LOOPOPS_CAPTURE_ALLOW_MUTATIONS=1 to generate a real proposal"))
        return
    }
    do {
        var shot = try performCapture(
            screenId: screenId,
            category: "loop-reference",
            referencePath: reference,
            filename: "02-loop-ai-proposal-review.png",
            route: "/loops/new",
            objectId: "pending-product-id",
            objectState: "proposal-review",
            target: viewportReference,
            locale: "en",
            theme: "light",
            interactionPreconditions: preconditions,
            structuralAssertions: assertions,
            requiredSelectors: ["[data-testid='loopops.create-loop.proposal-review']"],
            resetScroll: true,
            prepare: {
                try clickTestID("loopops.create-loop.mode.goal")
                try waitForVisibleSelector("[data-testid='loopops.create-loop.goal']")
                try setFormValue("[data-testid='loopops.create-loop.goal']", "Prepare a Weekly Product Review with product signals, key risks, decisions, next actions, and a human review before sharing.")
                try evaluate("document.querySelector('[data-testid=\"loopops.create-loop.submit\"]')?.form?.requestSubmit(); true")
                try spinUntil("proposal review or product-safe error", timeout: 150) {
                    ((try? evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-loop.proposal-review\"]'))")) as? Bool) == true
                        || ((try? evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-loop.proposal-error\"]'))")) as? Bool) == true
                }
                let proposalReady = try evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-loop.proposal-review\"]'))") as? Bool == true
                if !proposalReady {
                    let retryVisible = try evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-loop.proposal-retry\"]'))") as? Bool == true
                    if retryVisible {
                        try clickTestID("loopops.create-loop.proposal-retry")
                        try spinUntil("proposal retry starts", timeout: 10) {
                            ((try? evaluate("!document.querySelector('[data-testid=\"loopops.create-loop.proposal-error\"]')")) as? Bool) == true
                                || ((try? evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-loop.proposal-review\"]'))")) as? Bool) == true
                        }
                        try spinUntil("proposal retry result", timeout: 150) {
                            ((try? evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-loop.proposal-review\"]'))")) as? Bool) == true
                                || ((try? evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-loop.proposal-error\"]'))")) as? Bool) == true
                        }
                    }
                    let retryReady = try evaluate("Boolean(document.querySelector('[data-testid=\"loopops.create-loop.proposal-review\"]'))") as? Bool == true
                    if !retryReady {
                        let message = try evaluate("document.querySelector('[data-testid=\"loopops.create-loop.proposal-error\"]')?.textContent?.trim() || 'Proposal unavailable'") as? String ?? "Proposal unavailable"
                        throw CaptureError.unavailable(message)
                    }
                }
                try evaluate("window.scrollTo(0, 0); true")
                settle(0.25)
            }
        )
        try clickTestID("loopops.create-loop.proposal-apply")
        try spinUntil("applied proposal Builder route", timeout: 45) {
            ((try? currentRoute()) ?? "").hasPrefix("/loops/") && ((try? currentRoute()) ?? "").hasSuffix("/edit")
        }
        let route = try currentRoute()
        let id = route.split(separator: "/").dropFirst().first.map(String.init) ?? ""
        guard !id.isEmpty else { throw CaptureError.assertion("Applied proposal did not expose a Workflow ID") }
        context.createdLoopId = id
        shot["objectId"] = id
        shots.append(shot)
    } catch {
        recordFailure(screenId: screenId, category: "loop-reference", referencePath: reference, route: "/loops/new", objectId: "", objectState: "proposal-review", target: viewportReference, locale: "en", theme: "light", interactionPreconditions: preconditions, structuralAssertions: assertions, error: error)
    }
}

func captureRunStates(loopId: String) {
    let preflightReference = "wiki/design/skill-loop-cloud-workbench-v1/key-frames/11-run-preflight.png"
    attemptCapture(
        screenId: "loop-run-preflight",
        category: "loop-reference",
        referencePath: preflightReference,
        filename: "11-loop-run-preflight.png",
        route: "/loops/\(loopId)/run",
        objectId: loopId,
        objectState: "preflight",
        target: viewport1280,
        locale: "en",
        theme: "light",
        interactionPreconditions: ["A saved Workflow revision exists", "Server compile/readiness is loaded"],
        structuralAssertions: ["Run inputs and pinned steps are visible", "Start Run remains distinct from validation"],
        requiredSelectors: ["[data-testid='loopops.runs.preflight']", "[data-testid='loopops.preflight.inputs']"]
    )

    let reviewPreconditions = ["A real Product API Run is started from the captured preflight", "The Workflow contains a Review Gate", "The Runner reaches waiting_review"]
    let reviewAssertions = ["Candidate result and review packet are visible", "Approve, request changes, and reject remain distinct"]
    guard allowMutations else {
        recordFailure(screenId: "loop-run-waiting-review", category: "loop-reference", referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/05-run-waiting-review.png", route: "/loops/\(loopId)/run", objectId: "", objectState: "waiting-review", target: viewport1280, locale: "en", theme: "dark", interactionPreconditions: reviewPreconditions, structuralAssertions: reviewAssertions, error: CaptureError.unavailable("Run capture is disabled; set LOOPOPS_CAPTURE_ALLOW_MUTATIONS=1"))
        recordFailure(screenId: "loop-run-completed", category: "loop-reference", referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/06-run-completed.png", route: "/loops/\(loopId)/run", objectId: "", objectState: "completed", target: viewport1280, locale: "zh", theme: "light", interactionPreconditions: ["The captured Review Gate is approved through Product API"], structuralAssertions: ["Authoritative final result, evidence, and history are visible"], error: CaptureError.unavailable("Run capture is disabled; set LOOPOPS_CAPTURE_ALLOW_MUTATIONS=1"))
        return
    }

    do {
        try navigate("/loops/\(loopId)/run")
        try setPresentation(locale: "en", theme: "dark")
        try waitForVisibleSelector("[data-testid='loopops.runs.preflight']")
        try evaluate("""
        (() => {
          document.querySelectorAll('[data-testid="loopops.preflight.inputs"] input').forEach((el, index) => {
            const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
            const value = index === 0 ? 'Meeting notes: Alice owns the launch checklist by Friday.' : 'Weekly product review';
            if (setter) setter.call(el, value); else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
          return true;
        })()
        """)
        try clickTestID("loopops.preflight.start")
        try spinUntil("Run detail route", timeout: 60) { ((try? currentRoute()) ?? "").contains("/runs/") }
        let runRoute = try currentRoute()
        let runId = runRoute.split(separator: "/").last.map(String.init) ?? ""
        guard !runId.isEmpty else { throw CaptureError.assertion("Run route did not expose a Run ID") }
        context.runId = runId
        try waitForVisibleSelector("[data-testid='loopops.runs.review-panel']", timeout: 180)
        var waiting = try performCapture(
            screenId: "loop-run-waiting-review",
            category: "loop-reference",
            referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/05-run-waiting-review.png",
            filename: "05-loop-run-waiting-review.png",
            route: runRoute,
            objectId: runId,
            objectState: "waiting-review",
            target: viewport1280,
            locale: "en",
            theme: "dark",
            interactionPreconditions: reviewPreconditions,
            structuralAssertions: reviewAssertions,
            requiredSelectors: ["[data-testid='loopops.runs.review-panel']", "[data-testid='loopops.runs.review.approve']"]
        )
        waiting["actualRoute"] = runRoute
        shots.append(waiting)
        attemptCapture(
            screenId: "state-reconnecting",
            category: "generic-state",
            filename: "generic-state-reconnecting.png",
            route: runRoute,
            objectId: runId,
            objectState: "reconnecting",
            target: viewport390,
            locale: "zh",
            theme: "dark",
            interactionPreconditions: ["A real waiting Review Run is open", "The isolated browser emits an offline event while the Run stream is active"],
            structuralAssertions: ["The interrupted Run remains readable", "Connection loss and the reconnect action are visible"],
            requiredSelectors: ["[data-testid='loopops.runs.reconnect-state']", "[data-testid='loopops.runs.reconnect']"],
            prepare: {
                try evaluate("window.dispatchEvent(new Event('offline')); true")
                try waitForVisibleSelector("[data-testid='loopops.runs.reconnect-state']")
            }
        )
        try evaluate("window.dispatchEvent(new Event('online')); true")
        try waitForVisibleSelector("[data-testid='loopops.runs.review-panel']")
        try clickTestID("loopops.runs.review.approve")
        try waitForVisibleSelector("[data-testid='loopops.runs.final-answer']", timeout: 180)
        attemptCapture(
            screenId: "loop-run-completed",
            category: "loop-reference",
            referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/06-run-completed.png",
            filename: "06-loop-run-completed.png",
            route: runRoute,
            objectId: runId,
            objectState: "completed",
            target: viewport1280,
            locale: "zh",
            theme: "light",
            interactionPreconditions: ["The same Run was approved through the Product API Review Gate", "The authoritative final read model is persisted"],
            structuralAssertions: ["The final answer leads the page", "Timeline, evidence, review history, and rerun remain visible"],
            requiredSelectors: ["[data-testid='loopops.runs.final-answer']", "[data-testid='loopops.workflows.run-ledger']"]
        )
    } catch {
        if !shots.contains(where: { ($0["screenId"] as? String) == "loop-run-waiting-review" }) {
            recordFailure(screenId: "loop-run-waiting-review", category: "loop-reference", referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/05-run-waiting-review.png", route: "/loops/\(loopId)/run", objectId: context.runId, objectState: "waiting-review", target: viewport1280, locale: "en", theme: "dark", interactionPreconditions: reviewPreconditions, structuralAssertions: reviewAssertions, error: error)
        }
        if !shots.contains(where: { ($0["screenId"] as? String) == "loop-run-completed" }) {
            recordFailure(screenId: "loop-run-completed", category: "loop-reference", referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/06-run-completed.png", route: context.runId.isEmpty ? "/loops/\(loopId)/run" : "/loops/\(loopId)/runs/\(context.runId)", objectId: context.runId, objectState: "completed", target: viewport1280, locale: "zh", theme: "light", interactionPreconditions: ["The captured Review Gate is approved through Product API"], structuralAssertions: ["Authoritative final result, evidence, and history are visible"], error: error)
        }
    }
}

func attemptPreparedState(_ screenId: String, fallback: PreparedState? = nil) {
    guard let state = preparedStates[screenId] ?? fallback else {
        recordFailure(
            screenId: screenId,
            category: "generic-state",
            referencePath: nil,
            route: "/loops",
            objectId: "workspace",
            objectState: String(screenId.dropFirst("state-".count)),
            target: viewport390,
            locale: "en",
            theme: "light",
            interactionPreconditions: ["A real Product API/session state for \(screenId) must be prepared before capture"],
            structuralAssertions: ["The state reason and a concrete recovery action are visible"],
            error: CaptureError.unavailable("Missing prepared state \(screenId); provide LOOPOPS_EVIDENCE_STATE_FILE without DOM or fetch stubs")
        )
        return
    }
    attemptCapture(
        screenId: screenId,
        category: "generic-state",
        filename: "generic-\(screenId).png",
        route: state.route,
        objectId: state.objectId,
        objectState: state.objectState,
        target: state.viewport ?? viewport390,
        locale: state.locale ?? "en",
        theme: state.theme ?? "light",
        interactionPreconditions: state.interactionPreconditions ?? ["The Product API/session is prepared in \(state.objectState) state"],
        structuralAssertions: state.structuralAssertions ?? ["The state and its recovery action are visible"],
        requiredSelectors: [state.selector]
    )
}

func captureRevisionConflictState() {
    let screenId = "state-revision-conflict"
    let workspaceId = "visual-evidence-conflict-workspace"
    let ownerId = "visual-evidence-conflict-owner"
    do {
        let owner = try bootstrapIdentity(ownerId, workspaceId)
        let definition: [String: Any] = [
            "goal": "Keep a reproducible conflict recovery state.",
            "context": "Visual acceptance",
            "constraints": [],
            "doneWhen": ["The editor explains how to preserve local changes."],
            "verify": ["A stale save returns a revision conflict."],
            "expectedResult": "A visible conflict recovery panel.",
            "stopRules": [],
        ]
        let created = try httpRequest(
            try apiURL("/api/workbench/v1/loops"),
            method: "POST",
            headers: try authenticatedMutationHeaders(owner, idempotencyKey: "visual-conflict-create-\(Int(Date().timeIntervalSince1970))"),
            body: try apiEnvelope([
                "name": "Conflict recovery evidence",
                "description": "A short-lived Loop used to verify stale revision recovery.",
                "definition": definition,
            ])
        )
        guard created.status == 201 else { throw CaptureError.unavailable("Conflict evidence Loop creation returned \(created.status)") }
        let createdBody = try jsonObject(created.data)
        let createdData = createdBody["data"] as? [String: Any]
        let workflow = createdData?["workflow"] as? [String: Any]
        let revision = createdData?["revision"] as? [String: Any]
        let workflowId = workflow?["workflowId"] as? String ?? ""
        let revisionId = revision?["revisionId"] as? String ?? ""
        let ownerCookie = responseHeader(owner, "Set-Cookie").split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
        let workflowRead = try httpRequest(
            try apiURL("/api/workbench/v1/workflows/\(workflowId)"),
            headers: ["Cookie": ownerCookie]
        )
        let etag = responseHeader(workflowRead, "ETag")
        guard workflowRead.status == 200, !workflowId.isEmpty, !revisionId.isEmpty, !etag.isEmpty, let revision else {
            throw CaptureError.assertion("Conflict evidence Loop response was incomplete")
        }
        try installWebSession(from: owner)

        var externalData: [String: Any] = [
            "baseRevisionId": revisionId,
            "saveReason": "Advance the server revision for stale-save evidence.",
        ]
        for key in ["graph", "inputForm", "outputDefinition", "resourceRefs", "runSettings", "definition"] {
            if let value = revision[key] { externalData[key] = value }
        }
        var externalDefinition = (externalData["definition"] as? [String: Any]) ?? definition
        externalDefinition["context"] = "A second Product API session saved this newer revision."
        externalData["definition"] = externalDefinition

        attemptCapture(
            screenId: screenId,
            category: "generic-state",
            filename: "generic-state-revision-conflict.png",
            route: "/loops/\(workflowId)/edit",
            objectId: workflowId,
            objectState: "revision-conflict",
            target: viewport1280,
            locale: "en",
            theme: "light",
            interactionPreconditions: ["Two real Product API writes target the same saved revision", "The browser keeps unsaved local edits while the second write advances the server revision"],
            structuralAssertions: ["The conflict reason is visible", "Download local changes and explicit latest-version recovery are available"],
            requiredSelectors: ["[data-testid='loopops.builder.revision-conflict']", "[data-testid='loopops.builder.revision-conflict.download']", "[data-testid='loopops.builder.revision-conflict.reload']"],
            prepare: {
                try waitForVisibleSelector("[data-testid='loopops.builder.definition'] textarea")
                try setFormValue("[data-testid='loopops.builder.definition'] textarea", "My unsaved browser change must remain available.")
                let advanced = try httpRequest(
                    try apiURL("/api/workbench/v1/loops/\(workflowId)/revisions"),
                    method: "POST",
                    headers: try authenticatedMutationHeaders(owner, idempotencyKey: "visual-conflict-advance-\(Int(Date().timeIntervalSince1970))", ifMatch: etag),
                    body: try apiEnvelope(externalData)
                )
                guard advanced.status == 201 else { throw CaptureError.unavailable("Conflict evidence revision advance returned \(advanced.status)") }
                try clickTestID("loopops.topbar.primary.save-workflow")
                try waitForVisibleSelector("[data-testid='loopops.builder.revision-conflict']", timeout: 45)
            }
        )
    } catch {
        recordFailure(screenId: screenId, category: "generic-state", referencePath: nil, route: "/loops", objectId: workspaceId, objectState: "revision-conflict", target: viewport1280, locale: "en", theme: "light", interactionPreconditions: ["A real stale Product API revision save is prepared"], structuralAssertions: ["Conflict reason and non-destructive recovery actions are visible"], error: error)
    }
}

func captureInitialLoadingState() {
    let screenId = "state-loading"
    do {
        resizeViewport(viewport1280)
        _ = try? evaluate("localStorage.setItem('loopops.ui.v1', JSON.stringify({ theme: 'light', locale: 'en' })); true")
        navigationWaiter.reset()
        webView.load(URLRequest(url: try routeURL("/loops")))
        try spinUntil("loading navigation", timeout: 30) { navigationWaiter.finished }
        if let error = navigationWaiter.failed { throw error }
        let deadline = Date().addingTimeInterval(8)
        var loadingVisible = false
        while Date() < deadline && !loadingVisible {
            loadingVisible = ((try? evaluate("Boolean(document.querySelector('[data-testid=\"loopops.workspace.loading\"]'))")) as? Bool) == true
            if !loadingVisible { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.005)) }
        }
        guard loadingVisible else { throw CaptureError.unavailable("The real initial Product API loading state completed before the isolated browser could capture it") }
        webView.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let capturedAt = formatter.string(from: Date())
        let fileURL = try snapshot("generic-state-loading.png", target: viewport1280)
        let info = try pageInfo()
        guard (info["hasHorizontalOverflow"] as? Bool) == false else {
            throw CaptureError.assertion("Horizontal overflow in the loading state")
        }
        shots.append([
            "screenId": screenId,
            "evidenceCategory": "generic-state",
            "referencePath": NSNull(),
            "actualPath": fileURL.path,
            "actualRoute": try currentRoute(),
            "objectId": "visual-evidence-empty-workspace",
            "objectState": "loading",
            "viewport": viewport1280.json,
            "locale": "en",
            "theme": "light",
            "capturedAt": capturedAt,
            "interactionPreconditions": ["A fresh HttpOnly Product API session opens the workspace before initial server queries settle"],
            "structuralAssertions": ["The product explains that workspace data is loading", "Navigation remains stable without fake content"],
            "visibleDeviations": [],
            "manualVerdict": ["status": "pending", "reviewer": NSNull(), "reviewedAt": NSNull()],
            "h1": info["h1"] as? String ?? "",
            "h2s": info["h2s"] as? [String] ?? [],
            "hasHorizontalOverflow": false,
            "overflowDetails": [],
            "clientWidth": info["clientWidth"] as? Int ?? viewport1280.width,
            "clientHeight": info["clientHeight"] as? Int ?? viewport1280.height,
            "scrollWidth": info["scrollWidth"] as? Int ?? viewport1280.width,
        ])
    } catch {
        recordFailure(screenId: screenId, category: "generic-state", referencePath: nil, route: "/loops", objectId: "visual-evidence-empty-workspace", objectState: "loading", target: viewport1280, locale: "en", theme: "light", interactionPreconditions: ["A fresh Product API session opens the workspace before initial queries settle"], structuralAssertions: ["The product explains that workspace data is loading"], error: error)
    }
}

// A test-only Product API identity lets visual QA inspect a real isolated workspace.
if !captureUserId.isEmpty || !captureWorkspaceId.isEmpty {
    guard !captureUserId.isEmpty, !captureWorkspaceId.isEmpty else {
        throw CaptureError.assertion("LOOPOPS_CAPTURE_USER_ID and LOOPOPS_CAPTURE_WORKSPACE_ID must be set together")
    }
    let captureIdentity = try bootstrapIdentity(captureUserId, captureWorkspaceId)
    try installWebSession(from: captureIdentity)
}

// Discover reusable Product API identities before capturing. Discovery failure is recorded per screen.
do {
    try discoverContext()
} catch {
    FileHandle.standardError.write("capture_context_discovery=failed \(error)\n".data(using: .utf8)!)
}

attemptCapture(
    screenId: "loop-lifecycle-board",
    category: "loop-reference",
    referencePath: "wiki/design/skill-loop-cloud-workbench-v1/visual-directions/selected-ai-native-lifecycle-board.png",
    filename: "00-loop-lifecycle-board.png",
    route: "/loops",
    objectId: "workspace",
    objectState: "populated",
    target: viewportReference,
    locale: "en",
    theme: "light",
    interactionPreconditions: ["Fresh Product API Loops, Skills, and Team releases are loaded"],
    structuralAssertions: ["Top navigation, command entry, and Draft/Ready/Shared lanes are visible", "No legacy left sidebar is visible"],
    requiredSelectors: ["[data-testid='loopops.global-nav']", "[data-testid='loopops.loops.board']"],
    visibleDeviations: ["The isolated Product API workspace has no validated Ready Loop or published Shared Loop, so those lanes show their real empty states."]
)

attemptCapture(
    screenId: "loop-create",
    category: "loop-reference",
    referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/01-create-loop.png",
    filename: "01-loop-create.png",
    route: "/loops/new",
    objectId: "new-loop",
    objectState: "goal-entry",
    target: viewportReference,
    locale: "en",
    theme: "light",
    interactionPreconditions: ["The global Create action opened the real Loop creation route"],
    structuralAssertions: ["Five creation methods are visible", "Goal, expected result, and proposal review action are distinct"],
    requiredSelectors: ["[data-testid='loopops.create-loop.page']", "[data-testid='loopops.create-loop.mode.goal']"],
    visibleDeviations: ["The global account area uses the current workspace identity instead of the reference avatar and workspace name."]
)

captureProposal()
let builderLoopId = context.createdLoopId.isEmpty
    ? (context.readyLoopId.isEmpty ? context.draftLoopId : context.readyLoopId)
    : context.createdLoopId

if let loopId = try? requireId(builderLoopId, "editable Loop") {
    attemptCapture(
        screenId: "loop-builder-outline",
        category: "loop-reference",
        referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/03-builder-outline.png",
        filename: "03-loop-builder-outline.png",
        route: "/loops/\(loopId)/edit",
        objectId: loopId,
        objectState: "editing-outline",
        target: viewportReference,
        locale: "en",
        theme: "light",
        interactionPreconditions: ["A real saved Workflow revision is selected"],
        structuralAssertions: ["Outline is the primary editor", "Skill Library and Step editor remain contextual"],
        requiredSelectors: ["[data-testid='loopops.builder.outline']"],
        prepare: {
            try ensureBuilderOpen(loopId)
            try clickTestID("loopops.builder.tab.outline")
            try ensureFiveBuilderSteps()
        }
    )
    attemptCapture(
        screenId: "loop-builder-canvas",
        category: "loop-reference",
        referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/04-builder-canvas.png",
        filename: "04-loop-builder-canvas.png",
        route: "/loops/\(loopId)/edit",
        objectId: loopId,
        objectState: "editing-canvas",
        target: viewportReference,
        locale: "en",
        theme: "light",
        interactionPreconditions: ["The same Workflow revision is opened in Canvas mode"],
        structuralAssertions: ["Canvas, node graph, zoom controls, minimap, and compact test dock are visible"],
        requiredSelectors: ["[data-testid='loopops.builder.canvas']"],
        visibleDeviations: [
            "The isolated workspace exposes one executable Skill instead of the five business Skills shown in the reference.",
            "That Skill has no declared input or output ports, so it is marked Needs setup and only compatible real ports are connected.",
        ],
        prepare: {
            try ensureBuilderOpen(loopId)
            try clickTestID("loopops.builder.tab.canvas")
            try ensureFiveBuilderSteps()
            try normalizeBuilderEvidenceSteps()
            try connectBuilderSequence()
            try evaluate("document.querySelector('.canvasNode[data-node-type=\"skill\"] .nodeBody')?.click(); true")
            try clickTestID("loopops.builder.canvas.fit")
            settle(0.35)
        }
    )
    attemptCapture(
        screenId: "loop-builder-outline-mobile",
        category: "responsive",
        filename: "loop-builder-outline-mobile.png",
        route: "/loops/\(loopId)/edit",
        objectId: loopId,
        objectState: "editing-outline-mobile",
        target: viewport390,
        locale: "en",
        theme: "light",
        interactionPreconditions: ["The same saved Workflow revision is opened on a 390px viewport", "Outline mode is selected"],
        structuralAssertions: ["The ordered steps remain readable without page-level horizontal overflow", "Outline actions remain reachable on mobile"],
        requiredSelectors: ["[data-testid='loopops.builder.outline']"],
        resetScroll: false,
        prepare: {
            try ensureBuilderOpen(loopId)
            try clickTestID("loopops.builder.tab.outline")
            try evaluate("document.querySelector('[data-testid=\"loopops.builder.outline\"]')?.scrollIntoView({ block: 'start' }); true")
        }
    )
    attemptCapture(
        screenId: "loop-builder-canvas-mobile",
        category: "responsive",
        filename: "loop-builder-canvas-mobile.png",
        route: "/loops/\(loopId)/edit",
        objectId: loopId,
        objectState: "editing-canvas-mobile",
        target: viewport390,
        locale: "zh",
        theme: "dark",
        interactionPreconditions: ["The same saved Workflow revision is opened on a 390px viewport", "Canvas mode is selected"],
        structuralAssertions: ["The workflow graph appears in the first viewport", "The desktop Skill picker is replaced by an explicit mobile library action"],
        requiredSelectors: ["[data-testid='loopops.builder.canvas']", "[data-testid='loopops.builder.mobile-library.open']"],
        prepare: {
            try ensureBuilderOpen(loopId)
            try clickTestID("loopops.builder.tab.canvas")
            try clickTestID("loopops.builder.canvas.fit")
            settle(0.3)
        }
    )
    attemptCapture(
        screenId: "loop-builder-library-mobile",
        category: "responsive",
        filename: "loop-builder-library-mobile.png",
        route: "/loops/\(loopId)/edit",
        objectId: loopId,
        objectState: "skill-library-open-mobile",
        target: viewport390,
        locale: "zh",
        theme: "dark",
        interactionPreconditions: ["Canvas mode is selected on a 390px viewport", "The user opens the Skill picker"],
        structuralAssertions: ["The Skill picker is an opaque full-screen temporary drawer", "Search, categories, add actions, and the close action remain reachable"],
        requiredSelectors: ["[data-testid='loopops.builder.palette']", "[data-testid='loopops.builder.mobile-library.close']"],
        prepare: {
            try ensureBuilderOpen(loopId)
            try clickTestID("loopops.builder.tab.canvas")
            try clickTestID("loopops.builder.mobile-library.open")
        }
    )
    attemptCapture(
        screenId: "loop-overview",
        category: "loop-reference",
        referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/09-loop-overview.png",
        filename: "09-loop-overview.png",
        route: "/loops/\(loopId)",
        objectId: loopId,
        objectState: "overview",
        target: viewport1440,
        locale: "en",
        theme: "light",
        interactionPreconditions: ["A real Workflow and canonical revision are loaded"],
        structuralAssertions: ["Purpose, ordered steps, revision, latest Run, and next action are visible"],
        requiredSelectors: ["[data-testid='loopops.loops.overview']"]
    )
    attemptCapture(
        screenId: "loop-builder-definition",
        category: "loop-reference",
        referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/10-builder-definition.png",
        filename: "10-loop-builder-definition.png",
        route: "/loops/\(loopId)/edit",
        objectId: loopId,
        objectState: "editing-definition",
        target: viewport1280,
        locale: "en",
        theme: "dark",
        interactionPreconditions: ["The same Workflow revision is opened in Definition mode"],
        structuralAssertions: ["Goal, context, completion, verification, result, and stop rules are visible"],
        requiredSelectors: ["[data-testid='loopops.builder.definition']"],
        prepare: { try clickTestID("loopops.builder.tab.definition") }
    )
} else {
    for item in [
        ("loop-builder-outline", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/03-builder-outline.png", "editing-outline"),
        ("loop-builder-canvas", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/04-builder-canvas.png", "editing-canvas"),
        ("loop-overview", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/09-loop-overview.png", "overview"),
        ("loop-builder-definition", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/10-builder-definition.png", "editing-definition"),
    ] {
        recordFailure(screenId: item.0, category: "loop-reference", referencePath: item.1, route: "/loops", objectId: "", objectState: item.2, target: viewport1280, locale: "en", theme: "light", interactionPreconditions: ["A real editable Loop must exist"], structuralAssertions: ["The selected Loop state is visible"], error: CaptureError.unavailable("No editable Loop exists"))
    }
    for item in [
        ("loop-builder-outline-mobile", "editing-outline-mobile"),
        ("loop-builder-canvas-mobile", "editing-canvas-mobile"),
        ("loop-builder-library-mobile", "skill-library-open-mobile"),
    ] {
        recordFailure(screenId: item.0, category: "responsive", referencePath: nil, route: "/loops", objectId: "", objectState: item.1, target: viewport390, locale: "zh", theme: "dark", interactionPreconditions: ["A real editable Loop must exist"], structuralAssertions: ["The selected responsive Builder state is visible"], error: CaptureError.unavailable("No editable Loop exists"))
    }
}

if let readyLoopId = try? requireId(context.readyLoopId, "ready Loop") {
    captureRunStates(loopId: readyLoopId)
    attemptCapture(
        screenId: "loop-publish-review",
        category: "loop-reference",
        referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/07-publish-review.png",
        filename: "07-loop-publish-review.png",
        route: "/loops/\(readyLoopId)/publish",
        objectId: readyLoopId,
        objectState: "publish-review",
        target: viewport1280,
        locale: "en",
        theme: "light",
        interactionPreconditions: ["The current Workflow revision is saved, validated, and tested"],
        structuralAssertions: ["Version, changes, permissions, dependencies, notes, and consent are visible"],
        requiredSelectors: ["[data-testid='loopops.publish.surface']"]
    )
} else {
    for item in [
        ("loop-run-preflight", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/11-run-preflight.png", "preflight"),
        ("loop-run-waiting-review", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/05-run-waiting-review.png", "waiting-review"),
        ("loop-run-completed", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/06-run-completed.png", "completed"),
        ("loop-publish-review", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/07-publish-review.png", "publish-review"),
    ] {
        recordFailure(screenId: item.0, category: "loop-reference", referencePath: item.1, route: "/loops", objectId: "", objectState: item.2, target: viewport1280, locale: "en", theme: "light", interactionPreconditions: ["A real ready Loop must exist"], structuralAssertions: ["The selected Loop lifecycle state is visible"], error: CaptureError.unavailable("No ready Loop exists"))
    }
}

if !context.updateReleaseId.isEmpty {
    attemptCapture(
        screenId: "loop-team-library-update",
        category: "loop-reference",
        referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/08-team-library-update.png",
        filename: "08-loop-team-library-update.png",
        route: "/library",
        objectId: context.updateReleaseId,
        objectState: "update-review",
        target: viewport1280,
        locale: "zh",
        theme: "light",
        interactionPreconditions: ["A Team Loop installation has a newer immutable release"],
        structuralAssertions: ["Installed and available versions, impact, keep-current, and update actions are visible"],
        requiredSelectors: ["[data-testid='loopops.library.update-review.\(context.updateReleaseId)']"],
        prepare: { try clickTestID("loopops.library.review-update.\(context.updateReleaseId)") }
    )
} else {
    recordFailure(screenId: "loop-team-library-update", category: "loop-reference", referencePath: "wiki/design/skill-loop-cloud-workbench-v1/key-frames/08-team-library-update.png", route: "/library", objectId: "", objectState: "update-review", target: viewport1280, locale: "zh", theme: "light", interactionPreconditions: ["A Team asset with an available update must exist"], structuralAssertions: ["Version transition and update impact are visible"], error: CaptureError.unavailable("No adoptable Team release exists"))
}

// Skills evidence.
attemptCapture(screenId: "skills-library", category: "skills", filename: "skills-library.png", route: "/skills", objectId: "workspace", objectState: "populated", target: viewport1440, locale: "en", theme: "light", interactionPreconditions: ["Fresh Product API Skill catalog is loaded"], structuralAssertions: ["Search, create action, Skill list, and detail preview are visible"], requiredSelectors: ["[data-testid='loopops.skills.surface']"])

if let skillId = try? requireId(context.skillId, "Skill") {
    attemptCapture(screenId: "skill-detail", category: "skills", filename: "skill-detail.png", route: "/skills/\(skillId)", objectId: skillId, objectState: "overview", target: viewport1280, locale: "zh", theme: "light", interactionPreconditions: ["A real managed Skill is selected"], structuralAssertions: ["Needs, creates, permissions, files, usage, and version are visible"], requiredSelectors: ["[data-testid='loopops.skill.overview']"])
    attemptCapture(screenId: "skill-versions-diff-usage", category: "skills", filename: "skill-versions-diff-usage.png", route: "/skills/\(skillId)/versions", objectId: skillId, objectState: "versions-diff-usage", target: viewport1440, locale: "zh", theme: "dark", interactionPreconditions: ["The Skill has Product API version and usage queries"], structuralAssertions: ["Version history, comparison, diff, and Loop usage are visible"], requiredSelectors: ["[data-testid='loopops.skill.versions']", "[data-testid='loopops.skill-versions.usage-impact']"])
    attemptCapture(screenId: "skill-publish-update-impact", category: "skills", filename: "skill-publish-update-impact.png", route: "/skills/\(skillId)/versions", objectId: skillId, objectState: "publish-update-impact", target: viewport390, locale: "en", theme: "light", interactionPreconditions: ["The Skill has a published version and update/usage information"], structuralAssertions: ["Immutable version history and affected Loops are visible on mobile"], requiredSelectors: ["[data-testid='loopops.skill-versions.usage-impact']"])
} else {
    for item in ["skill-detail", "skill-versions-diff-usage", "skill-publish-update-impact"] {
        recordFailure(screenId: item, category: "skills", referencePath: nil, route: "/skills", objectId: "", objectState: item, target: viewport1280, locale: "en", theme: "light", interactionPreconditions: ["A real Skill must exist"], structuralAssertions: ["The Skill lifecycle state is visible"], error: CaptureError.unavailable("No Skill exists"))
    }
}

if let draftSkillId = try? requireId(context.skillDraftId, "draft Skill") {
    attemptCapture(screenId: "skill-edit-files-permissions", category: "skills", filename: "skill-edit-files-permissions.png", route: "/skills/\(draftSkillId)/files", objectId: draftSkillId, objectState: "editing-files-permissions", target: viewport1280, locale: "en", theme: "dark", interactionPreconditions: ["A real Skill draft/package is loaded"], structuralAssertions: ["Package files and permission acknowledgement are visible", "Save remains explicit"], requiredSelectors: ["[data-testid='loopops.skill.files']"])
    attemptCapture(screenId: "skill-validation-test", category: "skills", filename: "skill-validation-test.png", route: "/skills/\(draftSkillId)/tests", objectId: draftSkillId, objectState: "test-and-validation", target: viewport1440, locale: "en", theme: "light", interactionPreconditions: ["A real Skill draft is loaded"], structuralAssertions: ["Test, permission review, validation, and publish actions are distinct"], requiredSelectors: ["[data-testid='loopops.skill.tests.form']", "[data-testid='loopops.skill.tests.validate']"])
} else {
    for item in ["skill-edit-files-permissions", "skill-validation-test"] {
        recordFailure(screenId: item, category: "skills", referencePath: nil, route: "/skills", objectId: "", objectState: item, target: viewport1280, locale: "en", theme: "light", interactionPreconditions: ["A real draft Skill must exist"], structuralAssertions: ["The editable Skill lifecycle state is visible"], error: CaptureError.unavailable("No draft Skill exists"))
    }
}

attemptCapture(
    screenId: "skill-create",
    category: "skills",
    filename: "skill-create.png",
    route: "/skills",
    objectId: "new-skill",
    objectState: "create-draft",
    target: viewport1280,
    locale: "en",
    theme: "light",
    interactionPreconditions: ["Global Create is available in a writable workspace"],
    structuralAssertions: ["Create Skill metadata and empty package state are visible"],
    requiredSelectors: ["[data-testid='loopops.create-skill.name']", "[data-testid='loopops.create-skill.submit']"],
    prepare: {
        try clickTestID("loopops.global-create")
        try clickTestID("loopops.global-create.skill")
    }
)

attemptCapture(
    screenId: "skill-upload-import",
    category: "skills",
    filename: "skill-upload-import.png",
    route: "/skills",
    objectId: "new-skill-package",
    objectState: "upload-import",
    target: viewport390,
    locale: "zh",
    theme: "dark",
    interactionPreconditions: ["Global Create opened the real Skill upload flow"],
    structuralAssertions: ["File upload and repository import choices are available in the responsive dialog"],
    requiredSelectors: ["[data-testid='loopops.create-skill.files']"],
    prepare: {
        try clickTestID("loopops.global-create")
        try clickTestID("loopops.global-create.upload-skill")
    }
)

// Team Library evidence.
attemptCapture(screenId: "team-library-search", category: "team-library", filename: "team-library-search.png", route: "/library", objectId: "workspace", objectState: "search-and-filter", target: viewport1440, locale: "en", theme: "light", interactionPreconditions: ["Fresh Team releases and installations are loaded"], structuralAssertions: ["Search, type filters, ownership/version, and install/update actions are visible"], requiredSelectors: ["[data-testid='loopops.library.surface']", "[data-testid='loopops.library.filter.all']"])

if let teamSkillId = try? requireId(context.teamSkillId, "Team Skill") {
    attemptCapture(screenId: "team-library-skill-detail", category: "team-library", filename: "team-library-skill-detail.png", route: "/library/skills/\(teamSkillId)", objectId: teamSkillId, objectState: "detail", target: viewport1280, locale: "zh", theme: "light", interactionPreconditions: ["A published Team Skill release exists"], structuralAssertions: ["Owner, version, compatibility, permissions, needs, creates, and install/update are visible"], requiredSelectors: ["[data-testid='loopops.library.skill-detail']"])
} else {
    recordFailure(screenId: "team-library-skill-detail", category: "team-library", referencePath: nil, route: "/library", objectId: "", objectState: "detail", target: viewport1280, locale: "zh", theme: "light", interactionPreconditions: ["A published Team Skill release must exist"], structuralAssertions: ["Team Skill detail is visible"], error: CaptureError.unavailable("No Team Skill release exists"))
}

if let teamLoopId = try? requireId(context.teamLoopId, "Team Loop") {
    attemptCapture(screenId: "team-library-loop-detail", category: "team-library", filename: "team-library-loop-detail.png", route: "/library/loops/\(teamLoopId)", objectId: teamLoopId, objectState: "detail", target: viewport1280, locale: "en", theme: "dark", interactionPreconditions: ["A published Team Loop release exists"], structuralAssertions: ["Starting point, Fork, install, owner, version, and compatibility are visible"], requiredSelectors: ["[data-testid='loopops.library.loop-detail']"])
} else {
    recordFailure(screenId: "team-library-loop-detail", category: "team-library", referencePath: nil, route: "/library", objectId: "", objectState: "detail", target: viewport1280, locale: "en", theme: "dark", interactionPreconditions: ["A published Team Loop release must exist"], structuralAssertions: ["Team Loop detail is visible"], error: CaptureError.unavailable("No Team Loop release exists"))
}

if let state = preparedStates["team-library-publish-review"] {
    attemptCapture(
        screenId: "team-library-publish-review",
        category: "team-library",
        filename: "team-library-publish-review.png",
        route: state.route,
        objectId: state.objectId,
        objectState: state.objectState,
        target: state.viewport ?? viewport1280,
        locale: state.locale ?? "en",
        theme: state.theme ?? "light",
        interactionPreconditions: state.interactionPreconditions ?? ["A real Team Library publication approval object is loaded"],
        structuralAssertions: state.structuralAssertions ?? ["Ownership, immutable version, permissions, compatibility, and approval decision are visible"],
        requiredSelectors: [state.selector]
    )
} else if !context.readyLoopId.isEmpty {
    attemptCapture(
        screenId: "team-library-publish-review",
        category: "team-library",
        filename: "team-library-publish-review.png",
        route: "/loops/\(context.readyLoopId)/publish",
        objectId: context.readyLoopId,
        objectState: "publish-review",
        target: viewport1280,
        locale: "zh",
        theme: "dark",
        interactionPreconditions: ["A real saved Loop is being reviewed before it enters the Team library"],
        structuralAssertions: ["Version, owner intent, immutable release, permissions, dependencies, consent, and publish blockers are visible"],
        requiredSelectors: ["[data-testid='loopops.publish.surface']"]
    )
} else {
    recordFailure(screenId: "team-library-publish-review", category: "team-library", referencePath: nil, route: "/library", objectId: "", objectState: "publish-review", target: viewport1280, locale: "en", theme: "light", interactionPreconditions: ["A real saved Loop must exist"], structuralAssertions: ["The Team publication review is visible"], error: CaptureError.unavailable("No publishable Loop exists"))
}

if !context.updateReleaseId.isEmpty {
    attemptCapture(
        screenId: "team-library-update-impact",
        category: "team-library",
        filename: "team-library-update-impact.png",
        route: "/library",
        objectId: context.updateReleaseId,
        objectState: "update-available",
        target: viewport390,
        locale: "zh",
        theme: "dark",
        interactionPreconditions: ["An installed Team asset has a newer immutable release"],
        structuralAssertions: ["Current/new versions, impact, keep-current, and update actions are visible"],
        requiredSelectors: ["[data-testid='loopops.library.update-review.\(context.updateReleaseId)']"],
        prepare: { try clickTestID("loopops.library.review-update.\(context.updateReleaseId)") }
    )
} else {
    recordFailure(screenId: "team-library-update-impact", category: "team-library", referencePath: nil, route: "/library", objectId: "", objectState: "update-available", target: viewport390, locale: "zh", theme: "dark", interactionPreconditions: ["An installed Team asset must have a newer release"], structuralAssertions: ["Version transition and update impact are visible"], error: CaptureError.unavailable("No adoptable Team release exists"))
}

// Global Create and Inbox are real overlays on the Loops route.
attemptCapture(screenId: "global-create", category: "global-create", filename: "global-create.png", route: "/loops", objectId: "workspace", objectState: "open", target: viewport390, locale: "en", theme: "light", interactionPreconditions: ["The Product API workspace is loaded"], structuralAssertions: ["Create Skill, Upload Skill, Create Loop, and Upload Loop are visible"], requiredSelectors: ["[data-testid='loopops.global-create.skill']", "[data-testid='loopops.global-create.upload-loop']"], prepare: { try clickTestID("loopops.global-create") })
attemptCapture(screenId: "inbox-needs-attention", category: "inbox", filename: "inbox-needs-attention.png", route: "/loops", objectId: "workspace", objectState: "open", target: viewport390, locale: "zh", theme: "dark", interactionPreconditions: ["Product API readiness and update issues are loaded"], structuralAssertions: ["Needs-attention count and product-safe recovery destinations are visible"], requiredSelectors: ["[data-testid='loopops.inbox'][aria-expanded='true']"], prepare: { try clickTestID("loopops.inbox") })

attemptCapture(
    screenId: "state-offline",
    category: "generic-state",
    filename: "generic-state-offline.png",
    route: "/loops",
    objectId: "workspace",
    objectState: "offline",
    target: viewport390,
    locale: "en",
    theme: "light",
    interactionPreconditions: ["Fresh Product API data is loaded before the isolated browser emits an offline event"],
    structuralAssertions: ["Cached content remains visible", "The offline reason and retry action are visible"],
    requiredSelectors: ["[data-testid='loopops.workspace.offline']", "[data-testid='loopops.workspace.offline'] button"],
    prepare: {
        try evaluate("window.dispatchEvent(new Event('offline')); true")
        try waitForVisibleSelector("[data-testid='loopops.workspace.offline']")
    }
)

attemptCapture(
    screenId: "state-recovery",
    category: "generic-state",
    filename: "generic-state-recovery.png",
    route: "/loops",
    objectId: "workspace",
    objectState: "recovery",
    target: viewport390,
    locale: "zh",
    theme: "light",
    interactionPreconditions: ["The isolated browser transitions from offline to online with cached Product API data"],
    structuralAssertions: ["Connection recovery is announced without obscuring the primary action", "Dismiss remains available"],
    requiredSelectors: ["[data-testid='loopops.workspace.recovered']", "[data-testid='loopops.workspace.recovered'] button"],
    prepare: {
        try evaluate("window.dispatchEvent(new Event('offline')); true")
        try waitForVisibleSelector("[data-testid='loopops.workspace.offline']")
        try evaluate("window.dispatchEvent(new Event('online')); true")
        try waitForVisibleSelector("[data-testid='loopops.workspace.recovered']")
    }
)

// Generic states that can be reproduced from the current normal workspace without data stubbing.
attemptPreparedState("state-populated", fallback: PreparedState(route: "/loops", objectId: "workspace", objectState: "populated", selector: "[data-testid='loopops.loops.board']", viewport: viewport390, locale: "zh", theme: "dark", interactionPreconditions: ["Fresh Product API Loop data is loaded"], structuralAssertions: ["A populated lifecycle list is visible on mobile"]))

attemptCapture(
    screenId: "state-empty-search",
    category: "generic-state",
    filename: "generic-state-empty-search.png",
    route: "/library",
    objectId: "workspace",
    objectState: "empty-search",
    target: viewport1280,
    locale: "en",
    theme: "light",
    interactionPreconditions: ["Team Library is populated before applying an impossible search query"],
    structuralAssertions: ["No-results message, query context, and clear-search recovery are visible"],
    requiredSelectors: [".emptyState"],
    prepare: {
        try setFormValue(".librarySearch input", "__no_visual_evidence_match__")
        try waitForVisibleSelector(".emptyState")
    }
)

if !context.skillDraftId.isEmpty {
    attemptCapture(
        screenId: "state-validation-error",
        category: "generic-state",
        filename: "generic-state-validation-error.png",
        route: "/skills/\(context.skillDraftId)/tests",
        objectId: context.skillDraftId,
        objectState: "validation-error",
        target: viewport1280,
        locale: "zh",
        theme: "light",
        interactionPreconditions: ["A Skill draft has not yet passed its required test and permission review"],
        structuralAssertions: ["Validation blocking reason and the required next action are visible"],
        requiredSelectors: ["[data-testid='loopops.skill.tests.validation-reason']"]
    )
} else {
    attemptPreparedState("state-validation-error")
}

if !context.draftLoopId.isEmpty {
    attemptCapture(screenId: "state-blocked", category: "generic-state", filename: "generic-state-blocked.png", route: "/loops/\(context.draftLoopId)/run", objectId: context.draftLoopId, objectState: "blocked", target: viewport1280, locale: "en", theme: "dark", interactionPreconditions: ["The Product API compiler reports a real blocked Workflow"], structuralAssertions: ["Blocking reasons and a recovery action are visible"], requiredSelectors: ["[data-testid='loopops.runs.preflight']"])
    attemptCapture(screenId: "state-needs-setup", category: "generic-state", filename: "generic-state-needs-setup.png", route: "/loops/\(context.draftLoopId)/run", objectId: context.draftLoopId, objectState: "needs-setup", target: viewport390, locale: "zh", theme: "light", interactionPreconditions: ["A real draft Loop has unresolved server compile or required-information checks"], structuralAssertions: ["The missing setup is explained", "Open Builder or fill required information is available"], requiredSelectors: ["[data-testid='loopops.preflight.blocked']", "[data-testid='loopops.preflight.blocked'] button"])
} else {
    attemptPreparedState("state-blocked")
    attemptPreparedState("state-needs-setup")
}

if !context.updateReleaseId.isEmpty {
    attemptCapture(screenId: "state-update-available", category: "generic-state", filename: "generic-state-update-available.png", route: "/library", objectId: context.updateReleaseId, objectState: "update-available", target: viewport1280, locale: "en", theme: "light", interactionPreconditions: ["An installed Team asset has a real newer release"], structuralAssertions: ["Update availability, impact, and explicit adoption action are visible"], requiredSelectors: ["[data-testid='loopops.library.update-review.\(context.updateReleaseId)']"], prepare: { try clickTestID("loopops.library.review-update.\(context.updateReleaseId)") })
} else {
    attemptPreparedState("state-update-available")
}

if !context.runId.isEmpty {
    attemptCapture(screenId: "state-success", category: "generic-state", filename: "generic-state-success.png", route: "/loops/\(context.readyLoopId)/runs/\(context.runId)", objectId: context.runId, objectState: "success", target: viewport390, locale: "en", theme: "dark", interactionPreconditions: ["A real Run completed and its final read model is persisted"], structuralAssertions: ["Success result and next actions are visible on mobile"], requiredSelectors: ["[data-testid='loopops.runs.final-answer']"])
} else {
    attemptPreparedState("state-success")
}

if !(shots + failures).contains(where: { ($0["screenId"] as? String) == "state-reconnecting" }) {
    attemptPreparedState("state-reconnecting")
}

do {
    let evidenceWorkspace = "visual-evidence-empty-workspace"
    let ownerId = "visual-evidence-owner"
    let viewerId = "visual-evidence-viewer"
    let owner = try bootstrapIdentity(ownerId, evidenceWorkspace)
    try installWebSession(from: owner)
    captureInitialLoadingState()

    attemptCapture(
        screenId: "state-first-use",
        category: "generic-state",
        filename: "generic-state-first-use.png",
        route: "/loops",
        objectId: evidenceWorkspace,
        objectState: "first-use",
        target: viewport1440,
        locale: "en",
        theme: "light",
        interactionPreconditions: ["A new Product API workspace and owner session are created through the test identity boundary"],
        structuralAssertions: ["The empty lifecycle lanes explain what to do next", "Create Loop remains the primary recovery action"],
        requiredSelectors: ["[data-testid='loopops.loops.board']", ".lifecycleEmptyState"]
    )
    attemptCapture(
        screenId: "state-empty",
        category: "generic-state",
        filename: "generic-state-empty.png",
        route: "/skills",
        objectId: evidenceWorkspace,
        objectState: "empty",
        target: viewport390,
        locale: "zh",
        theme: "dark",
        interactionPreconditions: ["The same new Product API workspace contains no managed Skills"],
        structuralAssertions: ["The empty state explains the missing content", "Create Skill remains reachable on mobile"],
        requiredSelectors: ["[data-testid='loopops.skills.surface']", ".emptyState"]
    )

    try inviteViewer(owner: owner, viewerId: viewerId)
    let viewer = try bootstrapIdentity(viewerId, evidenceWorkspace)
    try installWebSession(from: viewer)
    attemptCapture(
        screenId: "state-permission-denied",
        category: "generic-state",
        filename: "generic-state-permission-denied.png",
        route: "/loops",
        objectId: evidenceWorkspace,
        objectState: "permission-denied",
        target: viewport1280,
        locale: "zh",
        theme: "light",
        interactionPreconditions: ["A real viewer membership opens the workspace through an HttpOnly Product API session"],
        structuralAssertions: ["View-only access is explained", "A specific access-request recovery action is visible", "Write actions are disabled"],
        requiredSelectors: ["[data-testid='loopops.workspace.read-only']", "[data-testid='loopops.workspace.request-access']"]
    )
} catch {
    for state in ["state-first-use", "state-empty", "state-permission-denied"] where !(shots + failures).contains(where: { ($0["screenId"] as? String) == state }) {
        recordFailure(screenId: state, category: "generic-state", referencePath: nil, route: "/loops", objectId: "visual-evidence-empty-workspace", objectState: String(state.dropFirst("state-".count)), target: viewport390, locale: "en", theme: "light", interactionPreconditions: ["A real isolated Product API workspace/session must be available"], structuralAssertions: ["The state reason and a concrete recovery action are visible"], error: error)
    }
}

captureRevisionConflictState()
attemptPreparedState(
    "state-server-error",
    fallback: PreparedState(
        route: "/loops/visual-evidence-missing-workflow/edit",
        objectId: "visual-evidence-missing-workflow",
        objectState: "server-error",
        selector: "[data-testid='loopops.builder.query-state']",
        viewport: viewport1280,
        locale: "zh",
        theme: "light",
        interactionPreconditions: ["The Product API returns a real not-found response for an unknown Loop"],
        structuralAssertions: ["The error is translated into product language", "Retry and return-to-Loops recovery actions are visible"]
    )
)

let capturedAt = formatter.string(from: Date())
let attemptedIds = (shots + failures).compactMap { $0["screenId"] as? String }
let attemptedIdSet = Set(attemptedIds)
let missingScreenIds = requiredScreenIds.subtracting(attemptedIdSet).sorted()
let unexpectedScreenIds = attemptedIdSet.subtracting(requiredScreenIds).sorted()
let duplicateScreenIds = Dictionary(grouping: attemptedIds, by: { $0 })
    .filter { $0.value.count > 1 }
    .keys
    .sorted()
let captureComplete = failures.isEmpty
    && shots.count == requiredScreenIds.count
    && missingScreenIds.isEmpty
    && unexpectedScreenIds.isEmpty
    && duplicateScreenIds.isEmpty
let manifest: [String: Any] = [
    "schemaVersion": 2,
    "captureStatus": captureComplete ? "complete" : "failed",
    "capturedAt": capturedAt,
    "targetUrl": targetURL.absoluteString,
    "viewportMatrix": requiredViewportMatrix.map(\.json),
    "shots": shots,
    "failedScreenIds": failures.compactMap { $0["screenId"] as? String },
    "missingScreenIds": missingScreenIds,
    "unexpectedScreenIds": unexpectedScreenIds,
    "duplicateScreenIds": duplicateScreenIds,
]
let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
try manifestData.write(to: outputURL.appendingPathComponent("screenshot-manifest.json"))

let failureReport: [String: Any] = [
    "capturedAt": capturedAt,
    "captureStatus": captureComplete ? "complete" : "failed",
    "failures": failures,
]
let failureData = try JSONSerialization.data(withJSONObject: failureReport, options: [.prettyPrinted, .sortedKeys])
try failureData.write(to: outputURL.appendingPathComponent("capture-failures.json"))

if captureComplete {
    print("web_audit_capture=pass")
    print("web_audit_capture_count=\(shots.count)")
    print("web_audit_manual_verdict=pending")
    print("web_audit_capture_dir=\(outputURL.path)")
} else {
    FileHandle.standardError.write("web_audit_capture=fail\n".data(using: .utf8)!)
    FileHandle.standardError.write("web_audit_capture_count=\(shots.count)\n".data(using: .utf8)!)
    FileHandle.standardError.write("web_audit_failure_count=\(failures.count)\n".data(using: .utf8)!)
    if !missingScreenIds.isEmpty {
        FileHandle.standardError.write("web_audit_missing_screen_ids=\(missingScreenIds.joined(separator: ","))\n".data(using: .utf8)!)
    }
    if !unexpectedScreenIds.isEmpty {
        FileHandle.standardError.write("web_audit_unexpected_screen_ids=\(unexpectedScreenIds.joined(separator: ","))\n".data(using: .utf8)!)
    }
    if !duplicateScreenIds.isEmpty {
        FileHandle.standardError.write("web_audit_duplicate_screen_ids=\(duplicateScreenIds.joined(separator: ","))\n".data(using: .utf8)!)
    }
    for failure in failures {
        let id = failure["screenId"] as? String ?? "unknown"
        let message = failure["error"] as? String ?? "unknown"
        FileHandle.standardError.write("web_audit_failure=\(id):\(message)\n".data(using: .utf8)!)
    }
    exit(1)
}
