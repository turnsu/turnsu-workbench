import AppKit
import Foundation
import WebKit

enum DomSmokeError: Error, CustomStringConvertible {
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
            throw DomSmokeError.timeout("Timed out while waiting for \(label)")
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

let targetURLString = ProcessInfo.processInfo.environment["LOOPOPS_WEB_URL"] ?? "http://127.0.0.1:8798/"
guard let targetURL = URL(string: targetURLString),
      ["http", "https"].contains(targetURL.scheme?.lowercased() ?? "") else {
    throw DomSmokeError.assertion("dom:smoke requires the same-origin Product server URL")
}
let portableLoopFixture = try String(
    contentsOfFile: "scripts/fixtures/portable-loop-minimal.loop.json",
    encoding: .utf8
)

let desktopViewport = NSRect(x: 0, y: 0, width: 1280, height: 820)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let webView = WKWebView(frame: desktopViewport, configuration: configuration)
let window = NSWindow(
    contentRect: NSRect(x: -2400, y: -2400, width: desktopViewport.width, height: desktopViewport.height),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.contentView = webView
window.orderFrontRegardless()

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
        throw DomSmokeError.javascript(message ?? evalError.localizedDescription)
    }
    return result
}

func assertCheck(_ condition: Bool, _ message: String) throws {
    if !condition {
        throw DomSmokeError.assertion(message)
    }
}

func bodyText() throws -> String {
    try evaluate("document.body.innerText") as? String ?? ""
}

func h1() throws -> String {
    try evaluate("document.querySelector('h1')?.textContent?.trim() || ''") as? String ?? ""
}

func exists(_ selector: String) throws -> Bool {
    try evaluate("Boolean(document.querySelector(\(jsString(selector))))") as? Bool ?? false
}

func count(_ selector: String) throws -> Int {
    let value = try evaluate("document.querySelectorAll(\(jsString(selector))).length")
    return (value as? NSNumber)?.intValue ?? 0
}

func click(_ selector: String) throws {
    try evaluate("""
    (() => {
      const element = document.querySelector(\(jsString(selector)));
      if (!element) throw new Error('Missing selector: ' + \(jsString(selector)));
      element.click();
      return true;
    })()
    """)
    settle()
}

func setFormValue(_ selector: String, _ value: String) throws {
    try evaluate("""
    (() => {
      const element = document.querySelector(\(jsString(selector)));
      if (!element) throw new Error('Missing field: ' + \(jsString(selector)));
      const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
      if (setter) setter.call(element, \(jsString(value)));
      else element.value = \(jsString(value));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.value;
    })()
    """)
    settle(0.1)
}

func dragAndDrop(_ sourceSelector: String, _ targetSelector: String) throws {
    try evaluate("""
    (() => {
      const source = document.querySelector(\(jsString(sourceSelector)));
      const target = document.querySelector(\(jsString(targetSelector)));
      if (!source || !target) throw new Error('Missing drag-and-drop target');
      const rect = target.getBoundingClientRect();
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: rect.left + Math.min(420, rect.width / 2),
          clientY: rect.top + Math.min(220, rect.height / 2)
        }));
      }
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      return true;
    })()
    """)
    settle(0.35)
}

func waitForText(_ expected: String, timeout: TimeInterval = 12) throws {
    try spinUntil("text \(expected)", timeout: timeout) {
        (try? bodyText().contains(expected)) == true
    }
}

func waitForH1(_ expected: String, timeout: TimeInterval = 12) throws {
    try spinUntil("h1 \(expected)", timeout: timeout) {
        (try? h1()) == expected
    }
}

func waitForExists(_ selector: String, timeout: TimeInterval = 15) throws {
    try spinUntil("selector \(selector)", timeout: timeout) {
        (try? exists(selector)) == true
    }
}

func waitForCount(_ selector: String, _ expected: Int, timeout: TimeInterval = 12) throws {
    try spinUntil("count \(selector) = \(expected)", timeout: timeout) {
        (try? count(selector)) == expected
    }
}

try waitForExists("[data-testid=\"loopops.loops.board\"]", timeout: 20)
try waitForH1("Loop lifecycle")
try assertCheck(try count("[data-testid=\"loopops.workspace.save\"]") == 0, "The Product UI must not expose legacy workspace save")
try assertCheck(try exists("[data-testid=\"loopops.global-nav\"]"), "The selected global navigation is missing")
try assertCheck(!(try exists("[data-testid=\"loopops.shell.sidebar\"]")), "The retired left sidebar still owns the production shell")
try click("[data-testid=\"loopops.global-create\"]")
for control in ["skill", "upload-skill", "loop", "upload-loop"] {
    try assertCheck(try exists("[data-testid=\"loopops.global-create.\(control)\"]"), "Global Create is missing \(control)")
}
try click("[data-testid=\"loopops.global-create.skill\"]")
try waitForExists("[data-testid=\"loopops.create-skill.blank-package\"]")
try click("[data-testid=\"loopops.create-skill.cancel\"]")
try click("[data-testid=\"loopops.global-create\"]")
try click("[data-testid=\"loopops.global-create.upload-skill\"]")
try waitForExists("[data-testid=\"loopops.create-skill.files\"]")
try click("[data-testid=\"loopops.create-skill.cancel\"]")
try click("[data-testid=\"loopops.global-create\"]")
try click("[data-testid=\"loopops.global-create.upload-loop\"]")
try waitForExists("[data-testid=\"loopops.loop-import.dialog\"]")
try click(".dialogPanel > .buttonRow button")
try click("[data-testid=\"loopops.global-create\"]")
try click("[data-testid=\"loopops.global-create.loop\"]")
try spinUntil("global Create Loop route", timeout: 20) { (try? evaluate("location.pathname === '/loops/new'")) as? Bool == true }
try click("[data-testid=\"loopops.nav.loops\"]")
try waitForExists("[data-testid=\"loopops.loops.board\"]")
try click("[data-testid=\"loopops.inbox\"]")
try assertCheck(try exists("[data-testid=\"loopops.inbox\"][aria-expanded=\"true\"]"), "Needs attention did not open")
try click("[data-testid=\"loopops.inbox\"]")
try click("[data-testid=\"loopops.account-menu\"]")
try assertCheck(try exists("[data-testid=\"loopops.account.theme.dark\"]"), "Workspace menu is missing theme controls")
try assertCheck(try exists("[data-testid=\"loopops.account.locale.zh\"]"), "Workspace menu is missing locale controls")
try click("[data-testid=\"loopops.account-menu\"]")

try setFormValue("[data-testid=\"loopops.loops.ai-command\"]", "Prepare a weekly product review with decisions, owners, and a final approval step")
try evaluate("document.querySelector('[data-testid=\"loopops.loops.ai-command\"]')?.form?.requestSubmit(); true")
try spinUntil("AI-native Loop creation route", timeout: 20) {
    (try? evaluate("location.pathname === '/loops/new'")) as? Bool == true
}
try spinUntil("AI-native Loop goal prefill") {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.create-loop.goal\"]')?.value?.includes('weekly product review')")) as? Bool == true
}
try click("[data-testid=\"loopops.create-loop.submit\"]")
try waitForExists("[data-testid=\"loopops.create-loop.proposal-review\"]", timeout: 60)
try assertCheck((try evaluate("location.pathname === '/loops/new'")) as? Bool == true, "AI proposal opened an editable draft before confirmation")
try click("[data-testid=\"loopops.create-loop.proposal-apply\"]")
try spinUntil("confirmed proposal Builder route", timeout: 30) {
    (try? evaluate("/^\\/loops\\/[^/]+\\/edit$/.test(location.pathname)")) as? Bool == true
}
try click("[data-testid=\"loopops.nav.loops\"]")
try waitForExists("[data-testid=\"loopops.loops.board\"]")

