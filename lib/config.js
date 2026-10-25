/*!
 * Copyright (c) 2021-2026 Digital Bazaar, Inc.
 */
import {config, util} from '@bedrock/core';
import '@bedrock/server';
const cc = util.config.main.computer();

config['meter-usage-reporter'] = {
  meterCache: {
    // meter records are a few hundred bytes at most
    max: 1000,
    // TTL is should be kept short for more accurate metering and
    // limit enforcement
    // default: 30 seconds
    ttl: 30 * 1000
  },
  operationUsageCache: {
    maxSize: 1000
  },
  report: {
    // report meter usage every 5 minutes; may be slightly randomized
    // default: 5 minutes
    interval: 5 * 60 * 1000,
    // randomized interval fuzzing to spread the load
    // default: up to 60 seconds
    intervalFuzzTime: 60 * 1000,
    // maximum time to lock a meter for reporting
    // default: 5 minutes
    lockTimeout: 5 * 60 * 1000,
    // sample size to fetch for each reportable category
    // default: 10 records
    sampleSize: 10,
    // time that must pass on a touched meter before considering it in need of
    // reporting; busy meters are reported on at most on the minute
    // default: 1 minute
    debounceTime: 60 * 1000,
    // time that must pass to consider a meter stale and in need of reporting;
    // a meter that was touched will take at most 1 day to get reported on;
    // if 1M meters were constantly stale, it would take:
    //   1M/24/60/60 = ~12 ops/sec over 1 day to report on them
    // default: 1 day
    staleTime: 24 * 60 * 60 * 1000
  }
};

// default `meterServiceAllowList` in dev to use local server
const allowListName = 'meter-usage-reporter.meterServiceAllowList';
cc(allowListName, () => [config.server.baseUri]);

// ensure meter service allow list is overridden in deployments
config.ensureConfigOverride.fields.push(allowListName);
