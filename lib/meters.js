/*!
 * Copyright (c) 2021-2026 Digital Bazaar, Inc.
 */
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import {AbortController} from 'abort-controller';
import assert from 'assert-plus';
import {Ed25519Signature2020} from '@digitalbazaar/ed25519-signature-2020';
import {getServiceIdentities} from '@bedrock/app-identity';
import {httpsAgent} from '@bedrock/https-agent';
import {logger} from './logger.js';
import {LruCache} from '@digitalbazaar/lru-memoize';
import {OperationUsageCache} from './OperationUsageCache.js';
import {rangeDelay} from 'delay';
import {ZcapClient} from '@digitalbazaar/ezcap';

const {config, util: {BedrockError}} = bedrock;

let AGGREGATORS = new Map();
let METER_CACHE;
const REPORTER_ABORT_CONTROLLER = new AbortController();
let OPERATION_USAGE_CACHE;
const ZCAP_CLIENTS = new Map();

// a Promise that resolves after the reporter has shutdown cleanly after
// receiving an abort signal
let _reporterShutdownPromise;

/**
 * The AbortSignal is used to notify observers when the abortController.abort()
 * method is called.
 *
 * @typedef AbortSignal
 */

bedrock.events.on('bedrock.init', async () => {
  const {meterCache, operationUsageCache} = config['meter-usage-reporter'];
  METER_CACHE = new LruCache(meterCache);
  OPERATION_USAGE_CACHE = new OperationUsageCache(operationUsageCache);

  // load client info for reporting meter usage
  const serviceIdentities = getServiceIdentities();
  for(const [, {id, serviceType, keys}] of serviceIdentities.entries()) {
    const {capabilityInvocationKey} = keys;
    if(capabilityInvocationKey.type !== 'Ed25519VerificationKey2020') {
      const {type} = capabilityInvocationKey;
      throw new Error(`Unsupported verification key: "${type}".`);
    }
    const zcapClient = new ZcapClient({
      agent: httpsAgent,
      invocationSigner: capabilityInvocationKey.signer(),
      SuiteClass: Ed25519Signature2020
    });
    zcapClient.id = id;
    ZCAP_CLIENTS.set(serviceType, zcapClient);
  }
});

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections(['meter-usage-reporter-meter']);

  await database.createIndexes([{
    // cover meter uniqueness and updates; if sharding, it should use this key
    collection: 'meter-usage-reporter-meter',
    fields: {'meter.id': 1},
    options: {unique: true}
  }, {
    // cover queries for unlocked records for reporting; meters need reporting
    // when touched ('meta.touched') or stale ('meta.reported' < N) ... these
    // queries will scatter-gather if the collection is sharded by they are not
    // in hot paths
    collection: 'meter-usage-reporter-meter',
    fields: {'meta.reportLock': 1, 'meta.touched': 1, 'meta.reported': 1},
    options: {unique: false}
  }]);
});

bedrock.events.on('bedrock.ready', () => {
  // start the meter reporter which runs continuously
  _reporterShutdownPromise = _startReporter();
});

bedrock.events.on('bedrock.exit', async () => {
  if(OPERATION_USAGE_CACHE) {
    // flush operation cache
    await OPERATION_USAGE_CACHE.flush().catch();
  }

  try {
    // abort reporting job
    REPORTER_ABORT_CONTROLLER.abort();
    logger.debug('Sent abort signal to reporter, waiting for shutdown...');
    await _reporterShutdownPromise;
    logger.debug('Reporter shutdown was successful.');
  } catch(e) {
    logger.error('Error during reporter shutdown.', {error: e});
  }
});

/**
 * Upserts a meter.
 *
 * @param {object} options - The options to use.
 * @param {string} options.id - The full URL that identifies the meter
 *   for reading and writing usage.
 * @param {string} options.serviceType - The service type identifier for the
 *   service associated with the meter.
 * @param {boolean} [options.disabled=false] - Whether or not the meter is
 *   disabled.
 * @param {object} [options.limits={operations: -1, storage: -1}] - The limits
 *   for the meter.
 *
 * @returns {Promise<object>} An object with `{meter: {id}}` on success.
 */
