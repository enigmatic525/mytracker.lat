# Publishing and tracker data

- Keep changes local until the user explicitly asks to publish or push.
- Preserve existing tracker records whenever publishing or changing the UI.
- The web app stores user data in browser localStorage under `calorieTrackerStateV2`. Keep that key and preserve all existing record types and settings across updates.
- Do not clear browser storage, seed demo data over saved records, or reset history as part of a release. Data migrations must retain existing records; back up the original state before any destructive migration.
- Preserve the existing public origin for `mytracker.lat` when publishing an update; do not switch between www/non-www, schemes, or ports without a data migration. Browser storage is specific to the origin and browser profile: localhost, preview domains, and the public domain do not share records automatically.
- If publication requires moving the origin or transferring local records, prepare a verified backup and a migration path before making that change.
