// swift-tools-version: 6.0
//
// The Metistry Mac app — the front end for the `metistry` CLI
// (docs/product/desktop-app-plan.md, "Distribution: the app as the
// installer"). Swift Package Manager, no Xcode project: the app is
// assembled into `Metistry.app` by `ops/release/build-app.sh`, exactly the
// way the Swift TCC helpers are (packages/mcp-*/scripts/build-helper.sh).
//
// TWO targets on purpose. `MetistryKit` is the model and the views, and it
// is free of AppKit and of `Process`: an iOS target added later shares it
// unchanged (design-system P6 — one information architecture, three
// renderings). Only `Metistry`, the executable, knows it is a Mac:
// `MenuBarExtra`, Sparkle and the `Process`-backed command runner live there.
//
// Paths are lowercase (CLAUDE.md casing rule). SPM's default layout is
// `Sources/<TargetName>/`, so every target names its own lowercase path
// instead; `Package.swift` and `Package.resolved` are the two uppercase names
// SPM will not let us rename, and they are allowlisted in
// ops/scripts/check-path-case.sh.

import PackageDescription

let package = Package(
    name: "metistry-app",
    // macOS 14 is the app's floor. The iOS line is a statement of intent, not
    // a shipped target: it is what keeps MetistryKit honest about staying off
    // AppKit and off `Process`.
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "MetistryKit", targets: ["MetistryKit"]),
        .executable(name: "Metistry", targets: ["Metistry"]),
    ],
    dependencies: [
        // Pinned exactly, to the same version ops/release/runtime-versions.env
        // pins the Sparkle CLI tools to (SPARKLE_VERSION): the framework that
        // reads the appcast and the tool that signs it must agree.
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.6"),
    ],
    targets: [
        .target(name: "MetistryKit", path: "sources/kit"),
        .executableTarget(
            name: "Metistry",
            dependencies: [
                "MetistryKit",
                .product(name: "Sparkle", package: "Sparkle", condition: .when(platforms: [.macOS])),
            ],
            path: "sources/app",
            linkerSettings: [
                // Sparkle ships as an XCFramework binary target. build-app.sh
                // copies Sparkle.framework into Contents/Frameworks; this is
                // the rpath that lets the executable find it there at runtime.
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])
            ]
        ),
        // Only the kit is tested: it holds everything with a decision in it
        // (the wire shape, the runtime precedence, the planned argument
        // arrays). The executable target is `@main` plus a Process wrapper.
        //
        // `fixtures/` is the recorded client-API fixtures (F-7). The tests read
        // them by `#filePath`, as the source scan reads `sources/`, so they are
        // excluded rather than bundled.
        .testTarget(name: "MetistryKitTests", dependencies: ["MetistryKit"], path: "tests/kit", exclude: ["fixtures"]),
    ]
)
