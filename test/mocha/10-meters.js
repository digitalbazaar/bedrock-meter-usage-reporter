/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
const {AbortController} = require('abort-controller');
const bedrock = require('bedrock');
const {createMeter, cleanDB} = require('../helpers');
const database = require('bedrock-mongodb');
const {getAppIdentity} = require('bedrock-app-identity');
const {meters} = require('bedrock-meter-usage-reporter');
const sinon = require('sinon');

const meterService = `${bedrock.config.server.baseUri}/meters`;

describe('meters.upsert()', () => {
  beforeEach(() => {
    // configure usage aggregator for webkms and edv meters
    meters.setAggregator({serviceType: 'webkms', handler: () => {
      return {storage: 0};
    }});
    meters.setAggregator({serviceType: 'edv', handler: () => {
      return {storage: 0};
    }});
  });
  it('should register a meter', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
      }
    };

    const {data} = await createMeter({meter, invocationSigner});

    let res;
    let err;
    try {
      res = await meters.upsert(
        {id: `${meterService}/${data.meter.id}`, serviceType: 'webkms'});
    } catch(e) {
      err = e;
    }
    should.exist(res);
    should.not.exist(err);
    res.meter.id.should.equal(`${meterService}/${data.meter.id}`);
  });
  it('should throw error if "AGGREGATORS" does not contain given "serviceType"',
    async () => {
      const {id: controller, keys} = getAppIdentity();
      const invocationSigner = keys.capabilityInvocationKey.signer();

      const meter = {
        controller,
        product: {
          // mock ID for webkms service product
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
        }
      };

      const {data} = await createMeter({meter, invocationSigner});
      const serviceTypeNotInAggregrator = 'x';
      let res;
      let err;
      try {
        res = await meters.upsert({
          id: `${meterService}/${data.meter.id}`,
          serviceType: serviceTypeNotInAggregrator
        });
      } catch(e) {
        err = e;
      }
      should.not.exist(res);
      should.exist(err);
      err.message.should.equal('Unknown service type "x".');
    });
  it('should throw error if meter service endpoint "id" is not allowed.',
    async () => {
      const {id: controller, keys} = getAppIdentity();
      const invocationSigner = keys.capabilityInvocationKey.signer();

      const meter = {
        controller,
        product: {
          // mock ID for webkms service product
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
        }
      };

      const {data} = await createMeter({meter, invocationSigner});

      let res;
      let err;
      // Use a meterService endpoint that is not allowed
      const meterServiceNotInAllowList = `https://localhost:5000`;
      try {
        res = await meters.upsert({
          id: `${meterServiceNotInAllowList}/${data.meter.id}`,
          serviceType: 'webkms'
        });
      } catch(e) {
        err = e;
      }
      should.not.exist(res);
      should.exist(err);
      err.name.should.equal('NotAllowedError');
      err.details.url.should.equal(
        `${meterServiceNotInAllowList}/${data.meter.id}`);
      err.details.httpStatusCode.should.equal(403);
      err.message.should.equal('Meter service endpoint ' +
      `"${meterServiceNotInAllowList}/${data.meter.id}" not allowed.`);
    });
});

describe('meters.get()', () => {
  beforeEach(() => {
    // configure usage aggregator for webkms and edv meters
    meters.setAggregator({serviceType: 'webkms', handler: () => {
      return {storage: 0};
    }});
    meters.setAggregator({serviceType: 'edv', handler: () => {
      return {storage: 0};
    }});
  });
  it('should get meter record by ID', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
      }
    };
    const {data} = await createMeter({meter, invocationSigner});
    // insert meter
    const {meter: meterInfo} = await meters.upsert({
      id: `${meterService}/${data.meter.id}`,
      serviceType: 'edv'
    });
    const {id: meterId} = meterInfo;

    let res;
    let err;
    try {
      res = await meters.get({id: meterId});
    } catch(e) {
      err = e;
    }
    should.exist(res);
    should.not.exist(err);
    should.exist(res.meter);
    res.meter.should.be.an('object');
    res.meter.id.should.equal(meterId);
    res.meter.serviceType.should.equal('edv');
    should.exist(res.meter.unreported);
    res.meter.unreported.should.be.an('object');
    res.meter.unreported.should.have.key('operations');
    res.meter.unreported.operations.should.equal(0);
  });
  it('should throw error when getting meter record that is not in database',
    async () => {
      const meterNotInDatabase = `${meterService}/xyz`;
      let res;
      let err;
      try {
        res = await meters.get({id: meterNotInDatabase});
      } catch(e) {
        err = e;
      }
      should.not.exist(res);
      should.exist(err);
      err.name.should.equal('NotFoundError');
      err.details.id.should.equal(`${meterService}/xyz`);
      err.details.httpStatusCode.should.equal(404);
      err.message.should.equal('Meter record not found.');
    });
});

