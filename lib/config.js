/*
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
import {config} from 'bedrock';

config['meter-usage-reporter'] = {
  report: {
    // report meter usage every 5 minutes; may be slightly randomized
    // default: 5 minutes
    interval: 5 * 60 * 1000,
    // maximum time to lock a meter for reporting
    // default: 5 minutes
    lockTimeout: 5 * 60 * 1000,
    // sample size to fetch for each reportable category
    // default: 10 records
    sampleSize: 10,
    // time that must pass on a touched meter before considering it in need of
    // reporting; busy meters are reported on at most on the hour
    // default: 1 hour
    debounceTime: 60 * 1000,
    // time that must pass to consider a meter stale and in need of reporting;
    // a meter that was touched will take at most 1 day to get reported on;
    // if 1M meters were constantly stale, it would take:
    //   1M/24/60/60 = ~12 ops/sec over 1 day to report on them
    // default: 1 day
    staleTime: 24 * 60 * 60 * 1000
  }
};
