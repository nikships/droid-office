import XCTest

@MainActor final class PairingTests: XCTestCase {
    func testWelcomeAcceptsPasteAndExplainsInvalidJoinLink() {
        let app = XCUIApplication()
        app.launch()
        func element(_ tag: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: tag).firstMatch }
        let paste = element("welcome.paste")
        XCTAssertTrue(paste.waitForExistence(timeout: 10))
        paste.tap()
        let field = element("paste.input")
        field.tap()
        field.typeText("not an office link")
        element("paste.submit").tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "That doesn't look like an office link")).firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(element("pair.open").exists)
    }

    // Run this on an already-paired disposable simulator to exercise the actual stored connection.
    func testPairedOfficeTabs() throws {
        guard ProcessInfo.processInfo.environment["OFFICE_TEST_PAIRED"] == "1" else { throw XCTSkip("Requires a paired simulator.") }
        let app = XCUIApplication()
        app.launch()
        for (tab, content) in [("office", "home"), ("workers", "workers"), ("board", "board"), ("me", "me")] {
            let control = app.descendants(matching: .any).matching(identifier: "tab.\(tab)").firstMatch
            XCTAssertTrue(control.waitForExistence(timeout: 10)); control.tap()
            XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "screen.\(content)").firstMatch.waitForExistence(timeout: 5))
        }
    }
}