try click("[data-testid=\"loopops.loops.upload\"]")
try waitForExists("[data-testid=\"loopops.loop-import.dialog\"]")
try assertCheck(try exists("[data-testid=\"loopops.loop-import.file\"]"), "Loop upload must begin with an explicit file choice")
try assertCheck(try exists("[data-testid=\"loopops.loop-import.check\"]:disabled"), "Loop file review must stay disabled until a file is chosen")
try assertCheck(!(try bodyText().contains("provider")) && !(try bodyText().contains("artifact")), "Loop upload leaked internal runtime language")
try click(".dialogPanel > .buttonRow button")
try assertCheck(!(try exists("[data-testid=\"loopops.loop-import.dialog\"]")), "Loop upload dialog did not close")
try spinUntil("Loop upload focus restoration") {
    (try? evaluate("document.activeElement?.dataset?.testid === 'loopops.loops.upload'")) as? Bool == true
}

try click("[data-testid=\"loopops.loops.upload\"]")
try waitForExists("[data-testid=\"loopops.loop-import.file\"]")
try evaluate("""
(() => {
  const input = document.querySelector('[data-testid="loopops.loop-import.file"]');
  if (!input) throw new Error('Missing portable Loop file input');
  const transfer = new DataTransfer();
  transfer.items.add(new File([
    \(jsString(portableLoopFixture))
  ], 'imported-focus.loop.json', { type: 'application/vnd.looloomi.loop-package+json' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.files[0]?.size || 0;
})()
""")
try spinUntil("enabled Loop file review") {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.loop-import.check\"]')?.disabled === false")) as? Bool == true
}
try click("[data-testid=\"loopops.loop-import.check\"]")
try waitForText("Imported focus loop", timeout: 30)
try spinUntil("ready portable Loop draft") {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.loop-import.commit\"]')?.disabled === false")) as? Bool == true
}
try click("[data-testid=\"loopops.loop-import.commit\"]")
try spinUntil("portable Loop Builder route", timeout: 30) {
    (try? evaluate("/^\\/loops\\/[^/]+\\/edit$/.test(location.pathname)")) as? Bool == true
}
let importedLoopId = try evaluate("location.pathname.match(/^\\/loops\\/([^/]+)\\/edit$/)?.[1] || ''") as? String ?? ""
try assertCheck(!importedLoopId.isEmpty, "Portable Loop import did not return an addressable Workflow")
try evaluate("""
window.history.pushState({}, '', '/loops/' + \(jsString(importedLoopId)));
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.loops.overview\"]", timeout: 20)
try waitForText("Imported focus loop")
try evaluate("""
window.__loopDownload = null;
const originalAnchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  window.__loopDownload = { filename: this.download, href: this.href };
  HTMLAnchorElement.prototype.click = originalAnchorClick;
};
true;
""")
try click("[data-testid=\"loopops.loop-overview.export\"]")
try spinUntil("portable Loop download", timeout: 20) {
    (try? evaluate("Boolean(window.__loopDownload)")) as? Bool == true
}
let portableDownloadName = try evaluate("window.__loopDownload?.filename || ''") as? String ?? ""
try assertCheck(portableDownloadName.hasSuffix(".loop.json"), "Portable Loop export did not provide a safe package filename")
try click("[data-testid=\"loopops.nav.loops\"]")
try waitForExists("[data-testid=\"loopops.loops.board\"]")

try click("[data-testid=\"loopops.theme.dark\"]")
try assertCheck((try evaluate("document.documentElement.dataset.theme") as? String) == "dark", "Dark theme did not apply")
try click("[data-testid=\"loopops.theme.light\"]")
try assertCheck((try evaluate("document.documentElement.dataset.theme") as? String) == "light", "Light theme did not apply")
try click("[data-testid=\"loopops.locale.zh\"]")
try waitForH1("工作流生命周期")
try click("[data-testid=\"loopops.loops.upload\"]")
try waitForText("上传工作流")
try assertCheck(!(try bodyText().contains("schema")) && !(try bodyText().contains("artifact")), "Chinese Loop upload leaked internal runtime language")
try click(".dialogPanel > .buttonRow button")
try click("[data-testid=\"loopops.locale.en\"]")
try waitForH1("Loop lifecycle")

try click("[data-testid=\"loopops.nav.skills\"]")
try waitForH1("Skills")
try click("[data-testid=\"loopops.skills.create\"]")
try waitForExists("[data-testid=\"loopops.create-skill.name\"]")
try assertCheck(try exists("[data-testid=\"loopops.create-skill.mode-files\"]"), "Skill creation must expose device file import")
try assertCheck(try exists("[data-testid=\"loopops.create-skill.mode-github\"]"), "Skill creation must expose public GitHub import")
try click("[data-testid=\"loopops.create-skill.mode-github\"]")
try assertCheck(try exists("[data-testid=\"loopops.create-skill.repository-fields\"]"), "GitHub import fields did not open")
try assertCheck(!(try exists("[data-testid=\"loopops.create-skill.files\"]")), "Device file input must stay hidden in GitHub mode")
try click("[data-testid=\"loopops.create-skill.mode-files\"]")
try assertCheck(try exists("[data-testid=\"loopops.create-skill.files\"]"), "Skill creation must require package files")
try assertCheck(try exists("[data-testid=\"loopops.create-skill.submit\"]"), "Skill creation must expose an explicit package check")
try assertCheck(!(try exists("[data-testid=\"loopops.create-skill.create-draft\"]")), "A Skill draft must not be created before package checks pass")
try assertCheck(!(try bodyText().contains("Publish Skill")), "Skill creation must not hide publication inside the upload step")
try setFormValue("[data-testid=\"loopops.create-skill.name\"]", "Executable review smoke")
try setFormValue("[data-testid=\"loopops.create-skill.description\"]", "Checks the executable package confirmation boundary.")
try setFormValue("[data-testid=\"loopops.create-skill.category\"]", "Testing")
try evaluate("""
(() => {
  const input = document.querySelector('[data-testid="loopops.create-skill.files"]');
  if (!input) throw new Error('Missing Skill package file input');
  const skill = `---
name: executable-review-smoke
description: Check the executable upload review boundary.
compatibility: Local only
disable-model-invocation: true
---

# Executable review smoke
`;
  const transfer = new DataTransfer();
  const skillFile = new File([skill], 'SKILL.md', { type: 'text/markdown' });
  const executableFile = new File([
    'import json, sys\\npayload = json.load(sys.stdin)\\nprint(json.dumps({"result": "follow-up action ready", "received": payload}))\\n'
  ], 'main.py', { type: 'text/x-python' });
  Object.defineProperty(executableFile, 'webkitRelativePath', { value: 'scripts/main.py' });
  const runtimeManifest = new File([JSON.stringify({
    runtime: 'python3.12',
    entrypoint: 'scripts/main.py',
    protocol: { stdin: 'json', stdout: 'json' },
    permissions: {
      network: false,
      connections: [],
      externalActions: false,
      filesystem: 'scratch-only'
    }
  }) + '\\n'], 'skill.runtime.json', { type: 'application/json' });
  transfer.items.add(skillFile);
  transfer.items.add(executableFile);
  transfer.items.add(runtimeManifest);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.files.length;
})()
""")
try click("[data-testid=\"loopops.create-skill.submit\"]")
try spinUntil("Skill package review outcome", timeout: 20) {
    (try? exists("[data-testid=\"loopops.create-skill.executable-confirmation\"]")) == true
        || (try? exists("[data-testid=\"loopops.create-skill.upload-status\"].error")) == true
}
if !(try exists("[data-testid=\"loopops.create-skill.executable-confirmation\"]")) {
    let status = try evaluate("document.querySelector('[data-testid=\"loopops.create-skill.upload-status\"]')?.innerText?.trim() || 'missing upload status'") as? String ?? "missing upload status"
    throw DomSmokeError.assertion("Executable Skill package review failed before confirmation: \(status)")
}
try assertCheck(try exists("[data-testid=\"loopops.create-skill.executable-acknowledgement\"]"), "Executable package review must expose an explicit acknowledgement")
try assertCheck((try evaluate("document.querySelector('[data-testid=\"loopops.create-skill.create-draft\"]')?.disabled") as? Bool) == true, "Executable package promotion must stay disabled before acknowledgement")
try assertCheck(try bodyText().contains("isolated environment"), "Executable package review must explain isolated execution")
try assertCheck(try bodyText().contains("network access off by default"), "Executable package review must explain the default no-network boundary")
try click("[data-testid=\"loopops.create-skill.executable-acknowledgement\"]")
try assertCheck((try evaluate("document.querySelector('[data-testid=\"loopops.create-skill.create-draft\"]')?.disabled") as? Bool) == false, "Acknowledgement must enable executable package promotion")
try click("[data-testid=\"loopops.create-skill.create-draft\"]")
try assertCheck(!(try exists("[data-testid=\"loopops.create-skill.name\"]")), "Skill creation dialog did not close")
do {
    try waitForExists("[data-testid=\"loopops.skill.overview\"]", timeout: 30)
} catch {
    throw DomSmokeError.assertion("Skill draft did not open after package confirmation. Visible UI: \(try bodyText())")
}
try assertCheck(try bodyText().contains("Draft"), "Creating an inspected package must open an editable Skill draft")
try assertCheck(!(try bodyText().contains("BuilderPatch")), "Internal proposal model leaked into Skills")

try assertCheck((try evaluate("location.pathname.startsWith('/skills/')") as? Bool) == true, "Skill overview must use an addressable object route")
let ownedSkillId = try evaluate("location.pathname.split('/')[2] || ''") as? String ?? ""
try assertCheck(!ownedSkillId.isEmpty, "The uploaded Skill must have an addressable identity")
try evaluate("document.querySelectorAll('.objectRouteTabs button')[1]?.click()")
try waitForExists("[data-testid=\"loopops.skill.instructions\"]")
try waitForExists("[data-testid=\"loopops.skill.package.instructions.editor\"]", timeout: 20)
try assertCheck((try evaluate("location.pathname.endsWith('/instructions')") as? Bool) == true, "Skill instructions must use an addressable route")
try assertCheck(!(try bodyText().contains("executionRef")), "Skill instructions leaked an internal execution field")
try assertCheck(!(try bodyText().contains("contentHash")), "Skill instructions leaked an internal object field")
let existingInstructions = try evaluate("document.querySelector('[data-testid=\"loopops.skill.package.instructions.editor\"]')?.value || ''") as? String ?? ""
try setFormValue(
    "[data-testid=\"loopops.skill.package.instructions.editor\"]",
    existingInstructions + "\n\nKeep the final result concise."
)
try spinUntil("dirty Skill instructions", timeout: 12) {
    (try? bodyText().contains("Unsaved changes")) == true
}
try click("[data-testid=\"loopops.skill.package.acknowledge\"]")
try spinUntil("enabled Skill package save", timeout: 12) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.package.save\"]')?.disabled === false") as? Bool) == true
}
try click("[data-testid=\"loopops.skill.package.save\"]")
try waitForText("Skill instructions and files were saved as a new draft revision.", timeout: 30)
try evaluate("document.querySelectorAll('.objectRouteTabs button')[2]?.click()")
try waitForExists("[data-testid=\"loopops.skill.files\"]")
try waitForExists("[data-testid=\"loopops.skill.package.files.editor\"]", timeout: 20)
try assertCheck((try count(".skillPackageFileRail button") == 3), "Skill Files must preserve instructions, executable code, and environment settings")
try evaluate("document.querySelectorAll('.objectRouteTabs button')[3]?.click()")
try waitForExists("[data-testid=\"loopops.skill.editor\"]")
try evaluate("document.querySelectorAll('.objectRouteTabs button')[4]?.click()")
try waitForExists("[data-testid=\"loopops.skill.tests\"]")
try waitForExists("[data-testid=\"loopops.skill.tests.form\"]")
try setFormValue("[data-testid=\"loopops.skill.tests.name\"]", "Executable Skill v1")
try setFormValue("[data-testid=\"loopops.skill.tests.purpose\"]", "Prove the uploaded Skill executes before its first release.")
try setFormValue("[data-testid=\"loopops.skill.tests.input\"]", "{}")
try setFormValue("[data-testid=\"loopops.skill.tests.expected\"]", "")
try click("[data-testid=\"loopops.skill.tests.run\"]")
try spinUntil("passing uploaded Skill test", timeout: 60) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.result\"]')?.dataset?.status === 'passed'")) as? Bool == true
}
try click("[data-testid=\"loopops.skill.tests.permission-acknowledgement\"]")
try spinUntil("enabled uploaded Skill validation") {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.validate\"]')?.disabled === false")) as? Bool == true
}
try click("[data-testid=\"loopops.skill.tests.validate\"]")
try spinUntil("passing uploaded Skill validation", timeout: 30) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.validation-result\"]')?.dataset?.status === 'passed'")) as? Bool == true
}
try setFormValue("[data-testid=\"loopops.skill.tests.publish-version\"]", "1.0.0")
try setFormValue("[data-testid=\"loopops.skill.tests.release-notes\"]", "First isolated execution release.")
try spinUntil("enabled uploaded Skill publication") {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.publish\"]')?.disabled === false")) as? Bool == true
}
try click("[data-testid=\"loopops.skill.tests.publish\"]")
try waitForExists("[data-testid=\"loopops.skill.versions\"]", timeout: 30)
try waitForCount("[data-testid^=\"loopops.skill-version.\"]", 1, timeout: 30)
try assertCheck(!(try exists("[data-testid=\"loopops.skill-versions.current-draft\"]")), "A published Skill must not remain visibly editable")
try evaluate("document.querySelectorAll('.objectRouteTabs button')[5]?.click()")
try waitForExists("[data-testid=\"loopops.skill.versions\"]")
try waitForText("Version history")
try assertCheck(!(try bodyText().contains("Workflow usage could not be loaded.")), "Draft Skill usage impact must not fail")
try assertCheck(!(try bodyText().contains("executionRef")), "Draft Skill version history leaked an internal execution field")

// Create an independent Loop that pins the user-owned Skill, so update impact is real and isolated.
try evaluate("""
window.history.pushState({}, '', '/loops/new');
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.create-loop.page\"]", timeout: 20)
try click("[data-testid=\"loopops.create-loop.mode.blank\"]")
let ownedSkillLoopTitle = "Owned Skill update proof"
try setFormValue("[data-testid=\"loopops.create-loop.name\"]", ownedSkillLoopTitle)
try click("[data-testid=\"loopops.create-loop.submit\"]")
try waitForExists("[data-testid=\"loopops.templates.contract-page\"]", timeout: 20)
try click("[data-testid=\"loopops.builder.tab.canvas\"]")
try waitForExists("[data-testid=\"loopops.builder.canvas\"]")
try click("[data-testid=\"loopops.builder.palette.skill.\(ownedSkillId).add\"]")
try spinUntil("enabled owned Skill Loop save", timeout: 12) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.topbar.primary.save-workflow\"]')?.disabled === false")) as? Bool == true
}
try click("[data-testid=\"loopops.topbar.primary.save-workflow\"]")
try spinUntil("saved owned Skill Loop", timeout: 20) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.topbar.primary.save-workflow\"]')?.disabled === true")) as? Bool == true
}