export async function upsert({
  id, serviceType, disabled = false,
  limits = {operations: -1, storage: -1}
} = {}) {
  assert.string(id, 'id');
  assert.string(serviceType, 'serviceType');
  assert.bool(disabled, 'disabled');
  assert.number(limits?.operations, 'limits.operations');
  assert.number(limits?.storage, 'limits.storage');

  if(!AGGREGATORS.has(serviceType)) {
    throw new Error(`Unknown service type "${serviceType}".`);
  }

  /* Note: The metering design is such that we can presume the storage for the
  meter information itself is already covered since meter is valid. So we don't
  need to report any usage for storing the meter information. */

  // validate `id` as starting with an origin value from the configured
  // allow list
  _checkMeterServiceAllowList({id});

  const query = {
    'meter.id': id
    // Note: While `serviceType` cannot be changed, it is presumed that a
    // check has already been performed on the meter to ensure the service
    // type matches, so there's no need to check that here.
  };
  const now = Date.now();
  const $set = {
    'meter.disabled': disabled,
    'meter.limits.operations': limits.operations,
    'meter.limits.storage': limits.storage,
    'meta.updated': now
  };
  const $setOnInsert = {
    'meter.id': id,
    'meter.serviceType': serviceType,
    'meter.unreported.operations': 0,
    'meter.usage.operations': 0,
    'meter.usage.storage': 0,
    'meta.created': now,
    'meta.touched': false,
    'meta.reported': 0,
    'meta.reportLock': 0
  };
  const update = {$set, $setOnInsert};
  const collection = database.collections['meter-usage-reporter-meter'];
  await collection.updateOne(query, update, {upsert: true});

  return {meter: {id}};
}

/**
 * Gets the meter record by ID.
 *
 * @param {object} options - The options to use.
 * @param {string} [options.id] - The ID of the meter to get.
 * @param {boolean} [options.useCache=false] - `true` to allow returning a
 *   cached value, `false` not to; defaults to `false` for backwards
 *   compatibility where a cache was previously unavailable.
 *
 * @returns {Promise<object>} The meter record.
 */
