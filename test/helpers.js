/*!
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const bedrock = require('bedrock');
const {Ed25519Signature2020} = require('@digitalbazaar/ed25519-signature-2020');
const {agent} = require('bedrock-https-agent');
const {ZcapClient} = require('@digitalbazaar/ezcap');
const database = require('bedrock-mongodb');

exports.createMeter = async ({meter, invocationSigner}) => {
  const zcapClient = new ZcapClient({
    agent,
    invocationSigner,
    SuiteClass: Ed25519Signature2020
  });

  const meterService = `${bedrock.config.server.baseUri}/meters`;

  return zcapClient.write({url: meterService, json: meter});
};

exports.cleanDB = async () => {
  await database.collections['meter-usage-reporter-meter'].deleteMany({});
};