describe('meters.hasAvailable()', () => {
  beforeEach(() => {
    // configure usage aggregator for webkms and edv meters
    meters.setAggregator({serviceType: 'webkms', handler: () => {
      return {storage: 0};
    }});
    meters.setAggregator({serviceType: 'edv', handler: () => {
      return {storage: 0};
    }});
  });
  it('checks usage against what is available', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
      }
    };
    const {data} = await createMeter({meter, invocationSigner});
    // insert meter
    const {meter: meterInfo} = await meters.upsert({
      id: `${meterService}/${data.meter.id}`,
      serviceType: 'webkms'
    });
    const {id: meterId} = meterInfo;

    // resources to check against what's available
    const resources = {
      storage: 50,
      operations: 80
    };
    let res;
    let err;
    try {
      res = await meters.hasAvailable({
        id: meterId,
        serviceType: 'webkms',
        resources
      });
    } catch(e) {
      err = e;
    }
    should.exist(res);
    should.not.exist(err);
    should.exist(res.meter);
    res.meter.should.be.an('object');
    res.meter.id.should.equal(meterId);
    const {usage} = res.meter;
    should.exist(usage);
    usage.should.be.an('object');
    usage.should.have.key('available');
    usage.available.should.be.an('object');
    usage.available.should.have.keys(['storage', 'operations']);
    const {storage, operations} = usage.available;
    storage.should.equal(100);
    operations.should.equal(100);
    should.exist(res.hasAvailable);
    res.hasAvailable.should.be.a('boolean');
    res.hasAvailable.should.equal(true);
  });
  it('should throw error if expected service type is not a configured client',
    async () => {
      const {id: controller, keys} = getAppIdentity();
      const invocationSigner = keys.capabilityInvocationKey.signer();

      const meter = {
        controller,
        product: {
          // mock ID for webkms service product
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
        }
      };
      const {data} = await createMeter({meter, invocationSigner});
      // insert meter
      const {meter: meterInfo} = await meters.upsert({
        id: `${meterService}/${data.meter.id}`,
        serviceType: 'webkms'
      });
      const {id: meterId} = meterInfo;

      // resources to check against what's available
      const resources = {
        storage: 50,
        operations: 80
      };

      let res;
      let err;
      try {
        res = await meters.hasAvailable({
          id: meterId,
          serviceType: 'not-a-configured-client',
          resources
        });
      } catch(e) {
        err = e;
      }
      should.exist(err);
      should.not.exist(res);
      err.name.should.equal('NotAllowedError');
      err.details.url.should.equal(`${meterId}/usage`);
      err.details.httpStatusCode.should.equal(403);
      err.message.should.equal(
        'Expected meter service type "not-a-configured-client" is not ' +
        'a configured client.');
    });
  it('should throw error if meter "serviceId" does not match "clientId"',
    async () => {
      const {id: controller, keys} = getAppIdentity();
      const invocationSigner = keys.capabilityInvocationKey.signer();

      const meter = {
        controller,
        product: {
          // mock ID for edv service product
          id: 'urn:uuid:dbd15f08-ff67-11eb-893b-10bf48838a41',
        }
      };
      const {data} = await createMeter({meter, invocationSigner});

      // insert meter
      const {meter: meterInfo} = await meters.upsert({
        id: `${meterService}/${data.meter.id}`,
        serviceType: 'edv'
      });
      const {id: meterId} = meterInfo;
      // resources to check against what's available
      const resources = {
        storage: 50,
        operations: 80
      };
      const {ZCAP_CLIENTS} = meters._getZcapClients();
      const zcapClient = ZCAP_CLIENTS.get('edv');

      // this test demonstrates that the client can handle a bad response
      // from the server, i.e., it doesn't have to rely on the server
      // doing the right thing.
      const stub = sinon.stub(zcapClient, 'read').callsFake(() => {
        const badResponseData = {
          serviceId: 'did:key:invalid-service-id',
        };
        return {data: badResponseData};
      });
      let res;
      let err;
      try {
        res = await meters.hasAvailable({
          id: meterId,
          serviceType: 'edv',
          resources
        });
        stub.restore();
      } catch(e) {
        err = e;
      }
      should.exist(err);
      should.not.exist(res);
      err.name.should.equal('NotAllowedError');
      err.message.should.equal(`Meter service ID "${err.details.serviceId}" ` +
        `does not match the client ID "${err.details.clientId}" configured ` +
        `for service type "edv".`);
      err.details.httpStatusCode.should.equal(403);
    });
});

