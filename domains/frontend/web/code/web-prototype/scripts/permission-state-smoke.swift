import AppKit
import Foundation
import WebKit

enum PermissionSmokeError: Error, CustomStringConvertible {
    case assertion(String)
    case request(String)
    case timeout(String)

    var description: String {
        switch self {
        case .assertion(let message), .request(let message), .timeout(let message): return message
        }
    }
}

struct HttpResult {
    let status: Int
    let headers: [AnyHashable: Any]
    let data: Data
}

@discardableResult
func spinUntil(_ label: String, timeout: TimeInterval = 20, _ done: () -> Bool) throws -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !done() {
        if Date() > deadline { throw PermissionSmokeError.timeout("Timed out while waiting for \(label)") }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return true
}

func request(_ url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil) throws -> HttpResult {
    var result: HttpResult?
    var failure: Error?
    var value = URLRequest(url: url)
    value.httpMethod = method
    value.httpBody = body
    value.httpShouldHandleCookies = false
    headers.forEach { value.setValue($1, forHTTPHeaderField: $0) }
    let semaphore = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: value) { data, response, error in
        defer { semaphore.signal() }
        if let error { failure = error; return }
        guard let response = response as? HTTPURLResponse else {
            failure = PermissionSmokeError.request("Missing HTTP response for \(url.path)")
            return
        }
        result = HttpResult(status: response.statusCode, headers: response.allHeaderFields, data: data ?? Data())
    }.resume()
    if semaphore.wait(timeout: .now() + 20) == .timedOut {
        throw PermissionSmokeError.timeout("Timed out requesting \(url.path)")
    }
    if let failure { throw failure }
    guard let result else { throw PermissionSmokeError.request("No response for \(url.path)") }
    return result
}

func json(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value)
}

func decoded(_ data: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw PermissionSmokeError.request("Response was not a JSON object")
    }
    return value
}

func assertCheck(_ condition: Bool, _ message: String) throws {
    if !condition { throw PermissionSmokeError.assertion(message) }
}

let originString = ProcessInfo.processInfo.environment["LOOPOPS_WEB_URL"] ?? "http://127.0.0.1:8798/"
guard let origin = URL(string: originString), let host = origin.host else {
    throw PermissionSmokeError.assertion("permission:smoke requires an HTTP Product server URL")
}
let suffix = UUID().uuidString.lowercased()
let ownerId = "permission-owner-\(suffix)"
let viewerId = "permission-viewer-\(suffix)"
let workspaceId = "permission-workspace-\(suffix)"
let originHeader = "\(origin.scheme ?? "http")://\(host)\(origin.port.map { ":\($0)" } ?? "")"

func endpoint(_ path: String) -> URL {
    URL(string: path, relativeTo: origin)!.absoluteURL
}

let ownerBootstrap = try request(endpoint("/api/workbench/v1/workspace"), headers: [
    "X-Workbench-Test-User": ownerId,
    "X-Workbench-Test-Workspace": workspaceId,
])
try assertCheck(ownerBootstrap.status == 200, "Product server must allow isolated test identities for permission proof")
let ownerCookie = String(describing: ownerBootstrap.headers["Set-Cookie"] ?? ownerBootstrap.headers["set-cookie"] ?? "").split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
let ownerBody = try decoded(ownerBootstrap.data)
let ownerData = ownerBody["data"] as? [String: Any]
let ownerSession = ownerData?["session"] as? [String: Any]
let ownerCsrf = ownerSession?["csrfToken"] as? String ?? ""
try assertCheck(!ownerCookie.isEmpty && !ownerCsrf.isEmpty, "Owner bootstrap did not return a browser session")

let invite = try request(
    endpoint("/api/workbench/v1/workspace/memberships"),
    method: "POST",
    headers: [
        "Cookie": ownerCookie,
        "Origin": originHeader,
        "Sec-Fetch-Site": "same-origin",
        "X-Workbench-CSRF": ownerCsrf,
        "Idempotency-Key": "invite-\(viewerId)",
        "Content-Type": "application/json",
    ],
    body: try json([
        "schemaVersion": "workbench-api-v1",
        "data": ["userId": viewerId, "displayName": "Permission viewer", "role": "viewer"],
    ])
)
let inviteBody = try decoded(invite.data)
try assertCheck(invite.status == 201, "Owner could not add the viewer membership (status \(invite.status), code \(inviteBody["code"] ?? "unknown"))")

let viewerBootstrap = try request(endpoint("/api/workbench/v1/workspace"), headers: [
    "X-Workbench-Test-User": viewerId,
    "X-Workbench-Test-Workspace": workspaceId,
])
try assertCheck(viewerBootstrap.status == 200, "Viewer could not open the shared workspace")
let viewerCookieHeader = String(describing: viewerBootstrap.headers["Set-Cookie"] ?? viewerBootstrap.headers["set-cookie"] ?? "").split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
let viewerBody = try decoded(viewerBootstrap.data)
let viewerData = viewerBody["data"] as? [String: Any]
let viewerSession = viewerData?["session"] as? [String: Any]
let viewerCsrf = viewerSession?["csrfToken"] as? String ?? ""
let cookieParts = viewerCookieHeader.split(separator: "=", maxSplits: 1).map(String.init)
try assertCheck(cookieParts.count == 2 && !viewerCsrf.isEmpty, "Viewer bootstrap did not return a browser session")

