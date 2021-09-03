# bedrock-meter-usage-reporter ChangeLog

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
