/*!
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
require('bedrock-mongodb');
require('bedrock-https-agent');
require('bedrock-server');
require('bedrock-app-key');
require('bedrock-meter-usage-reporter');

require('bedrock-test');
bedrock.start();