let deniedMutation = try request(
    endpoint("/api/workbench/v1/loops"),
    method: "POST",
    headers: [
        "Cookie": viewerCookieHeader,
        "Origin": originHeader,
        "Sec-Fetch-Site": "same-origin",
        "X-Workbench-CSRF": viewerCsrf,
        "Idempotency-Key": "viewer-create-denied-\(suffix)",
        "Content-Type": "application/json",
    ],
    body: try json([
        "schemaVersion": "workbench-api-v1",
        "data": [
            "name": "Denied viewer Loop",
            "description": "This request must not create data.",
            "definition": [
                "goal": "Prove viewer mutations are rejected.",
                "context": "Permission acceptance test.",
                "constraints": ["Do not create data."],
                "doneWhen": ["The server returns a role error."],
                "verify": ["No Loop is persisted."],
                "expectedResult": "A product-safe permission error.",
                "stopRules": ["Stop if authorization is bypassed."],
            ],
        ],
    ])
)
let deniedBody = try decoded(deniedMutation.data)
try assertCheck(deniedMutation.status == 403, "Viewer mutation must be rejected with 403, found \(deniedMutation.status)")
try assertCheck((deniedBody["code"] as? String) == "workspace_role_forbidden", "Viewer mutation returned the wrong product-safe error")

final class NavigationWaiter: NSObject, WKNavigationDelegate {
    var finished = false
    var failure: Error?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failure = error; finished = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failure = error; finished = true }
}

let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820), configuration: configuration)
let window = NSWindow(contentRect: NSRect(x: -2200, y: -2200, width: 1280, height: 820), styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.orderFrontRegardless()

var cookieProperties: [HTTPCookiePropertyKey: Any] = [
    .originURL: origin,
    .domain: host,
    .path: "/",
    .name: cookieParts[0],
    .value: cookieParts[1],
]
if origin.scheme == "https" { cookieProperties[.secure] = "TRUE" }
guard let cookie = HTTPCookie(properties: cookieProperties) else {
    throw PermissionSmokeError.assertion("Could not create viewer Web cookie")
}
var cookieInstalled = false
configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { cookieInstalled = true }
try spinUntil("viewer cookie") { cookieInstalled }
var installedCookies: [HTTPCookie] = []
var cookiesRead = false
configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in installedCookies = cookies; cookiesRead = true }
try spinUntil("viewer cookie readback") { cookiesRead }
try assertCheck(installedCookies.contains(where: { $0.name == cookieParts[0] && $0.value == cookieParts[1] }), "Viewer Web cookie did not persist in WKWebView")

let waiter = NavigationWaiter()
webView.navigationDelegate = waiter
webView.load(URLRequest(url: origin))
try spinUntil("viewer Web navigation") { waiter.finished }
if let failure = waiter.failure { throw failure }

@discardableResult
func evaluate(_ source: String) throws -> Any? {
    var result: Any?
    var failure: Error?
    var finished = false
    webView.evaluateJavaScript(source) { value, error in result = value; failure = error; finished = true }
    try spinUntil("JavaScript") { finished }
    if let failure { throw failure }
    return result
}

try spinUntil("view-only banner") {
    (try? evaluate("Boolean(document.querySelector('[data-testid=\"loopops.workspace.read-only\"]'))") as? Bool) == true
}
let snapshot = try evaluate("""
(() => {
  const request = document.querySelector('[data-testid="loopops.workspace.request-access"]');
  const createLoop = document.querySelector('[data-testid="loopops.topbar.primary.create-loop"]');
  const uploadLoop = document.querySelector('[data-testid="loopops.loops.upload"]');
  return JSON.stringify({
    title: document.querySelector('h1')?.textContent.trim() || '',
    banner: document.querySelector('[data-testid="loopops.workspace.read-only"]')?.textContent.trim() || '',
    requestVisible: Boolean(request && !request.disabled),
    createLoopDisabled: Boolean(createLoop?.disabled),
    uploadLoopDisabled: Boolean(!uploadLoop || uploadLoop.disabled || uploadLoop.getAttribute('aria-disabled') === 'true'),
  });
})()
""") as? String ?? "{}"
let snapshotData = snapshot.data(using: .utf8) ?? Data()
let snapshotValue = try decoded(snapshotData)
try assertCheck(snapshotValue["title"] as? String == "Loops", "Viewer Web did not load the Loops workspace")
try assertCheck((snapshotValue["banner"] as? String)?.contains("View-only workspace") == true, "Viewer role needs a human-readable explanation")
try assertCheck(snapshotValue["requestVisible"] as? Bool == true, "Viewer role needs a visible access request action")
try assertCheck(snapshotValue["createLoopDisabled"] as? Bool == true, "Viewer must not see an enabled Loop creation action")
try assertCheck(snapshotValue["uploadLoopDisabled"] as? Bool == true, "Viewer must not see an enabled Loop upload action")
_ = try evaluate("document.querySelector('[data-testid=\"loopops.loops.upload\"]')?.click(); true")
try assertCheck((try evaluate("Boolean(document.querySelector('[data-testid=\"loopops.loop-import.dialog\"]'))") as? Bool) == false, "Viewer must not open the Loop upload flow")

_ = try evaluate("document.querySelector('[data-testid=\"loopops.locale.zh\"]')?.click(); true")
try spinUntil("Chinese permission copy") {
    ((try? evaluate("document.querySelector('[data-testid=\"loopops.workspace.read-only\"]')?.textContent || ''") as? String) ?? "").contains("当前为只读权限")
}

print("web_permission_state_smoke=pass")
print("web_permission_state_server_denial=workspace_role_forbidden")
print("web_permission_state_viewer=\(viewerId)")
print("web_permission_state_workspace=\(workspaceId)")
