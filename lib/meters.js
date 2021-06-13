/*!
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
import {AbortController} from 'abort-controller';
import assert from 'assert-plus';
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import delay from 'delay';
import {logger} from './logger.js';
import {shuffle} from 'lodash';

const {util: {BedrockError}} = bedrock;

const REPORTING_JOB_ABORT_CONTROLLER = new AbortController();
let _reportingJobFinished;
const AGGREGATORS = new Map();
const METER_CACHE = new Map();

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections(['meter-usage-reporter-meter']);

  await database.createIndexes([{
    // cover meter uniqueness and updates; if sharding, it should use this key
    collection: 'meter-usage-reporter-meter',
    fields: {'meter.id': 1},
    options: {unique: true, background: false}
  }, {
    // cover queries for unlocked records for reporting; meters need reporting
    // when touched ('meta.touched') or stale ('meta.reported' < N) ... these
    // queries will scatter-gather if the collection is sharded by they are not
    // in hot paths
    collection: 'meter-usage-reporter-meter',
    fields: {'meta.reportLock': 1, 'meta.touched': 1, 'meta.reported': 1},
    options: {unique: false, background: false}
  }]);
});

bedrock.events.on('bedrock.ready', async () => {
  // run a job to select eligible meters to report on
  _reportingJobFinished = _runReportingJob();
});

bedrock.events.on('bedrock.exit', async () => {
  // abort reporting job
  REPORTING_JOB_ABORT_CONTROLLER.abort();
  await _reportingJobFinished;
});

/* FIXME:
1. Add API for updating storage usage. Write updates to in-memory cache and
  then flush them periodically to database. Document that it is ok to lose
  any in-memory updates that are not saved to the database within the
  configured sync interval.
2. Add API call to get latest usage limitations associated with a meter.
  Fetch and apply those limitations on request; ensure memoized promise is used
  to reduce fetches.
*/

// FIXME: document
export async function add({meterCapability, serviceType} = {}) {
  assert.object(meterCapability, 'meterCapability');
  assert.string(serviceType, 'serviceType');

  if(!AGGREGATORS.has(serviceType)) {
    throw new Error(`Unknown service type "${serviceType}".`);
  }

  // FIXME: upsert meter zcap (we can presume the storage for the meter
  // itself is already accounted for/coered since meter is valid); it
  // should only be added if the zcap is the most recent/last to expire
  const id = meterCapability.invocationTarget.id ||
    meterCapability.invocationTarget;

  // FIXME: compute expires so upsert only occurs if expires is later than
  // the current record (if any) ... the way this would work would be that
  // we would search for a record that has a later expires than ours... and
  // if not found, we would try to do an insert, which would fail with a
  // duplicate meter ID error which we'd ignore; if it was found, we'd just
  // update `meterCapability`

  const now = Date.now();
  const record = {
    meta: {
      created: now,
      updated: now,
      touched: false,
      reported: 0
    },
    meter: {
      id,
      meterCapability,
      serviceType
    }
  };

  // FIXME: do upsert

  return record;
}

/**
 * Gets unlocked, touched meter records that have not been touched again in
 * `debounceTime`. A touched meter record is the record for a meter that has
 * recently had usage reported on it.
 *
 * @returns {Promise<Array>} An array of meter records.
 */
 export async function getTouched() {
  // return unlocked, touched meter records that haven't been touched
  // in `debounceTime`
  const {report: {sampleSize, debounceTime}} = config['meter-usage-reporter'];
  const collection = database.collections['meter-usage-reporter-meter'];
  const projection = {'meter': 1, 'meta': 1};
  const now = Date.now();
  return collection.find({
    'meta.reportLock': {$lt: now},
    'meta.touched': true,
    'meta.reported': {$lt: now - debounceTime}
  }, {projection}).limit(sampleSize).toArray();
}

/**
 * Gets unlocked, untouched meter records that haven't been reported in
 * `staleTime` (per this module's configuration).
 *
 * @returns {Promise<Array>} An array of meter records.
 */
export async function getStale() {
  // return unlocked, untouched meter records that haven't been reported
  // in `staleTime`
  const {report: {sampleSize, staleTime}} = config['meter-usage-reporter'];
  const collection = database.collections['meter-usage-reporter-meter'];
  const projection = {'meter': 1, 'meta': 1};
  const now = Date.now();
  return collection.find({
    'meta.reportLock': {$lt: now},
    'meta.touched': false,
    'meta.reported': {$lt: now - staleTime}
  }, {projection}).limit(sampleSize).toArray();
}

// FIXME: document
export async function hasAvailable({meterCapability, usage} = {}) {
  // FIXME: use the meter capability to check the meter's usage
}

/**
 * Reports on a sample of meters that are eligible for reporting.
 *
 * @param {object} options - The options to use.
 * @param {AbortSignal} [options.signal] - An abort signal.
 *
 * @returns {Promise<Number>} The number of eligible meters retrieved; this is
 *   not necessarily the number that were reported on.
 */
export async function reportEligibleSample({signal} = {}) {
  /* Find meters to report on. A meter is eligible for reporting if it has
  either:

  1. Been marked as touched over `debounceTime` ago, OR
  2. Not been reported on in `staleTime`.

  A sample of eligible meters is collected and one meter from each of the above
  categories (if any are found) is selected at random and an attempt is made
  to aggregate its usage and report it. This attempt can fail if another
  concurrent process has already marked the meter to report on it. If this
  occurs or if reporting is successful, another meter is selected until the
  entire category is exhausted. In the latter case, this process does not
  report on any meter in that category. This is ok, because it means that other
  processes are reporting on the meters that this process would be reporting
  on.

  In order to prevent concurrent processes from synchronizing in such a way
  that causes only a few concurrent processes to successfully report, reporting
  may be scheduled at randomized intervals.

  Note: The meter collection may be sharded based on meter ID. This rules out
  another approach to this problem where an update query is sent to mark a
  meter to report on instead of grabbing a sample and then trying to mark
  a meter from the sample. This is because an `update` query that modifies only
  one record must include the shard key -- and the required queries would not
  include this information. It is also not ok to do an `updateMany` query
  because then a single process would mark all meters. */
  const [touched, stale] = await Promise.all([getTouched(), getStale()]);
  const eligibleCount = touched.length + stale.length;
  const categories = [shuffle(touched), shuffle(stale)];

  // report on both touched and stale categories concurrently
  await Promise.all(categories.map(
    records => _reportCategory({records, signal})));

  return {eligibleCount};
}