try evaluate("""
window.history.pushState({}, '', '/skills');
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.skills.surface\"]")
try evaluate("""
window.history.pushState({}, '', '/skills/not-a-real-skill');
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForText("This Skill is unavailable")
try assertCheck(!(try bodyText().contains("Meeting action extractor")), "An invalid Skill route must not fall back to the first Skill")
try evaluate("""
window.history.pushState({}, '', '/skills/meeting-action-extractor');
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.skill.overview\"]", timeout: 20)
try evaluate("document.querySelectorAll('.objectRouteTabs button')[5]?.click()")
try waitForExists("[data-testid=\"loopops.skill.versions\"]")
try waitForExists("[data-testid^=\"loopops.skill-version.\"]")
try assertCheck(!(try exists("[data-testid=\"loopops.skill-versions.create-update\"]")), "System catalog Skills must not expose owner-only update actions")
try assertCheck(!(try bodyText().contains("Workflow usage could not be loaded.")), "Skill usage impact must not fail on migrated workflows")
try assertCheck(!(try bodyText().contains("executionRef")), "Skill version history leaked an internal execution field")
try click("[data-testid=\"loopops.nav.loops\"]")
try waitForExists("[data-testid=\"loopops.loops.board\"]")
try evaluate("""
window.history.pushState({}, '', '/loops/not-a-real-loop');
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.loop-overview.query-state\"]", timeout: 20)
try waitForText("Loop not found", timeout: 20)
try click("[data-testid=\"loopops.loop-overview.query-state\"] button")
try waitForExists("[data-testid=\"loopops.loops.board\"]")

try click("[data-testid=\"loopops.loops.use-template\"]")
try waitForExists("[data-testid=\"loopops.create-loop.page\"]", timeout: 20)
try waitForExists("[data-testid=\"loopops.create-loop.starting-points\"]", timeout: 20)
try waitForExists("[data-testid^=\"loopops.create-loop.starting-point.template.\"]", timeout: 20)
try assertCheck(try count("[data-testid=\"loopops.create-loop.starting-points\"] [data-testid^=\"loopops.create-loop.starting-point.\"]") > 0, "Starting points must expose an explicit create action")
try click("[data-testid^=\"loopops.create-loop.starting-point.template.\"]")
try waitForExists("[data-testid=\"loopops.builder.clone-mode\"]", timeout: 20)
try waitForExists("[data-testid=\"loopops.topbar.primary.save-workflow\"]")
try assertCheck(try count("[data-testid=\"loopops.topbar.primary.save-workflow\"]") == 1, "Builder must expose one workflow save action")
try assertCheck(try count("[data-testid=\"loopops.templates.builder-patch-receipt\"]") == 0, "Builder must not stage changes before an assistant request")

try click("[data-testid=\"loopops.builder.tab.definition\"]")
try waitForExists("[data-testid=\"loopops.builder.definition\"]")
try setFormValue("[data-testid=\"loopops.builder.definition\"] textarea", "Create a reviewed meeting follow-up")
try spinUntil("enabled definition save", timeout: 12) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.topbar.primary.save-workflow\"]')?.disabled === false") as? Bool) == true
}
try click("[data-testid=\"loopops.topbar.primary.save-workflow\"]")
do {
    try waitForText("This workflow was saved as a new revision.", timeout: 20)
} catch {
    let saveState = try evaluate("(() => { const state = document.querySelector('[data-testid=\"loopops.workspace.save-status\"]')?.textContent?.trim() || ''; const toasts = Array.from(document.querySelectorAll('.toast')).map((toast) => toast.textContent?.trim()).filter(Boolean); return JSON.stringify({ state, toasts }); })()") as? String ?? "{}"
    throw DomSmokeError.assertion("Definition revision save did not succeed: \(saveState)")
}
try click("[data-testid=\"loopops.builder.tab.outline\"]")
try waitForExists("[data-testid=\"loopops.builder.outline\"]")
try click("[data-testid=\"loopops.builder.tab.canvas\"]")
try waitForExists("[data-testid=\"loopops.builder.canvas\"]")

