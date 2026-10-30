/*!
 * Copyright (c) 2021-2026 Digital Bazaar, Inc.
 */
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import {cleanDB, createMeter} from '../helpers.js';
import {AbortController} from 'abort-controller';
import delay from 'delay';
import {getAppIdentity} from '@bedrock/app-identity';
import {meters} from '@bedrock/meter-usage-reporter';
import sinon from 'sinon';

import {OperationUsageCache} from '@bedrock/meter-usage-reporter';

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
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
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
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
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
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
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
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
      }
    };
    const {data} = await createMeter({meter, invocationSigner});
    // insert meter
    const {meter: meterInfo} = await meters.upsert({
      id: `${meterService}/${data.meter.id}`,
      controller,
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
    res.meter.controller.should.equal(controller);
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
  it('checks usage against what is available for new meter', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
      }
    };
    const {data} = await createMeter({meter, invocationSigner});
    // do not insert meter, treat as new
    const meterId = `${meterService}/${data.meter.id}`;

    // stub response from server using limits for meter
    const {ZCAP_CLIENTS} = meters._getZcapClients();
    const zcapClient = ZCAP_CLIENTS.get('webkms');
    const stub = sinon.stub(zcapClient, 'read').callsFake(() => {
      return {
        data: {
          // should get converted to full ID in `hasAvailable()`
          id: data.meter.id,
          controller: data.meter.controller,
          disabled: false,
          limits: {operations: 180, storage: 150},
          usage: {operations: 0, storage: 0},
          serviceId: zcapClient.id
        }
      };
    });

    // resources to check against what's available
    const resources = {
      operations: 80,
      storage: 50
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
    } finally {
      stub.restore();
    }
    should.not.exist(err);
    should.exist(res);
    should.exist(res.meter);
    res.meter.should.be.an('object');
    res.meter.id.should.equal(meterId);
    res.meter.controller.should.equal(controller);
    const {limits, usage} = res.meter;
    should.exist(limits);
    limits.should.be.an('object');
    limits.should.have.keys(['storage', 'operations']);
    limits.operations.should.equal(180);
    limits.storage.should.equal(150);
    should.exist(usage);
    usage.should.be.an('object');
    usage.should.have.keys(['storage', 'operations', 'available']);
    usage.operations.should.equal(0);
    usage.storage.should.equal(0);
    usage.available.should.be.an('object');
    usage.available.should.have.keys(['storage', 'operations']);
    usage.available.operations.should.equal(180);
    usage.available.storage.should.equal(150);
    should.exist(res.hasAvailable);
    res.hasAvailable.should.be.a('boolean');
    res.hasAvailable.should.equal(true);
  });
  it('checks usage against what is available for existing meter', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
      },
      limits: {operations: 180, storage: 150}
    };
    const {data} = await createMeter({meter, invocationSigner});
    // insert meter
    const {meter: {id: meterId}} = await meters.upsert({
      id: `${meterService}/${data.meter.id}`,
      controller,
      serviceType: 'webkms',
      limits: {operations: 180, storage: 150}
    });
    // add usage
    const operationUsageCache = new OperationUsageCache();
    operationUsageCache.use({id: meterId, operations: 20, storage: 10});
    await operationUsageCache.flush();

    // stub response from server using limits for meter
    const {ZCAP_CLIENTS} = meters._getZcapClients();
    const zcapClient = ZCAP_CLIENTS.get('webkms');
    const stub = sinon.stub(zcapClient, 'read').callsFake(() => {
      return {
        data: {
          // should get converted to full ID in `hasAvailable()`
          id: data.meter.id,
          controller: data.meter.controller,
          disabled: false,
          limits: {operations: 180, storage: 150},
          usage: {operations: 0, storage: 0},
          serviceId: zcapClient.id
        }
      };
    });

    // resources to check against what's available
    const resources = {
      operations: 80,
      storage: 50
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
    } finally {
      stub.restore();
    }
    should.exist(res);
    should.not.exist(err);
    should.exist(res.meter);
    res.meter.should.be.an('object');
    res.meter.id.should.equal(meterId);
    should.exist(res.meter.controller);
    // should be backfilled by call to `hasAvailable`
    res.meter.controller.should.equal(controller);
    const {limits, usage} = res.meter;
    should.exist(limits);
    limits.should.be.an('object');
    limits.should.have.keys(['storage', 'operations']);
    limits.operations.should.equal(180);
    limits.storage.should.equal(150);
    should.exist(usage);
    usage.should.be.an('object');
    usage.should.have.keys(['storage', 'operations', 'available']);
    usage.operations.should.equal(20);
    usage.storage.should.equal(10);
    usage.available.should.be.an('object');
    usage.available.should.have.keys(['storage', 'operations']);
    usage.available.operations.should.equal(160);
    usage.available.storage.should.equal(140);
    should.exist(res.hasAvailable);
    res.hasAvailable.should.be.a('boolean');
    res.hasAvailable.should.equal(true);
  });
  it('checks usage and backfills controller and limits', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
      },
      limits: {operations: -1, storage: -1}
    };
    const {data} = await createMeter({meter, invocationSigner});
    // insert meter
    const {meter: {id: meterId}} = await meters.upsert({
      id: `${meterService}/${data.meter.id}`,
      serviceType: 'webkms'
    });

    // stub response from server using limits for meter
    const {ZCAP_CLIENTS} = meters._getZcapClients();
    const zcapClient = ZCAP_CLIENTS.get('webkms');
    const stub = sinon.stub(zcapClient, 'read').callsFake(() => {
      return {
        data: {
          // should get converted to full ID in `hasAvailable()`
          id: data.meter.id,
          controller: data.meter.controller,
          disabled: false,
          limits: {operations: 180, storage: 150},
          usage: {operations: 20, storage: 10},
          serviceId: zcapClient.id
        }
      };
    });

    // resources to check against what's available
    const resources = {
      operations: 80,
      storage: 50
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
    } finally {
      stub.restore();
    }
    should.exist(res);
    should.not.exist(err);
    should.exist(res.meter);
    res.meter.should.be.an('object');
    res.meter.id.should.equal(meterId);
    should.exist(res.meter.controller);
    // should be backfilled by call to `hasAvailable`
    res.meter.controller.should.equal(controller);
    const {limits, usage} = res.meter;
    should.exist(limits);
    limits.should.be.an('object');
    limits.should.have.keys(['storage', 'operations']);
    limits.operations.should.equal(180);
    limits.storage.should.equal(150);
    should.exist(usage);
    usage.should.be.an('object');
    usage.should.have.keys(['storage', 'operations', 'available']);
    // no usage recorded yet
    usage.operations.should.equal(0);
    usage.storage.should.equal(0);
    usage.available.should.be.an('object');
    usage.available.should.have.keys(['storage', 'operations']);
    usage.available.operations.should.equal(180);
    usage.available.storage.should.equal(150);
    should.exist(res.hasAvailable);
    res.hasAvailable.should.be.a('boolean');
    res.hasAvailable.should.equal(true);
  });
  it('checks usage and backfills controller and limits', async () => {
    const {id: controller, keys} = getAppIdentity();
    const invocationSigner = keys.capabilityInvocationKey.signer();

    const meter = {
      controller,
      product: {
        // mock ID for webkms service product
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
      },
      limits: {operations: -1, storage: -1}
    };
    const {data} = await createMeter({meter, invocationSigner});
    // insert meter
    const {meter: {id: meterId}} = await meters.upsert({
      id: `${meterService}/${data.meter.id}`,
      controller,
      serviceType: 'webkms',
      limits: {operations: -1, storage: -1}
    });

    // stub response from server using limits for meter
    const {ZCAP_CLIENTS} = meters._getZcapClients();
    const zcapClient = ZCAP_CLIENTS.get('webkms');
    const stub = sinon.stub(zcapClient, 'read').callsFake(() => {
      return {
        data: {
          // should get converted to full ID in `hasAvailable()`
          id: data.meter.id,
          controller: data.meter.controller,
          disabled: false,
          limits: {operations: 180, storage: 150},
          usage: {operations: 20, storage: 10},
          serviceId: zcapClient.id
        }
      };
    });

    try {
      // resources to check against what's available
      const resources = {
        operations: 80,
        storage: 50
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
      should.exist(res.meter.controller);
      res.meter.controller.should.equal(controller);
      const {limits, usage} = res.meter;
      should.exist(limits);
      limits.should.be.an('object');
      limits.should.have.keys(['storage', 'operations']);
      limits.operations.should.equal(180);
      limits.storage.should.equal(150);
      should.exist(usage);
      usage.should.be.an('object');
      usage.should.have.keys(['storage', 'operations', 'available']);
      usage.operations.should.equal(0);
      usage.storage.should.equal(0);
      usage.available.should.be.an('object');
      usage.available.should.have.keys(['storage', 'operations']);
      usage.available.operations.should.equal(180);
      usage.available.storage.should.equal(150);
      should.exist(res.hasAvailable);
      res.hasAvailable.should.be.a('boolean');
      res.hasAvailable.should.equal(true);

      // delay and check again -- afterwhich meter limits should be updated
      await delay(250);

      // resources to check against what's available
      {
        const resources = {
          operations: 80,
          storage: 50
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
        should.exist(res.meter.controller);
        // should be backfilled by call to `hasAvailable`
        res.meter.controller.should.equal(controller);
        const {limits, usage} = res.meter;
        should.exist(limits);
        limits.should.be.an('object');
        limits.should.have.keys(['storage', 'operations']);
        limits.operations.should.equal(180);
        limits.storage.should.equal(150);
        should.exist(usage);
        usage.should.be.an('object');
        usage.should.have.keys(['storage', 'operations', 'available']);
        // no usage recorded yet
        usage.operations.should.equal(0);
        usage.storage.should.equal(0);
        usage.available.should.be.an('object');
        usage.available.should.have.keys(['storage', 'operations']);
        usage.available.operations.should.equal(180);
        usage.available.storage.should.equal(150);
        should.exist(res.hasAvailable);
        res.hasAvailable.should.be.a('boolean');
        res.hasAvailable.should.equal(true);
      }
    } finally {
      stub.restore();
    }
  });
  it('should throw error on unexpected service type for new meter',
    async () => {
      const {id: controller, keys} = getAppIdentity();
      const invocationSigner = keys.capabilityInvocationKey.signer();

      const meter = {
        controller,
        product: {
          // mock ID for webkms service product
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
        }
      };
      const {data} = await createMeter({meter, invocationSigner});
      // do not insert meter to ensure remote end is checked
      const meterId = `${meterService}/${data.meter.id}`;

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
  it('should throw error on expected service type for existing meter',
    async () => {
      const {id: controller, keys} = getAppIdentity();
      const invocationSigner = keys.capabilityInvocationKey.signer();

      const meter = {
        controller,
        product: {
          // mock ID for webkms service product
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
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
      err.name.should.equal('DataError');
      err.details.httpStatusCode.should.equal(400);
      err.message.should.equal(
        'Expected meter service type "not-a-configured-client".');
    });
  it('should throw error if meter "serviceId" does not match "clientId"',
    async () => {
      const {id: controller, keys} = getAppIdentity();
      const invocationSigner = keys.capabilityInvocationKey.signer();

      const meter = {
        controller,
        product: {
          // mock ID for edv service product
          id: 'urn:uuid:dbd15f08-ff67-11eb-893b-10bf48838a41'
        }
      };
      const {data} = await createMeter({meter, invocationSigner});
      // do not insert meter to ensure remote end is checked
      const meterId = `${meterService}/${data.meter.id}`;
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
          serviceId: 'did:key:invalid-service-id'
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
      } catch(e) {
        err = e;
      } finally {
        stub.restore();
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
          id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
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
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
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
        id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'
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
        id: 'https://localhost:18443/meters/z1A1WHsjMmHdWUruTEu5jRZYX'
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