describe('meters.setAggregator()', () => {
  beforeEach(() => {
    // configure usage aggregator for webkms and edv meters
    meters.setAggregator({serviceType: 'webkms', handler: () => {
      return {storage: 0};
    }});
    meters.setAggregator({serviceType: 'edv', handler: () => {
      return {storage: 0};
    }});
  });
  it('should throw error if aggregator has already been set for service type',
    async () => {
      let res;
      let err;
      try {
        res = await meters.setAggregator({
          serviceType: 'webkms',
          handler: () => {}
        });
      } catch(e) {
        err = e;
      }
      should.exist(err);
      should.not.exist(res);
      err.message.should.equal(
        'Aggregator already set for service type "webkms".');
    });
});

describe('meters.reportEligibleSample()', () => {
  let REPORTER_ABORT_CONTROLLER;
  beforeEach(async () => {
    REPORTER_ABORT_CONTROLLER = new AbortController();
    // configure usage aggregator for webkms and edv meters
    meters.setAggregator({serviceType: 'webkms', handler: () => {
      return {storage: 0};
    }});
    meters.setAggregator({serviceType: 'edv', handler: () => {
      return {storage: 0};
    }});
    await cleanDB();
  });
  it('should return the correct number of eligible meters to report on',
    async () => {
      const {id: controller, keys} = getAppIdentity();
      const invocationSigner = keys.capabilityInvocationKey.signer();

      const meter = {
        controller,
        product: {
          // mock ID for webkms service product
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
        }
      };

      const {data} = await createMeter({meter, invocationSigner});
      await meters.upsert(
        {id: `${meterService}/${data.meter.id}`, serviceType: 'webkms'});

      const operations = 10;
      await meters.use(
        {id: `${meterService}/${data.meter.id}`, operations});

      const {signal} = REPORTER_ABORT_CONTROLLER;

      let result;
      let err;
      try {
        result = await meters.reportEligibleSample({signal});
      } catch(e) {
        err = e;
      }
      should.not.exist(err);
      should.exist(result);
      result.eligibleCount.should.equal(1);
    });
  it('should not report if signal is aborted', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
      }
    };

    const {data} = await createMeter({meter, invocationSigner});
    const meterId = `${meterService}/${data.meter.id}`;
    await meters.upsert({id: meterId, serviceType: 'webkms'});

    const operations = 10;
    await meters.use({id: meterId, operations});

    const {signal} = REPORTER_ABORT_CONTROLLER;
    // Set signal.aborted to true
    REPORTER_ABORT_CONTROLLER.abort();

    await meters.reportEligibleSample({signal});

    const collection = database.collections['meter-usage-reporter-meter'];
    let result;
    let err;
    try {
      result = await collection.findOne({'meter.id': meterId});
    } catch(e) {
      err = e;
    }
    should.not.exist(err);
    should.exist(result);
    result.meta.reported.should.equal(0);
  });
  it('should not report if there are no aggregrators', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41',
      }
    };

    const {data} = await createMeter({meter, invocationSigner});
    const meterId = `${meterService}/${data.meter.id}`;
    await meters.upsert({id: meterId, serviceType: 'webkms'});

    const operations = 10;
    await meters.use({id: meterId, operations});

    const {signal} = REPORTER_ABORT_CONTROLLER;
    // reset aggregrators
    meters.resetAggregrators();

    await meters.reportEligibleSample({signal});

    const collection = database.collections['meter-usage-reporter-meter'];
    let result;
    let err;
    try {
      result = await collection.findOne({'meter.id': meterId});
    } catch(e) {
      err = e;
    }
    should.not.exist(err);
    should.exist(result);
    result.meta.reported.should.equal(0);
  });
});

describe('meters.__lockRecord()', () => {
  it('should return 0 if record does not exist', async () => {
    const nonExistingRecord = {
      meter: {
        id: 'https://localhost:18443/meters/zMGZus2hKwm19SCjNMF1Hhy',
      },
      meta: {
        reportLock: 0
      }
    };

    let result;
    let err;
    try {
      result = await meters._lockRecord({record: nonExistingRecord});
    } catch(e) {
      err = e;
    }
    should.not.exist(err);
    should.exist(result);
    result.should.equal(0);
  });
});
