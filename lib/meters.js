/*!
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
import assert from 'assert-plus';
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';

const {util: {BedrockError}} = bedrock;

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections(['meter-usage-reporter-meter']);

  await database.createIndexes([{
    collection: 'meter-usage-reporter-meter',
    fields: {'meter.id': 1},
    options: {unique: true, background: false}
  }]);
});
