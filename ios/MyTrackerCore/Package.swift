// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "MyTrackerCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "MyTrackerCore", targets: ["MyTrackerCore"]),
        .executable(name: "MyTrackerCoreChecks", targets: ["MyTrackerCoreChecks"])
    ],
    targets: [
        .target(name: "MyTrackerCore"),
        .executableTarget(
            name: "MyTrackerCoreChecks",
            dependencies: ["MyTrackerCore"],
            path: "Checks"
        )
    ]
)