let nodeSelector = "[data-testid^=\"loopops.builder.node.\"][data-node-id]"
let initialNodeCount = try count(nodeSelector)
try click("[data-testid^=\"loopops.builder.palette.skill.\"][data-testid$=\".add\"]")
try waitForCount(nodeSelector, initialNodeCount + 1)
try assertCheck(try exists(".canvasNode.selected[data-selected=\"true\"]"), "Add must select the new Skill node")
try spinUntil("enabled first workflow save", timeout: 12) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.topbar.primary.save-workflow\"]')?.disabled === false") as? Bool) == true
}
try click("[data-testid=\"loopops.topbar.primary.save-workflow\"]")
do {
    try waitForText("This workflow was saved as a new revision.", timeout: 20)
} catch {
    let saveState = try evaluate("(() => { const state = document.querySelector('[data-testid=\"loopops.workspace.save-status\"]')?.textContent?.trim() || ''; const toasts = Array.from(document.querySelectorAll('.toast')).map((toast) => toast.textContent?.trim()).filter(Boolean); return JSON.stringify({ state, toasts }); })()") as? String ?? "{}"
    throw DomSmokeError.assertion("Workflow revision save did not succeed: \(saveState)")
}
try spinUntil("saved workflow state", timeout: 20) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.topbar.primary.save-workflow\"]')?.disabled === true") as? Bool) == true
}
try click(".canvasNode.selected [data-testid$=\".delete\"]")
try waitForCount(nodeSelector, initialNodeCount)

