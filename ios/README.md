# MyTracker for iOS

This directory is the native SwiftUI conversion foundation for MyTracker. It is not a web view: calories, AI entry, weights, progress photos, settings, and persistence are implemented with native Apple frameworks.

## What is included

- SwiftUI app targeting iOS 17 and later
- Swift 6 model and business-logic package shared by the app and tests
- JSON persistence in Application Support
- Production AI client using the existing server-side endpoint (the OpenAI key never enters the app)
- Calories dashboard, seven-day balance chart, natural-language and manual entry
- Weight entry, chart, and recent history
- PhotosPicker progress gallery with resizing and local backup support
- Theme, units, dated maintenance, and goal settings
- Web-compatible JSON backup import and native backup export
- Xcode unit-test target and a command-line core verification executable

## Generate and open the project

1. Install the current full Xcode release from Apple. Command Line Tools alone cannot build an iOS app.
2. Install XcodeGen if needed: `brew install xcodegen`.
3. From this directory, run `xcodegen generate`.
4. Open `MyTracker.xcodeproj`.
5. In the MyTracker target, choose your Apple Developer team and replace `lat.mytracker.app` if that bundle identifier is unavailable.
6. Select an iPhone simulator or connected iPhone and run.

The checked-in `project.yml` is the source of truth for project settings. Regenerate the project after changing it.

## Validate the cross-platform core

From `ios/MyTrackerCore`:

```sh
swift run MyTrackerCoreChecks
```

Full app and XCTest validation require Xcode because SwiftUI, Charts, PhotosUI, UIKit, the iOS SDK, and XCTest are not included in standalone Command Line Tools.

## Move existing web data into the app

1. Open Settings on `mytracker.lat`.
2. Choose **Export backup for iPhone** and save the JSON file.
3. In the iOS app, open Settings and choose **Import web or app backup**.

The native model intentionally retains the web keys (`t`, `a`, `dataUrl`, and date-keyed dictionaries), so backups can cross the conversion boundary without a server account.

## Before App Store submission

- Install full Xcode and run the MyTracker scheme tests.
- Set the signing team and final bundle identifier.
- Review the generated 1024px app icon at every rendered size; the current icon is upscaled from the existing 500px web icon.
- Add App Store screenshots, privacy disclosures, support URL, category, age rating, and app description in App Store Connect.
- Decide whether local-only storage is sufficient or whether account-based sync and deletion are required.
- Add production monitoring and rate limiting to the AI endpoint before a public launch.
- Test backup import with a real Safari export containing the user's current photos.

No OpenAI secret belongs in the Xcode project, Info.plist, source, or app binary.
