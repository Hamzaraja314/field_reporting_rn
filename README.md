# Field Reporting App

This repository contains a React Native CLI Android application and a pnpm workspace foundation for the Field Reporting App.



## Project structure

Monorepo Architecture

```text
apps/
  api/                 Reserved for the NestJS application (not present)
  mobile/              React Native CLI Android application
    android/           Native Gradle project and AndroidManifest.xml
    App.tsx            Initial Field Reporting foundation screen
packages/
  types/               Shared TypeScript contracts package
docs/
  architecture.md      Initial architecture and planned stages
```

## Mobile development

Start Metro:

```sh
pnpm mobile:start
```

In another terminal, launch the Android app on an available emulator or connected device:

```sh
pnpm mobile:android
```

Build a debug APK:

```sh
pnpm mobile:android:build
```



Run the mobile TypeScript check:

```sh
pnpm mobile:typecheck
```


## API and infrastructure status

The root API scripts target an `@field-reporting/api` workspace package with NestJS `start:dev`, `build`, and `test` scripts:

```sh
pnpm api:dev
pnpm api:build
pnpm api:test
```