try dragAndDrop(
    "[data-testid^=\"loopops.builder.palette.skill.\"]:not([data-testid$=\".add\"])",
    "[data-testid=\"loopops.builder.canvas-dropzone\"]"
)
try waitForCount(nodeSelector, initialNodeCount + 1)
try assertCheck(try exists(".canvasNode.selected[data-selected=\"true\"]"), "Drop must select the new Skill node")
try click(".canvasNode.selected [data-testid$=\".delete\"]")
try waitForCount(nodeSelector, initialNodeCount)
try spinUntil("enabled second workflow save", timeout: 12) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.topbar.primary.save-workflow\"]')?.disabled === false") as? Bool) == true
}

try click("[data-testid=\"loopops.builder.assistant.toggle\"]")
try waitForText("Describe the change you want")
try assertCheck(try count("[data-testid=\"loopops.builder.chat\"] textarea") == 1, "Builder must expose one server-backed proposal request")
try assertCheck(try exists("[data-testid=\"loopops.builder.assistant.send\"]:disabled"), "Unsaved workflow changes must block proposal generation")
try assertCheck(try count("[data-testid=\"loopops.templates.builder-patch-receipt\"]") == 0, "Opening the assistant must not stage local changes")

try click("[data-testid=\"loopops.topbar.primary.save-workflow\"]")
try spinUntil("second saved workflow state", timeout: 20) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.topbar.primary.save-workflow\"]')?.disabled === true") as? Bool) == true
}
try click("[data-testid=\"loopops.builder.duplicate\"]")
try waitForText("ready to edit", timeout: 20)
try waitForExists("[data-testid=\"loopops.builder.clone-mode\"]")
try waitForExists("[data-testid=\"loopops.builder.run-inputs\"] input")
let proofText = "fresh WKWebView first-slice proof"
try setFormValue("[data-testid=\"loopops.builder.run-inputs\"] input", proofText)
try click("[data-testid=\"loopops.builder.mock-run\"]")
try waitForH1("Run details", timeout: 30)
do {
    try waitForExists("[data-testid=\"loopops.runs.review-panel\"]", timeout: 30)
} catch {
    let runState = try evaluate("(() => { const toasts = Array.from(document.querySelectorAll('.toast')).map((toast) => toast.textContent?.trim()).filter(Boolean); return JSON.stringify({ toasts, body: document.body.innerText.slice(-4000) }); })()") as? String ?? "{}"
    throw DomSmokeError.assertion("Run did not reach a review decision: \(runState)")
}
try evaluate("window.dispatchEvent(new Event('offline')); true")
try waitForExists("[data-testid=\"loopops.runs.reconnect-state\"]")
try waitForExists("[data-testid=\"loopops.workspace.offline\"]")
try assertCheck(try exists("[data-testid=\"loopops.runs.reconnect\"]"), "Interrupted live updates need a visible reconnect action")
try click("[data-testid=\"loopops.runs.reconnect\"]")
try evaluate("window.dispatchEvent(new Event('online')); true")
try spinUntil("run updates reconnect", timeout: 12) {
    (try? exists("[data-testid=\"loopops.runs.reconnect-state\"]")) == false
}
try spinUntil("workspace online state", timeout: 12) {
    (try? exists("[data-testid=\"loopops.workspace.offline\"]")) == false
}
try assertCheck(try exists("[data-testid=\"loopops.runs.review.comment\"]"), "Review decisions must expose a reviewer note")
try click("[data-testid=\"loopops.runs.review.approve\"]")
try waitForExists("[data-testid=\"loopops.runs.final-answer\"]", timeout: 30)
let completedLoopId = try evaluate("window.location.pathname.split('/')[2] || ''") as? String ?? ""
try assertCheck(!completedLoopId.isEmpty, "Completed Run must retain its source Loop identity in the URL")
let completedLoopTitle = try evaluate("document.querySelector('.runDetailsHeader .objectKicker')?.textContent?.trim() || ''") as? String ?? ""
try assertCheck(!completedLoopTitle.isEmpty, "Completed Run must identify its source Loop")
let finalText = try evaluate("document.querySelector('[data-testid=\"loopops.runs.final-answer\"] p')?.textContent || ''") as? String ?? ""
try assertCheck(!finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Final answer must come from the authoritative read model")
try assertCheck(try exists("[data-testid=\"loopops.workflows.run-ledger\"]"), "Completed run must remain visible in workflow history")
try assertCheck(try exists("[data-testid=\"loopops.runs.retry\"]"), "Completed run must expose an explicit rerun action")
let completedRunPath = try evaluate("window.location.pathname") as? String ?? ""

// Phase 07: exercise the user-owned uploaded Skill through its real update lifecycle.
try evaluate("""
window.history.pushState({}, '', '/skills/\(ownedSkillId)/versions');
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.skill.versions\"]", timeout: 20)
try waitForExists("[data-testid=\"loopops.skill-versions.timeline\"]", timeout: 20)
try waitForExists("[data-testid=\"loopops.skill-versions.create-update\"]", timeout: 20)
let initialBusinessVersionCount = try count("[data-testid^=\"loopops.skill-version.\"]")
try assertCheck(initialBusinessVersionCount == 1, "The business Skill must begin with one immutable published version")
let initialBusinessVersion = try evaluate("document.querySelector('[data-testid^=\"loopops.skill-version.\"]')?.dataset?.version || ''") as? String ?? ""
try assertCheck(!initialBusinessVersion.isEmpty, "The existing business Skill version needs a public version label")
try assertCheck((try evaluate("document.documentElement.dataset.theme") as? String) == "light", "Skill update lifecycle must begin in light theme")

try click("[data-testid=\"loopops.skill-versions.create-update\"]")
try waitForExists("[data-testid=\"loopops.skill-update.dialog\"]")
try spinUntil("Skill update dialog focus") {
    (try? evaluate("document.activeElement?.dataset?.testid === 'loopops.skill-update.name'")) as? Bool == true
}
try assertCheck(try bodyText().contains("Start from version \(initialBusinessVersion)"), "English update review must identify the immutable source version")
try assertCheck(try bodyText().contains("workflows keep their current version"), "English update review must explain pinned Workflow behavior")
try click("[data-testid=\"loopops.skill-update.cancel\"]")
try spinUntil("closed Skill update dialog") {
    (try? exists("[data-testid=\"loopops.skill-update.dialog\"]")) == false
}
try spinUntil("Skill update focus restoration") {
    (try? evaluate("document.activeElement?.dataset?.testid === 'loopops.skill-versions.create-update'")) as? Bool == true
}
try assertCheck(try count("[data-testid^=\"loopops.skill-version.\"]") == initialBusinessVersionCount, "Cancelling a Skill update must not create a version")
try assertCheck(!(try exists("[data-testid=\"loopops.skill-versions.current-draft\"]")), "Cancelling a Skill update must not create a draft")

try click("[data-testid=\"loopops.locale.zh\"]")
try click("[data-testid=\"loopops.theme.dark\"]")
try assertCheck((try evaluate("document.documentElement.dataset.theme") as? String) == "dark", "Dark theme did not remain visible on Skill versions")
try click("[data-testid=\"loopops.skill-versions.create-update\"]")
try waitForText("创建技能新版本")
try assertCheck(try bodyText().contains("工作流会继续使用当前版本"), "Chinese update review must explain pinned Workflow behavior")
try click("[data-testid=\"loopops.skill-update.cancel\"]")
try spinUntil("Chinese Skill update focus restoration") {
    (try? evaluate("document.activeElement?.dataset?.testid === 'loopops.skill-versions.create-update'")) as? Bool == true
}
try assertCheck(try count("[data-testid^=\"loopops.skill-version.\"]") == initialBusinessVersionCount, "Chinese cancel must remain a no-op")
try click("[data-testid=\"loopops.locale.en\"]")
try click("[data-testid=\"loopops.theme.light\"]")

try click("[data-testid=\"loopops.skill-versions.create-update\"]")
try waitForExists("[data-testid=\"loopops.skill-update.description\"]")
let businessDescription = try evaluate("document.querySelector('[data-testid=\"loopops.skill-update.description\"]')?.value || ''") as? String ?? ""
try setFormValue(
    "[data-testid=\"loopops.skill-update.description\"]",
    businessDescription + " Includes an explicit owner-ready update summary."
)
try click("[data-testid=\"loopops.skill-update.submit\"]")
do {
    try waitForExists("[data-testid=\"loopops.skill.editor\"]", timeout: 30)
} catch {
    let state = try evaluate("(() => { const toasts = Array.from(document.querySelectorAll('.toast')).map((toast) => toast.textContent?.trim()).filter(Boolean); return JSON.stringify({ path: location.pathname, toasts, dialogOpen: Boolean(document.querySelector('[data-testid=\"loopops.skill-update.dialog\"]')) }); })()") as? String ?? "{}"
    throw DomSmokeError.assertion("Business Skill update draft was not created through the Product API: \(state)")
}
try assertCheck((try evaluate("location.pathname.endsWith('/edit')") as? Bool) == true, "Creating a Skill update must open its editable draft")
try click("[data-testid=\"loopops.skill.tab.tests\"]")
try waitForExists("[data-testid=\"loopops.skill.tests.form\"]", timeout: 20)
try assertCheck((try evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.validate\"]')?.disabled") as? Bool) == true, "Validation must stay blocked before a real Skill test")
try waitForExists("[data-testid=\"loopops.skill.tests.validation-reason\"]")
try setFormValue("[data-testid=\"loopops.skill.tests.name\"]", "Meeting action update v2")
try setFormValue("[data-testid=\"loopops.skill.tests.purpose\"]", "Prove the updated business Skill executes through the real Skill test path.")
try setFormValue("[data-testid=\"loopops.skill.tests.input\"]", "{\n  \"transcript\": \"Ari will send the launch brief by Friday. Mina should review the follow-up.\"\n}")
try setFormValue("[data-testid=\"loopops.skill.tests.expected\"]", "")
try click("[data-testid=\"loopops.skill.tests.run\"]")
try spinUntil("passing business Skill test", timeout: 60) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.result\"]')?.dataset?.status === 'passed'")) as? Bool == true
}
try assertCheck(try bodyText().contains("follow-up action"), "The real business Skill test must expose its product-safe output preview")
try assertCheck((try evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.validate\"]')?.disabled") as? Bool) == true, "Validation must stay blocked until permissions are acknowledged")
try assertCheck(try bodyText().contains("Review and confirm the permission summary"), "The permission gate needs a visible recovery reason")
try click("[data-testid=\"loopops.skill.tests.permission-acknowledgement\"]")
try spinUntil("enabled Skill validation") {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.validate\"]')?.disabled === false")) as? Bool == true
}
try click("[data-testid=\"loopops.skill.tests.validate\"]")
try spinUntil("passing Skill validation", timeout: 30) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.validation-result\"]')?.dataset?.status === 'passed'")) as? Bool == true
}
try setFormValue("[data-testid=\"loopops.skill.tests.publish-version\"]", "2.0.0")
try setFormValue("[data-testid=\"loopops.skill.tests.release-notes\"]", "Clarifies owner-ready action summaries.")
try spinUntil("enabled Skill v2 publication") {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.skill.tests.publish\"]')?.disabled === false")) as? Bool == true
}
try click("[data-testid=\"loopops.skill.tests.publish\"]")
try waitForExists("[data-testid=\"loopops.skill.versions\"]", timeout: 30)
try waitForCount("[data-testid^=\"loopops.skill-version.\"]", initialBusinessVersionCount + 1, timeout: 30)
try assertCheck(try exists("[data-testid^=\"loopops.skill-version.\"][data-version=\"2.0.0\"]"), "Publication must add immutable Skill v2")
try assertCheck(try exists("[data-testid^=\"loopops.skill-version.\"][data-version=\"\(initialBusinessVersion)\"]"), "Publication must preserve immutable Skill v1")
try assertCheck(!(try exists("[data-testid=\"loopops.skill-versions.current-draft\"]")), "Published v2 must no longer appear as a mutable draft")
try waitForExists("[data-testid=\"loopops.skill-versions.diff\"]", timeout: 30)
try assertCheck(try exists("[data-testid^=\"loopops.skill-versions.diff.\"][data-changed=\"true\"]"), "Skill version comparison must expose the changed v2 fields")
try waitForExists("[data-testid=\"loopops.skill-versions.usage-impact\"]", timeout: 20)
try waitForExists("[data-testid=\"loopops.skill-versions.usage\"]", timeout: 20)
try assertCheck(try bodyText().contains(ownedSkillLoopTitle), "Skill usage impact must include the real saved Loop that pins this Skill")
try assertCheck(try bodyText().contains("Keeps its current Skill version until explicitly updated."), "Usage impact must state that the existing Loop remains pinned")

// Review the pinned Loop update through its dedicated, addressable lifecycle route.
let skillVersionsPath = try evaluate("window.location.pathname") as? String ?? ""
try click("[data-testid^=\"loopops.skill-versions.review-update.\"]")
try waitForExists("[data-testid=\"loopops.loop-update.review\"]", timeout: 20)
let loopUpdatePath = try evaluate("window.location.pathname") as? String ?? ""
try assertCheck(loopUpdatePath.contains("/updates/"), "Loop Skill update review must use an addressable immutable-version route")
try assertCheck(try bodyText().contains(initialBusinessVersion), "Loop update review must identify the pinned Skill version")
try assertCheck(try bodyText().contains("2.0.0"), "Loop update review must identify the proposed Skill version")
try assertCheck(try bodyText().contains("Existing versions, runs, and team installations stay unchanged."), "Loop update review must explain immutable history")
try assertCheck(try exists("[data-testid=\"loopops.loop-update.create-draft\"]"), "Loop update review must expose one explicit mutation")

try click("[data-testid=\"loopops.locale.zh\"]")
try click("[data-testid=\"loopops.theme.dark\"]")
try assertCheck((try evaluate("document.documentElement.dataset.theme") as? String) == "dark", "Loop update review must support dark theme")
let chineseLoopUpdateText = try bodyText()
try assertCheck(chineseLoopUpdateText.contains("历史内容保持不变") && chineseLoopUpdateText.contains("发布前需要重新试运行"), "Loop update review must explain history and retesting in Chinese")
try assertCheck((try evaluate("document.body.scrollWidth <= window.innerWidth + 1") as? Bool) == true, "Dark Chinese Loop update review has horizontal overflow")
try click("[data-testid=\"loopops.locale.en\"]")
try click("[data-testid=\"loopops.theme.light\"]")

try click("[data-testid=\"loopops.loop-update.cancel\"]")
try waitForExists("[data-testid=\"loopops.loops.overview\"]", timeout: 20)
try evaluate("""
window.history.pushState({}, '', \(jsString(skillVersionsPath)));
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.skill-versions.usage\"]", timeout: 20)
try click("[data-testid^=\"loopops.skill-versions.review-update.\"]")
try waitForExists("[data-testid=\"loopops.loop-update.review\"]", timeout: 20)
try assertCheck((try evaluate("window.location.pathname") as? String) == loopUpdatePath, "The same immutable Skill version must restore the same update review URL")
try click("[data-testid=\"loopops.loop-update.create-draft\"]")
try waitForExists("[data-testid=\"loopops.templates.surface\"]", timeout: 30)
try waitForExists("[data-testid=\"loopops.templates.contract-page\"]", timeout: 20)
try assertCheck(try bodyText().contains(ownedSkillLoopTitle), "Applying a Skill update must open the affected Loop draft")

// The update creates a new Workflow revision; the authoritative completed Run stays readable.
try evaluate("""
window.history.pushState({}, '', \(jsString(completedRunPath)));
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.runs.final-answer\"]", timeout: 20)
let preservedFinalText = try evaluate("document.querySelector('[data-testid=\"loopops.runs.final-answer\"] p')?.textContent || ''") as? String ?? ""
try assertCheck(preservedFinalText == finalText, "Updating a Loop Skill must not rewrite an existing Run result")

try evaluate("""
window.history.pushState({}, '', \(jsString(skillVersionsPath)));
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.skill.versions\"]", timeout: 20)

try click("[data-testid=\"loopops.locale.zh\"]")
try click("[data-testid=\"loopops.theme.dark\"]")
try assertCheck((try evaluate("document.documentElement.dataset.theme") as? String) == "dark", "Published Skill semantics must remain visible in dark theme")
let chineseSkillLifecycleText = try bodyText()
try assertCheck(chineseSkillLifecycleText.contains("版本记录") && chineseSkillLifecycleText.contains("会继续使用当前技能版本，直到明确更新。"), "Published v2 history and usage semantics must remain visible in Chinese")
try assertCheck((try evaluate("document.body.scrollWidth <= window.innerWidth + 1") as? Bool) == true, "Dark Chinese Skill lifecycle has horizontal overflow")
try click("[data-testid=\"loopops.locale.en\"]")
try click("[data-testid=\"loopops.theme.light\"]")

try evaluate("""
window.history.pushState({}, '', \(jsString(completedRunPath)));
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.runs.final-answer\"]", timeout: 20)
try click("[data-testid=\"loopops.runs.retry\"]")
try spinUntil("completed run starts again", timeout: 20) {
    let path = (try? evaluate("window.location.pathname")) as? String ?? ""
    return !path.isEmpty && path != completedRunPath && path.contains("/runs/")
}
try waitForExists("[data-testid=\"loopops.workflows.run-detail\"]", timeout: 20)
if try exists("[data-testid=\"loopops.runs.cancel\"]") {
    try click("[data-testid=\"loopops.runs.cancel\"]")
}
try evaluate("""
window.history.pushState({}, '', \(jsString(completedRunPath)));
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.runs.final-answer\"]", timeout: 20)
try click("[data-testid=\"loopops.runs.create-draft\"]")
try waitForExists("[data-testid=\"loopops.templates.surface\"]", timeout: 20)
try waitForExists("[data-testid=\"loopops.templates.contract-page\"]")
try click("[data-testid=\"loopops.nav.loops\"]")
try waitForH1("Loop lifecycle")
try click(".lifecycleLaneV2:nth-of-type(2) .lifecycleCardTitle")
try waitForExists("[data-testid=\"loopops.loops.overview\"]")
try assertCheck(try exists("[data-testid=\"loopops.loop-overview.definition\"]"), "Loop overview must expose the readable definition route")
try assertCheck(try exists("[data-testid=\"loopops.loop-overview.steps\"]"), "Loop overview must expose the ordered steps route")
try click("[data-testid=\"loopops.loop-overview.primary\"]")
try waitForExists("[data-testid=\"loopops.runs.preflight\"]")
try assertCheck(try exists("[data-testid=\"loopops.preflight.inputs\"]"), "Run preflight must show the information used for this run")
try assertCheck(try exists("[data-testid=\"loopops.preflight.start\"]"), "Run preflight must own the start action")
try click("[data-testid=\"loopops.preflight.review-steps\"]")
try waitForExists("[data-testid=\"loopops.builder.outline\"]")
let completedLoopEditPath = "/loops/\(completedLoopId)/edit"
_ = try evaluate("history.pushState({}, '', \(jsString(completedLoopEditPath))); window.dispatchEvent(new PopStateEvent('popstate')); true")
try spinUntil("completed Loop Builder", timeout: 20) {
    (try? evaluate("document.querySelector('.workflowTopbar h2')?.textContent?.trim() === \(jsString(completedLoopTitle))") as? Bool) == true
}
try spinUntil("enabled publish action", timeout: 20) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.builder.publish\"]')?.disabled === false") as? Bool) == true
}
let publishedLoopId = try evaluate("window.location.pathname.split('/')[2] || ''") as? String ?? ""
try assertCheck(!publishedLoopId.isEmpty, "Publish review must retain the source Loop identity in the URL")
try assertCheck(publishedLoopId == completedLoopId, "Publish review must use the Loop revision that completed the test Run")
try click("[data-testid=\"loopops.builder.publish\"]")
try waitForH1("Publish Loop")
try waitForExists("[data-testid=\"loopops.publish.submit\"]")
try setFormValue("[data-testid=\"loopops.publish.notes\"]", "Fresh browser publication proof")
try click(".publishConsent input")
do {
    try spinUntil("publish readiness", timeout: 20) {
        (try? evaluate("document.querySelector('[data-testid=\"loopops.publish.submit\"]')?.disabled === false") as? Bool) == true
    }
} catch {
    let state = try evaluate("JSON.stringify({ path: location.pathname, submitDisabled: document.querySelector('[data-testid=\"loopops.publish.submit\"]')?.disabled, checks: Array.from(document.querySelectorAll('.publishChecklist li')).map((item) => ({ text: item.textContent?.trim(), className: item.className })), body: document.querySelector('.publishReviewPage')?.innerText?.slice(0, 2400) })") as? String ?? "{}"
    throw DomSmokeError.assertion("Publish readiness did not resolve: \(state)")
}
try click("[data-testid=\"loopops.publish.submit\"]")
try waitForText("This Loop is now available to your team.", timeout: 30)
try waitForH1("Team Loop", timeout: 20)
try assertCheck(try exists("[data-testid=\"loopops.library.loop-detail\"]"), "Publishing must open the dedicated Team Loop route")
let publishedLoopTitle = try evaluate("document.querySelector('.libraryLoopTitle h2')?.textContent?.trim() || ''") as? String ?? ""
try click("[data-testid=\"loopops.library.install\"]")
if try exists("[data-testid=\"loopops.connections.rebinding\"]") {
    if try exists(".connectionBlockingState button") {
        try click(".connectionBlockingState button")
        try waitForExists("[data-testid=\"loopops.connections.save-validate\"]")
        try setFormValue(".connectionConfigurationForm input", "DOM smoke workspace connection")
        try setFormValue(".connectionConfigurationForm textarea", "Allows this isolated test workspace to use the required capability.")
        try click("[data-testid=\"loopops.connections.save-validate\"]")
        try waitForExists("[data-testid=\"loopops.connections.submit-bindings\"]", timeout: 20)
    } else {
        _ = try evaluate("""
        (() => {
          const select = document.querySelector('.connectionRequirement select');
          if (!select) return false;
          const option = Array.from(select.options).find((item) => item.value);
          if (!option) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (setter) setter.call(select, option.value); else select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
        """)
        settle(0.2)
    }
    try click("[data-testid=\"loopops.connections.submit-bindings\"]")
}
try waitForText("installed in your workspace", timeout: 20)
try click("[data-testid=\"loopops.library.fork\"]")
try waitForExists("[data-testid=\"loopops.templates.surface\"]", timeout: 20)
let forkedLoopId = try evaluate("window.location.pathname.split('/')[2] || ''") as? String ?? ""
try assertCheck(!forkedLoopId.isEmpty && forkedLoopId != publishedLoopId, "Fork must create an independent Loop identity")

