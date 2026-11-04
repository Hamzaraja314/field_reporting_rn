# Mobile local persistence

The React Native CLI app stores report metadata and queue state in a private
SQLite database, `field-reporting.sqlite`. Schema changes are applied with
versioned migrations in `src/storage/database.ts`; SQLite is the source of
truth for drafts, images, and delivery state.

## Native storage libraries

- [`@op-engineering/op-sqlite`](https://github.com/OP-Engineering/op-sqlite)

- [`react-native-blob-util`](https://github.com/RonRadtke/react-native-blob-util)
  copies image files to the app-private documents directory, handles Android
 
- `uuid` with `react-native-get-random-values` creates UUIDv4 identifiers from
  cryptographically seeded random bytes. A report's local ID and idempotency.

## Verify and run

From the monorepo root:

```sh
pnpm mobile:typecheck
pnpm --filter com.fieldreporting.mobile test -- --runInBand
pnpm mobile:android:build
pnpm mobile:start
```

In another terminal, launch the Android app on an emulator or connected device:

```sh
pnpm mobile:android
```