/**
 * Sets the function to use to aggregate meters for the given service type.
 *
 * @param {object} options - The options to use.
 * @param {string} options.serviceType - The service type.
 * @param {Function} options.handler - The handler function.
 */
 export async function setAggregator({serviceType, handler} = {}) {
  assert.string(serviceType, 'serviceType');
  assert.function(handler, 'handler');

  if(AGGREGATORS.has(serviceType)) {
    throw new Error(
      `Aggregator already set for service type "${serviceType}".`);
  }
  AGGREGATORS.set(serviceType, handler);
}

// FIXME: explore additional API changes to reduce implementer burden by
// putting more code in this module instead
export async function use({id, usage} = {}) {
  assert.string(id, 'id');
  assert.object(usage, 'usage');

  // FIXME: check size of METER_CACHE; if full, flush to disk before adding
  // new usage; cache limited based on some max number of meters

  //METER_CACHE.get()

  // FIXME: store usage update in cache
  // FIXME: usage has *new* operations; add values to a cache that will get
  // committed periodically to meter records that are then marked as `touched`
  // ... later total storage and recent operations will be reported; an
  // aggregate handler function is called to compute total current storage
}

/**
 * Aggregates usage and report it for the meter represented by the given record,
 * provided that it is not concurrently locked (indicating another process is
 * already reporting on it or that there is no registered aggregator function
 * for the meter's service type).
 *
 * @param {object} options - The options to use.
 * @param {object} options.record - The meter record.
 * @param {AbortSignal} options.signal - An abort signal.
 *
 * @returns {Promise<boolean>} `true` if reported, `false` if not.
 */
async function _report({record, signal}) {
  const aggregator = AGGREGATORS.get(record.serviceType);
  if(!aggregator) {
    // cannot aggregate the meter, no registered function for it
    return false;
  }

  // first try to lock record
  const lock = await _lockRecord({record});
  if(lock === 0) {
    // failed to lock record, another process is handling it
    return false;
  }

  // aggregate meter usage
  let usage;
  const {id, meterCapability, serviceType} = record.meter;
  const meter = {id, serviceType};
  try {
    usage = await aggregator({meter, signal});
  } catch(e) {
    logger.error(`Could not report meter (${meter.id}) usage.`, {error: e});
  }

  if(!usage || signal.aborted) {
    await _unlockRecord({record, lock, reported: false});
    // failed to aggregate meter
    return false;
  }

  // report meter usage
  await _sendUsage({meterCapability, usage});

  // unlock record
  await _unlockRecord({record, lock, reported: true});

  return true;
}

async function _runReportingJob() {
  const {report: {interval}} = config['meter-usage-reporter'];
  const {signal} = REPORTING_JOB_ABORT_CONTROLLER;
  while(!signal.aborted) {
    try {
      // report on an eligible sample of meters and then delay for
      // `interval` plus some fuzzing (up to 1 minute) to spread load
      await reportEligibleSample({signal});
      await delay.range(interval, interval + 60000, {signal});
    } catch(e) {
      if(e.name === 'AbortError') {
        break;
      }
      logger.error('Error in meter reporting job.', {error: e});
    }
  }
}

async function _reportCategory({records, signal}) {
  for(const record of category) {
    if(signal.aborted) {
      break;
    }
    await _report({record, signal});
  }
}

async function _lockRecord({record}) {
  // try to mark record with a report lock, expressed as expiration time
  const {report: {lockTimeout}} = config['meter-usage-reporter'];
  const now = Date.now();
  const lock = now + lockTimeout;
  const collection = database.collections['meter-usage-reporter-meter'];
  const {result} = await collection.updateOne({
    'meter.id': record.meter.id,
    'meta.reportLock': record.meta.reportLock
  }, {
    $set: {'meta.reportLock': lock, 'meta.updated': now}
  });
  if(result.n !== 1) {
    // record locked by another process or does not exist
    return 0;
  }
  return lock;
}

async function _unlockRecord({record, lock, reported}) {
  // only unlock record if the report lock has not changed; if it has changed,
  // then presume another process reported on the meter and decremented its
  // unreported operations; any miscount will be an overcount on operations
  const collection = database.collections['meter-usage-reporter-meter'];
  const now = Date.now();
  const update = {};
  if(reported) {
    // report occurred
    update.$dec = {'meter.unreported.operations': meter.unreported.operations};
    update.$set = {
      // always clear `meta.touched`; if another process updated this while the
      // record was locked, then it won't be reported on until the meter is
      // stale or until another subsequent touch occurs (both of these are ok)
      'meta.touched': false,
      'meta.reportLock': 0,
      'meta.reported': now,
      'meta.updated': now
    };
  } else {
    // report did not occur
    update.$set = {'meta.reportLock': 0, 'meta.updated': now};
  }
  return collection.updateOne({
    'meter.id': record.meter.id,
    'meta.reportLock': lock
  }, update);
}

async function _sendUsage({meterCapability, usage}) {
  // FIXME: use http-client + meterCapability
}
