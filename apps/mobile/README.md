# Mobile local persistence and image capture

The React Native CLI app stores report metadata and upload state in the
`field-reporting.sqlite` private database. Versioned migrations live in
`src/storage/database.ts`; SQLite remains the source of truth for drafts,
images, and delivery state. Image bytes stay in app-private files, not SQLite.

## Native libraries

- [`@op-engineering/op-sqlite`](https://github.com/OP-Engineering/op-sqlite)
  provides transactional SQLite storage with parameterized queries.
- [`react-native-blob-util`](https://github.com/RonRadtke/react-native-blob-util)
  copies images to private persistent storage, checks their actual file size,
  hashes them, and cleans up unreferenced files.
- [`react-native-image-picker`](https://github.com/react-native-image-picker/react-native-image-picker)
  launches the system camera and Android photo picker. Gallery selection uses
  the system picker, so the app does not request broad photo/media access.
- [`@bam.tech/react-native-image-resizer`](https://github.com/bamlab/react-native-image-resizer)
  processes local files natively and supports JPEG/PNG; WebP output is
  supported on Android.
- `uuid` with `react-native-get-random-values` creates stable UUIDv4 report and
  image identifiers.

The Android app's min SDK is 24. AndroidX Activity 1.9.3 is pinned to support
the backported Photo Picker on devices below API 30. Android requests only the
camera permission. If denied, the screen offers an Android Settings shortcut;
return to the app and tap **Take Photo** again. The gallery action does not need
a media permission. iOS usage descriptions are included in `Info.plist`.

## Image processing

Picker output is first copied to a dedicated private temporary directory. File size is read
from disk and dimensions are decoded natively. Files already below 5 MiB and
at most 2048 pixels on their longest edge are not recompressed. Larger files
are resized with aspect ratio preserved and tried at progressively lower
dimensions; JPEG/WebP use a bounded quality sequence. The limit is strict:
each result must be nonempty and **less than** 5 MiB according to a fresh file
stat. Unsupported/corrupt formats or images that remain too large are rejected.
The resizer corrects EXIF orientation on Android; it does not preserve EXIF
metadata. On iOS, the library does not guarantee EXIF orientation correction,
so large/orientation-dependent images should be validated on an iOS device
before enabling this workflow there. WebP processing is rejected on iOS because
the selected resizer does not produce WebP there.

Verified outputs are copied to the report image directory, then associated
with report/image IDs and order in one SQLite transaction. Temporary copies
are removed after persistence (including failed writes), and abandoned cache
files are cleaned during initialization. The repository checks actual stored
size and MIME/extension consistency again before queueing. No upload request is
sent by this milestone.

## Verify and run

From the monorepo root:

```sh
pnpm mobile:typecheck
pnpm --filter com.fieldreporting.mobile exec jest --runInBand
pnpm mobile:android:build
pnpm mobile:start
```

In another terminal, launch the Android app on an emulator or connected device:

```sh
pnpm mobile:android
```

For a real camera/gallery check, grant camera access when prompted, create and
save a draft, then use **Take Photo** or **Choose from Gallery**. Inspect the
image count and size in the draft before queueing it.