let sourceEditPath = "/loops/\(publishedLoopId)/edit"
_ = try evaluate("history.pushState({}, '', \(jsString(sourceEditPath))); window.dispatchEvent(new PopStateEvent('popstate')); true")
try spinUntil("source Loop Builder", timeout: 20) {
    (try? evaluate("document.querySelector('.workflowTopbar h2')?.textContent?.trim() === \(jsString(publishedLoopTitle))") as? Bool) == true
}
try click("[data-testid=\"loopops.builder.publish\"]")
try waitForH1("Publish Loop")
try setFormValue("[data-testid=\"loopops.publish.notes\"]", "Second browser publication proof")
try click(".publishConsent input")
try spinUntil("second publish readiness", timeout: 20) {
    (try? evaluate("document.querySelector('[data-testid=\"loopops.publish.submit\"]')?.disabled === false") as? Bool) == true
}
try click("[data-testid=\"loopops.publish.submit\"]")
try waitForH1("Team Loop", timeout: 30)
try waitForExists("[data-testid=\"loopops.library.update-review\"]", timeout: 30)
try click("[data-testid=\"loopops.library.apply-update\"]")
try waitForText("now uses the selected release", timeout: 20)
try click("[data-testid=\"loopops.nav.library\"]")
try waitForH1("Team library")
try assertCheck(try exists("[data-testid=\"loopops.library.surface\"]"), "Published Loop must appear through the Team library surface")
try assertCheck(try exists("[data-testid^=\"loopops.library.open.\"]"), "Team Loop rows must open an addressable detail route")
try setFormValue(".librarySearch input", "no-match-for-lifecycle-smoke")
try waitForText("No matching shared items")
try click(".emptyState button")
try spinUntil("team library search reset") {
    ((try? evaluate("document.querySelector('.librarySearch input')?.value || ''")) as? String) == ""
}

