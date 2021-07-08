/*!
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import {AbortController} from 'abort-controller';
import assert from 'assert-plus';
import delay from 'delay';
import {Ed25519VerificationKey2020} from
  '@digitalbazaar/ed25519-verification-key-2020';
import {httpClient} from '@digitalbazaar/http-client';
import {logger} from './logger.js';
import {OperationUsageCache} from './OperationUsageCache.js';
import {shuffle} from 'lodash';
// FIXME: use ezcap instead
//import {signCapabilityInvocation} from 'http-signature-zcap-invoke';

const {config, util: {BedrockError}} = bedrock;

const AGGREGATORS = new Map();
const REPORTING_JOB_ABORT_CONTROLLER = new AbortController();
let OPERATION_USAGE_CACHE;
let CLIENT;

let _reportingJobFinished;

bedrock.events.on('bedrock.init', async () => {
  const {client, operationUsageCache} = config['meter-usage-reporter'];
  OPERATION_USAGE_CACHE = new OperationUsageCache(operationUsageCache);

  // load client info for reporting meter usage
  const {id, keyPair} = client;
  CLIENT = {
    id,
    keyPair: await Ed25519VerificationKey2020.from(keyPair)
  };
});

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

/**
 * Upserts a meter.
 *
 * @param {object} options - The options to use.
 * @param {object} options.meterCapability - A capability that enables both
 *   reading and writing the meter's usage.
 * @param {string} options.serviceType - The service type identifier for the
 *   service associated with the meter.
 *
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function upsert({meterCapability, serviceType} = {}) {
  assert.object(meterCapability, 'meterCapability');
  assert.string(serviceType, 'serviceType');

  if(!AGGREGATORS.has(serviceType)) {
    throw new Error(`Unknown service type "${serviceType}".`);
  }

  /* Note: The metering design is such that we can presume the storage for the
  meter information itself is already covered since meter is valid. So we don't
  need to report any usage for storing the meter information. */
  const id = meterCapability.invocationTarget.id ||
    meterCapability.invocationTarget;
  const expires = new Date(meterCapability.expires);

  // validate `id` as starting with an origin value from the configured
  // allow list
  _checkMeterServiceAllowList({url: id});

  /* Only upsert if meter capability expiration is later than the current
  record (if any). If the query fails, an insert will be attempted that will
  fail on a duplicate record, which should be ignored. */
  const query = {
    'meter.id': id,
    'meta.meterCapabilityExpires': {$lt: expires}
    // Note: While `serviceType` cannot be changed, it is presumed that a
    // service will offer only one `serviceType` and not share a database
    // for meters, so there's no need to check that here.
  };
  const now = Date.now();
  const $set = {
    'meta.updated': now,
    'meta.meterCapabilityExpires': expires,
    'meter.meterCapability': meterCapability
  };
  const $setOnInsert = {
    'meter.id': id,
    'meter.serverType': serviceType,
    'meter.unreported.operations': 0,
    'meta.created': now,
    'meta.touched': false,
    'meta.reported': 0
  };
  const update = {$set, $setOnInsert};
  const dbOptions = {...database.writeOptions, upsert: true};
  const collection = database.collections['meter-usage-reporter-meter'];
  try {
    const result = await collection.updateOne(query, update, dbOptions);
    // return `true` if the record was updated
    if(result.result.n > 0) {
      return true;
    }
  } catch(e) {
    if(!database.isDuplicateError(e)) {
      throw e;
    }
    /* Note: A duplicate error happens when the query does not match and an
    insert is attempted. A duplicate error on an insert only happens when the
    existing meter capability has a longer expiration period. We can safely
    ignore a duplicate error in the first case, as we don't need to store or do
    anything with the shorter-lived meter capability. */
  }

  return true;
}

/**
 * Gets the meter record by ID.
 *
 * @param {object} options - The options to use.
 * @param {string} [options.id] - The ID of the meter to get.
 *
 * @returns {Promise<object>} The meter record.
 */
