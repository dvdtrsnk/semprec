import UniformTypeIdentifiers
import XCTest

@testable import JournalFeature

final class CaptureFileTests: XCTestCase {

    func testAFileIsReadWithItsNameTypeAndBytes() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "capture-\(UUID().uuidString).pdf")
        try Data("abc".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try CaptureFile.read(url)
        XCTAssertEqual(file.filename, url.lastPathComponent)
        XCTAssertEqual(file.mimeType, "application/pdf")
        XCTAssertEqual(file.base64, "YWJj")
    }

    func testAFileWithoutAKnownExtensionIsGenericBinary() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "capture-\(UUID().uuidString).zzqq")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertEqual(try CaptureFile.read(url).mimeType, "application/octet-stream")
    }

    func testAMissingFileIsAnError() {
        let url = FileManager.default.temporaryDirectory.appending(path: "missing-\(UUID().uuidString).pdf")
        XCTAssertThrowsError(try CaptureFile.read(url))
    }

    func testAPhotoIsNamedWithTheExtensionOfItsType() {
        let png = CaptureFile.photo(Data("abc".utf8), type: .png, named: "Photo 08:15")
        XCTAssertEqual(png, CaptureFile(filename: "Photo 08:15.png", mimeType: "image/png", base64: "YWJj"))
        let unknown = CaptureFile.photo(Data("abc".utf8), type: nil, named: "Photo")
        XCTAssertEqual(unknown, CaptureFile(filename: "Photo.jpeg", mimeType: "image/jpeg", base64: "YWJj"))
    }
}