let desktopNoOverflow = try evaluate("document.body.scrollWidth <= window.innerWidth + 1") as? Bool ?? false
try assertCheck(desktopNoOverflow, "Desktop page has horizontal overflow")

try evaluate("""
window.history.pushState({}, '', '/loops/\(forkedLoopId)/edit');
window.dispatchEvent(new PopStateEvent('popstate'));
""")
try waitForExists("[data-testid=\"loopops.templates.contract-page\"]", timeout: 20)
try click("[data-testid=\"loopops.builder.tab.canvas\"]")
try waitForExists("[data-testid=\"loopops.builder.canvas\"]")

let mobileViewport = NSRect(x: 0, y: 0, width: 390, height: 844)
window.setContentSize(mobileViewport.size)
webView.frame = mobileViewport
settle(0.4)
let mobileCanvasLayout = try evaluate("document.querySelector('[data-testid=\"loopops.templates.surface\"]')?.classList.contains('mobileCanvasMode')") as? Bool ?? false
try assertCheck(mobileCanvasLayout, "Mobile Canvas mode did not activate its dedicated layout")
let mobileCanvasVisible = try evaluate("""
(() => {
  const canvas = document.querySelector('[data-testid="loopops.builder.canvas"]');
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom > 0 && rect.height >= 320;
})()
""") as? Bool ?? false
try assertCheck(mobileCanvasVisible, "Mobile Canvas is not visible in the first viewport")
let mobileLibraryHidden = try evaluate("getComputedStyle(document.querySelector('[data-testid=\"loopops.builder.palette\"]')).display === 'none'") as? Bool ?? false
try assertCheck(mobileLibraryHidden, "Mobile Canvas must hide the resource library until requested")
try click("[data-testid=\"loopops.builder.mobile-library.open\"]")
let mobileLibraryOpen = try evaluate("""
(() => {
  const panel = document.querySelector('[data-testid="loopops.builder.palette"]');
  const rect = panel?.getBoundingClientRect();
  return Boolean(panel && getComputedStyle(panel).display !== 'none' && rect && rect.width >= 360 && rect.height >= 700);
})()
""") as? Bool ?? false
try assertCheck(mobileLibraryOpen, "Mobile resource library did not open as a full-screen drawer")
try click("[data-testid=\"loopops.builder.mobile-library.close\"]")
let mobileLibraryClosed = try evaluate("getComputedStyle(document.querySelector('[data-testid=\"loopops.builder.palette\"]')).display === 'none'") as? Bool ?? false
try assertCheck(mobileLibraryClosed, "Mobile resource library did not close back to Canvas")
let mobileNoOverflow = try evaluate("document.body.scrollWidth <= window.innerWidth + 1") as? Bool ?? false
try assertCheck(mobileNoOverflow, "Mobile page has horizontal overflow")

print("web_dom_smoke=pass")
print("web_dom_execution=product-api")
print("web_dom_template_to_workflow=true")
print("web_dom_portable_loop_import=true")
print("web_dom_portable_loop_export=true")
print("web_dom_skill_add_delete_drag=true")
print("web_dom_revision_save=true")
print("web_dom_review_gate=true")
print("web_dom_object_states=true")
print("web_dom_completed_rerun=true")
print("web_dom_final_authority=server-read-model")
print("web_dom_publish_fork_update=true")
print("web_dom_skill_update_lifecycle=product-api")
print("web_dom_skill_update_cancel_noop=true")
print("web_dom_skill_update_versions=2")
print("web_dom_skill_update_locales=en,zh")
print("web_dom_skill_update_themes=light,dark")
print("web_dom_loop_skill_update_review=product-api")
print("web_dom_loop_skill_update_history=immutable")
print("web_dom_mobile_canvas=dedicated")
print("web_dom_mobile_resource_library=drawer")
print("web_dom_mobile_no_overflow=true")