export async function get({id} = {}) {
  assert.string(id, 'id');
  const collection = database.collections['meter-usage-reporter-meter'];
  const projection = {_id: 0, meter: 1, meta: 1};
  const record = await collection.findOne({'meter.id': id}, {projection});
  if(!record) {
    throw new BedrockError(
      'Meter record not found.',
      'NotFoundError',
      {id, httpStatusCode: 404, public: true});
  }
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
  const projection = {meter: 1, meta: 1};
  const now = Date.now();
  return collection.find({
    'meta.reportLock': {$lt: now},
    'meta.touched': false,
    'meta.reported': {$lt: now - staleTime}
  }, {projection}).limit(sampleSize).toArray();
}

/**
 * Checks whether using the specified resources would breach the limitations
 * configured for the given meter.
 *
 * @param {object} options - The options to use.
 * @param {object} options.meterCapability - A capability that enables both
 *   reading and writing the meter's usage.
 * @param {object} options.resources - The `storage` and/or `operations` to
 *   check for.
 *
 * @returns {Promise<boolean>} `true` if using the given resources would not
 *   breach the meter's configured constraints.
 */
export async function hasAvailable({meterCapability, resources} = {}) {
  assert.object(meterCapability, 'meterCapability');
  assert.string(serviceType, 'serviceType');

  // use the meter capability to check the meter's usage
  const {available} = await _getUsage({meterCapability});

  // check `resources` against what is `available`
  const {storage = 0, operations = 0} = resources;
  const {availableStorage = 0, availableOperations = 0} = available;
  return storage <= availableStorage && operations <= availableOperations;
}

/**
 * Reports on a sample of meters that are eligible for reporting.
 *
 * @param {object} options - The options to use.
 * @param {AbortSignal} [options.signal] - An abort signal to check.
 *
 * @returns {Promise<number>} The number of eligible meters retrieved; this is
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

/**
 * Adds operations to the given meter for later reporting.
 *
 * @param {object} options - The options to use.
 * @param {string} options.id - The ID of the meter.
 * @param {number} options.operations - The number of operations to add.
 *
 * @returns {Promise<undefined>} Resolves once the operation completes.
 */
export async function use({id, operations} = {}) {
  return OPERATION_USAGE_CACHE.use({id, operations});
}

/**
 * Aggregates usage and report it for the meter represented by the given record,
 * provided that it is not concurrently locked (indicating another process is
 * already reporting on it or that there is no registered aggregator function
 * for the meter's service type).
 *
 * @param {object} options - The options to use.
 * @param {object} options.record - The meter record.
 * @param {AbortSignal} options.signal - An abort signal to check.
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

  if(!usage || (signal && signal.aborted)) {
    await _unlockRecord({record, lock, reported: false});
    // failed to aggregate meter
    return false;
  }

  // add unreported operations from the meter to the usage
  usage.operations += meter.unreported.operations;

  // report meter usage
  await _sendUsage({meterCapability, usage});

  // unlock record
  await _unlockRecord({record, lock, reported: true});

  return true;
}

async function _runReportingJob() {
  // first, flush operation usage cache and ignore errors
  OPERATION_USAGE_CACHE.flush().catch();

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
    if(signal && signal.aborted) {
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
  // check the meterCapability's invocation target against the configured
  // allow list
  const url = meterCapability.invocationTarget.id ||
    meterCapability.invocationTarget;
  _checkMeterServiceAllowList({url});

  // FIXME: use http-client + meterCapability

  // FIXME: if reporting fails a number of times, call a hook to disable
  // using the meter further
}

async function _getUsage({meterCapability}) {
  // check the meterCapability's invocation target against the configured
  // allow list
  const url = meterCapability.invocationTarget.id ||
    meterCapability.invocationTarget;
  _checkMeterServiceAllowList({url});

  // FIXME: use http-client + meterCapability

  // FIXME: metering service should report current usage as well as available
  // usage (the latter of which is determined by a custom usage hook for the
  // metering system)
}

function _checkMeterServiceAllowList({url}) {
  // validate `url` as starting with a `<baseUrl>/meters` value from the
  // configured allow list and ends with `/usage`
  const {meterServiceAllowList} = config['meter-usage-reporter'];
  if(!meterServiceAllowList.some(
    baseUrl => url.startsWith(`${baseUrl}/meters`) && url.endsWith('/usage'))) {
    throw new BedrockError(
      `Meter service endpoint "${url}" not allowed.`,
      'NotAllowedError',
      {id, httpStatusCode: 403, public: true});
  }
}
