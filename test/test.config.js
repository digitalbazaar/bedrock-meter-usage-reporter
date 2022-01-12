/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const {config} = require('bedrock');
const path = require('path');

config.mocha.tests.push(path.join(__dirname, 'mocha'));

// mongodb config
config.mongodb.name = 'bedrock_meter_usage_reporter_test';
config.mongodb.host = 'localhost';
config.mongodb.port = 27017;
// drop all collections on initialization
config.mongodb.dropCollections = {};
config.mongodb.dropCollections.onInit = true;
config.mongodb.dropCollections.collections = [];

// HTTPS Agent
config['https-agent'].rejectUnauthorized = false;

config['app-identity'].seeds.services = {
  webkms: {
    id: 'did:key:z6MkwZ7AXrDpuVi5duY2qvVSx1tBkGmVnmRjDvvwzoVnAzC4',
    seedMultibase: 'z1AWrfBoQx1mbiWBfWT7eksbtJf91v2pvEpwhoHDzezfaiH',
    serviceType: 'webkms'
  },
  edv: {
    id: 'did:key:z6MkhNyDoLpNcPv5grXoJSJVJjvApd46JU5nPL6cwi88caYW',
    seedMultibase: 'z1AgcCz4zGY5P3covUxqpaGTVs6U12H5aWH1FdyVABCwzkw',
    serviceType: 'edv'
  }
};
