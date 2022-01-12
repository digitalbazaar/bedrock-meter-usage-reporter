/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
const {meters} = require('bedrock-meter-usage-reporter');
const {getAppIdentity} = require('bedrock-app-identity');
const {createMeter, cleanDB} = require('../helpers');
const {AbortController} = require('abort-controller');
const sinon = require('sinon');
const database = require('bedrock-mongodb');

const meterService = `${bedrock.config.server.baseUri}/meters`;
const REPORTER_ABORT_CONTROLLER = new AbortController();

// configure usage aggregator for webkms and edv meters
meters.setAggregator({serviceType: 'webkms', handler: () => {
  return {storage: 0};
}});
meters.setAggregator({serviceType: 'edv', handler: () => {
  return {storage: 0};
}});

describe('meters.upsert()', () => {
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
  it('should return "false" if "result.n" is equal to 0', async () => {
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
    const collection = database.collections['meter-usage-reporter-meter'];
    // mock "updateOne" and set n to 0
    const stub = sinon.stub(collection, 'updateOne').callsFake(() => {
      const result = {
        result: {n: 0}
      };
      return {result};
    });
    let res;
    let err;
    try {
      res = await meters.upsert(
        {id: `${meterService}/${data.meter.id}`, serviceType: 'webkms'});
      stub.restore();
    } catch(e) {
      err = e;
    }
    should.exist(res);
    should.not.exist(err);
    res.should.be.a('boolean');
    res.should.equal(false);
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

      // stub read function to return invalid serviceId
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
  beforeEach(async () => {
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
