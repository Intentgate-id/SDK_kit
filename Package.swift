// swift-tools-version:5.9
// The manifest sits at the repository root so apps can add the SDK by URL:
//   .package(url: "https://github.com/Intentgate-id/SDK_kit", from: "0.1.0")
// Sources stay under swift/.
import PackageDescription

let package = Package(
    name: "IntentgateBasicAuth",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "IntentgateBasicAuth", targets: ["IntentgateBasicAuth"]),
        .library(name: "IntentgateBasicAuthPasskeys", targets: ["IntentgateBasicAuthPasskeys"]),
    ],
    dependencies: [
        // Only used on Linux (tests / server-side tools). Apple platforms use CryptoKit.
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"5.0.0"),
    ],
    targets: [
        .target(
            name: "IntentgateBasicAuth",
            dependencies: [.product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux]))],
            path: "swift/Sources/IntentgateBasicAuth"
        ),
        .target(name: "IntentgateBasicAuthPasskeys", dependencies: ["IntentgateBasicAuth"], path: "swift/Sources/IntentgateBasicAuthPasskeys"),
        .testTarget(name: "IntentgateBasicAuthTests", dependencies: ["IntentgateBasicAuth"], path: "swift/Tests/IntentgateBasicAuthTests"),
    ]
)
