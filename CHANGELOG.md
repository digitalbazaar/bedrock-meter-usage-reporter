# bedrock-meter-usage-reporter ChangeLog

## 9.0.0 - 2023-09-18

### Changed
- **BREAKING**: Drop support for Node.js < 18.
- Use `@digitalbazaar/ed25519-signature-2020@5`.
- Use `@digitalbazaar/ezcap@4`.
- Use `delay@6`. This version requires Node.js 16+.

## 8.0.0 - 2022-06-21

### Changed
- **BREAKING**: Require Node.js >=16.
- Updated dependencies.
- Use `package.json` `files` field.
- Lint module.

## 7.0.0 - 2022-04-29

### Changed
- **BREAKING**: Update peer deps:
  - `@bedrock/core@6`
  - `@bedrock/app-identity@3`
  - `@bedrock/https-agent@4`
  - `@bedrock/mongodb@10`
  - `@bedrock/server@5`.

## 6.0.0 - 2022-04-05

### Changed
- **BREAKING**: Rename package to `@bedrock/meter-usage-reporter`.
- **BREAKING**: Convert to module (ESM).
- **BREAKING**: Remove default export.
- **BREAKING**: Require node 14.x.

## 5.1.0 - 2022-01-17

### Added
- Add additional tests and expose private test helper functions in API.

## 5.0.1 - 2022-01-11

### Fixed
- Fix dependencies and test dependencies.

## 5.0.0 - 2022-01-11

### Changed
- **BREAKING**: Use ezcap@2.

## 4.2.1 - 2022-01-11

### Fixed
- Fixed a number of bugs in reporting code that surfaced with new tests.

### Changed
- Updated tests.

## 4.2.0 - 2021-11-22

### Added
- Get `disabled` flag when obtaining usage if provided. Include `disabled`
  flag in meter information in `hasAvailable` and set availability to `false`
  if a meter is disabled.

## 4.1.1 - 2021-10-08

### Fixed
- Remove obsolete `ensureConfigOverride` setting.

## 4.1.0 - 2021-10-08

### Added
- Add debug logging around reporter shutdown.

### Changed
- Changed variable names to improve readability.
- Make usage of `logger` consistent with other modules.

## 4.0.1 - 2021-10-07

### Fixed
- Use `lodash.shuffle` instead of `lodash` package to reduce potential
  vulnerability surface.

## 4.0.0 - 2021-09-02
- **BREAKING**: Meter usage no longer uses named clients and now depends
  on `bedrock-app-identity` for identity information for services.

## 3.0.0 - 2021-08-31

### Changed
- **BREAKING**: Meter usage reporting now only requires a meter ID and not
  a meter capability. This version of the library must be paired with a
  metering service that sets the root controller for a meter usage endpoint
  to be the ID of the service that is paired with the meter. Such a metering
  service allows the service to invoke the root zcap for the usage endpoint
  to read or write usage without needing a delegated zcap, simplifying
  management and setup.
- **BREAKING**: All APIs that previously required a `meterCapability` now
  require an `id` property with the value of the full URL that identifies
  the meter instead. The `hasAvailable` API additionally requires that the
  expected `serviceType` for the meter be passed.

## 2.0.0 - 2021-08-17

### Changed
- **BREAKING**: The configuration now supports multiple named clients to
  enable multiple services to run within the same application. While some
  systems will be deployed in a microservices architecture whereby each
  service runs independently, others will bundle all services; this change
  allows both architectures to be supported. Applications that use this
  module only need to update their configuration settings to use the new
  format, no other changes are necessary.

## 1.0.0 - 2021-07-22

### Added
- Added core files.
- See git history for changes.