export async function get({id, useCache = false} = {}) {
  assert.string(id, 'id');
  assert.bool(useCache, 'useCache');
  if(useCache) {
    const fn = () => _getUncachedMeter({id});
    return METER_CACHE.memoize({key: id, fn});
  }
  return _getUncachedMeter({id});
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
  const projection = {meter: 1, meta: 1};
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
 * @param {string} options.id - The full URL that identifies the meter
 *   for reading and writing usage.
 * @param {string} options.serviceType - The type of service the meter
 *   is expected to be for (if there is no match, an error will be thrown).
 * @param {object} [options.resources={}] - The `storage` and/or `operations`
 *   to check for.
 * @param {boolean} [options.useCache=true] - `true` to allow returning a
 *   cached value, `false` not to.
 *
 * @returns {Promise<object>} An object with `meter` with the meter usage
 *   information and `hasAvailable` as a boolean set to `true` if using the
 *   given resources would not breach the meter's configured constraints.
 */
export async function hasAvailable({
  id, serviceType, resources = {}, useCache = true
} = {}) {
  assert.string(id, 'id');
  assert.string(serviceType, 'serviceType');
  assert.object(resources, 'resources');
  assert.bool(useCache, 'useCache');

  const {meter} = await _getMeterForUsageCheck({id, serviceType, useCache});

  // check `resources` against `limits`
  const {operations = 0, storage = 0} = resources;
  const availableOperations = meter.limits.operations === -1 ?
    Infinity : (meter.limits.operations - meter.usage.operations);
  const availableStorage = meter.limits.storage === -1 ?
    Infinity : (meter.limits.storage - meter.usage.storage);
  return {
    meter: {
      id: meter.id,
      controller: meter.controller,
      disabled: meter.disabled,
      limits: {...meter.limits},
      usage: {
        ...meter.usage,
        // backwards compatibility
        available: {operations: availableOperations, storage: availableStorage}
      }
    },
    hasAvailable: !meter.disabled &&
      storage <= availableStorage &&
      operations <= availableOperations
  };
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
  const categories = [_shuffle(touched), _shuffle(stale)];

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
  assert.func(handler, 'handler');

  if(AGGREGATORS.has(serviceType)) {
    throw new Error(
      `Aggregator already set for service type "${serviceType}".`);
  }
  AGGREGATORS.set(serviceType, handler);
}

/**
 * Adds used operations or storage to the given meter for later reporting.
 *
 * @param {object} options - The options to use.
 * @param {string} options.id - The ID of the meter.
 * @param {number} [options.operations=0] - The number of operations to add.
 * @param {number} [options.storage=0] - The amount of storage to add.
 *
 * @returns {Promise<undefined>} Resolves once the operation completes.
 */
export async function use({id, operations = 0, storage = 0} = {}) {
  return OPERATION_USAGE_CACHE.use({id, operations, storage});
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
  const {id, serviceType, unreported} = record.meter;
  const aggregator = AGGREGATORS.get(serviceType);
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
  let disabled = false;
  let usage;
  let limits;
  const meter = {id, serviceType};
  try {
    // get remote limits and disabled status
    ({limits, disabled} = await _getRemoteUsage({id, serviceType}));
    // use aggregator to get updated accurate usage
    usage = await aggregator({meter, signal});
    usage.operations = usage.operations ?? 0;
    usage.storage = usage.storage ?? 0;
  } catch(e) {
    logger.error(`Could not report meter (${meter.id}) usage.`, {error: e});
  }

  if(!usage || (signal && signal.aborted)) {
    await _unlockRecord({record, lock, reported: false});
    // failed to aggregate meter
    return false;
  }

  // add unreported operations from the meter to the usage
  /* Note: It is safe to add the unreported operations from the
  previously retrieved record even though it was retrieved
  prior to locking the record. This is because proper usage
  of the lock API causes the lock to fail if the record has
  changed. */
  usage.operations += unreported.operations;

  // report meter usage
  await _sendUsage({id, usage, record});

  // unlock record
  await _unlockRecord({record, lock, reported: true, disabled, limits, usage});

  return true;
}

async function _startReporter() {
  // first, flush operation usage cache and ignore errors
  await OPERATION_USAGE_CACHE.flush().catch();

  const {report: {interval, intervalFuzzTime}} = config['meter-usage-reporter'];
  const {signal} = REPORTER_ABORT_CONTROLLER;
  while(!signal.aborted) {
    try {
      // report on an eligible sample of meters and then delay for
      // `interval` plus some fuzzing to spread load
      await reportEligibleSample({signal});
      await rangeDelay(interval, interval + intervalFuzzTime, {signal});
    } catch(e) {
      if(e.name === 'AbortError') {
        break;
      }
      logger.error('Error in meter reporting job.', {error: e});
    }
  }
}

async function _reportCategory({records, signal}) {
  for(const record of records) {
    if(signal && signal.aborted) {
      break;
    }
    await _report({record, signal});
  }
}

export async function _lockRecord({record}) {
  // try to mark record with a report lock, expressed as expiration time
  const {report: {lockTimeout}} = config['meter-usage-reporter'];
  const now = Date.now();
  const lock = now + lockTimeout;
  const collection = database.collections['meter-usage-reporter-meter'];
  const result = await collection.updateOne({
    'meter.id': record.meter.id,
    'meta.reportLock': record.meta.reportLock
  }, {
    $set: {'meta.reportLock': lock, 'meta.updated': now}
  });
  if(result.modifiedCount !== 1) {
    // record locked by another process or does not exist
    return 0;
  }
  return lock;
}

async function _unlockRecord({
  record, lock, reported, disabled, limits, usage
}) {
  // only unlock record if the report lock has not changed; if it has changed,
  // then presume another process reported on the meter and decremented its
  // unreported operations; any miscount will be an overcount on operations
  const collection = database.collections['meter-usage-reporter-meter'];
  const now = Date.now();
  const update = {};
  if(reported) {
    const {meter: {unreported: {operations}}} = record;
    // report occurred
    update.$inc = {'meter.unreported.operations': -operations};
    update.$set = {
      // replace with the latest remote information
      'meter.disabled': disabled,
      'meter.limits': limits,
      // replace with the latest aggregated usage
      'meter.usage': usage,
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

async function _sendUsage({id/*, usage, record*/}) {
  // check the meter's ID against the configured allow list
  _checkMeterServiceAllowList({id});

  // FIXME: use `ZCAP_CLIENTS` + meter usage URL
  //const url = `${id}/usage`;

  // FIXME: if reporting fails due to bad zcap or disabled meter error,
  // then call `reportUsageFailure` hook to disable any services that rely on
  // the meter; if reporting is a success, call `reportUsageSuccess` hook
  // to enable re-enabling of any services
}

async function _getRemoteUsage({id, serviceType}) {
  // check the meter ID target against the configured allow list
  _checkMeterServiceAllowList({id});

  // get usage information from metering service
  const url = `${id}/usage`;
  const client = ZCAP_CLIENTS.get(serviceType);
  if(!client) {
    throw new BedrockError(
      `Expected meter service type "${serviceType}" is not ` +
      'a configured client.', {
        name: 'NotAllowedError',
        details: {url, httpStatusCode: 403, public: true}
      });
  }
  const response = await client.read({url});
  const {
    data: {
      controller,
      disabled = false,
      limits = {operations: -1, storage: -1},
      usage = {operations: 0, storage: 0},
      serviceId
    }
  } = response;

  // confirm meter service ID is a match for this service
  if(client.id !== serviceId) {
    throw new BedrockError(
      `Meter service ID "${serviceId}" does not match the client ` +
      `ID "${client.id}" configured for service type "${serviceType}".`, {
        name: 'NotAllowedError',
        details: {
          meterId: id, serviceId, clientId: client.id,
          httpStatusCode: 403, public: true
        }
      });
  }

  return {id, controller, disabled, limits, usage};
}

function _checkMeterServiceAllowList({id}) {
  // validate `id` as starting with a `<baseUrl>/meters` value from the
  // configured allow list and does not end in `/`; this ensures that the
  // authority is appropriate and that `/usage` can be appended to it per
  // the expected meter usage API URL format
  const {meterServiceAllowList} = config['meter-usage-reporter'];
  if(!meterServiceAllowList.some(
    baseUrl => id.startsWith(`${baseUrl}/meters/`) && !id.endsWith('/'))) {
    throw new BedrockError(`Meter service endpoint "${id}" not allowed.`, {
      name: 'NotAllowedError',
      details: {url: id, httpStatusCode: 403, public: true}
    });
  }
}

async function _getMeterForUsageCheck({id, serviceType, useCache}) {
  // always kick off fetching remote usage, but it might not be needed
  const remoteUsagePromise = _getRemoteUsage({id, serviceType}).catch(e => e);

  // get local meter, use cache to prefer performance and availability over
  // more accurate enforcement of limits (for close, but fuzzy enforcement)
  let meter;
  try {
    ({meter} = await get({id, useCache}));
    // validate `serviceType`
    if(meter.serviceType !== serviceType) {
      throw new BedrockError(
        `Expected meter service type "${serviceType}".`, {
          name: 'DataError',
          details: {httpStatusCode: 400, public: true}
        });
    }
  } catch(e) {
    if(e.name !== 'NotFoundError') {
      throw e;
    }
  }

  // if local meter is undefined or disabled, use remote value
  if(!meter || meter.disabled) {
    const resultOrError = await remoteUsagePromise;
    if(resultOrError instanceof Error) {
      throw resultOrError;
    }
    const {disabled, limits} = resultOrError;
    if(!meter || !disabled) {
      // insert or re-enable meter
      await upsert({id, serviceType, disabled, limits});
    }
    meter = {
      id,
      serviceType,
      disabled,
      limits,
      usage: {operations: 0, storage: 0}
    };
  }

  return {meter};
}

async function _getUncachedMeter({id}) {
  const collection = database.collections['meter-usage-reporter-meter'];
  const projection = {_id: 0, meter: 1, meta: 1};
  const record = await collection.findOne({'meter.id': id}, {projection});
  if(!record) {
    throw new BedrockError('Meter record not found.', {
      name: 'NotFoundError',
      details: {id, httpStatusCode: 404, public: true}
    });
  }

  // set defaults for backwards compatibility
  if(record.meter.disabled === undefined) {
    record.meter.disabled = false;
  }
  if(record.meter.limits === undefined) {
    record.meter.limits = {operations: -1, storage: -1};
  }
  if(record.usage === undefined) {
    record.usage = {operations: 0, storage: 0};
  }

  return record;
}

// exported for testing purpose
export function _getZcapClients() {
  return {ZCAP_CLIENTS};
}

export function resetAggregrators() {
  AGGREGATORS = new Map();
}

function _shuffle(array) {
  // create shallow copy first
  array = array.slice();
  for(let i = array.length - 1; i > 0; --i) {
    // get a random index from the remaining elements
    const r = Math.floor(Math.random() * (i + 1));
    // swap elements
    [array[i], array[r]] = [array[r], array[i]];
  }
  return array;
}
