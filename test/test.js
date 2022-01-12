/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
require('bedrock-mongodb');
require('bedrock-https-agent');
require('bedrock-server');
const {getServiceIdentities} = require('bedrock-app-identity');
require('bedrock-meter-usage-reporter');
const {handlers} = require('bedrock-meter-http');

const mockData = require('./mock-product-id-map');

bedrock.events.on('bedrock.init', async () => {
  /* Handlers need to be added before `bedrock.start` is called. These are
      no-op handlers to enable meter usage without restriction */
  handlers.setCreateHandler({
    handler({meter} = {}) {
      // use configured meter usage reporter as service ID for tests
      const clientName = mockData.productIdMap.get(meter.product.id);
      const serviceIdentites = getServiceIdentities();
      const serviceIdentity = serviceIdentites.get(clientName);
      if(!serviceIdentity) {
        throw new Error(`Could not find identity "${clientName}".`);
      }
      meter.serviceId = serviceIdentity.id;
      return {meter};
    }
  });
  handlers.setUpdateHandler({handler: ({meter} = {}) => ({meter})});
  handlers.setRemoveHandler({handler: ({meter} = {}) => ({meter})});
  handlers.setUseHandler({handler: ({meter} = {}) => ({meter})});
});

require('bedrock-test');
bedrock.start();
