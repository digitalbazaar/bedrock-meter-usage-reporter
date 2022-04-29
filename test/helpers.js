/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
import * as database from '@bedrock/mongodb';
import {agent} from '@bedrock/https-agent';
import {config} from '@bedrock/core';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {Ed25519Signature2020} =
  require('@digitalbazaar/ed25519-signature-2020');
const {ZcapClient} = require('@digitalbazaar/ezcap');

export async function createMeter({meter, invocationSigner}) {
  const zcapClient = new ZcapClient({
    agent,
    invocationSigner,
    SuiteClass: Ed25519Signature2020
  });

  const meterService = `${config.server.baseUri}/meters`;

  return zcapClient.write({url: meterService, json: meter});
}

export async function cleanDB() {
  await database.collections['meter-usage-reporter-meter'].deleteMany({});
}
