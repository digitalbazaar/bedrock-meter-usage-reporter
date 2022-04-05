/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
import * as database from '@bedrock/mongodb';
import assert from 'assert-plus';
import {logger} from './logger.js';

export class OperationUsageCache {
  constructor({maxSize = 1000} = {}) {
    this.maxSize = maxSize;
    this.usageMap = new Map();
  }

  async use({id, operations}) {
    assert.string(id, 'id');
    assert.number(operations, 'operations');

    const {maxSize, usageMap} = this;

    // upsert operation usage
    const record = usageMap.get(id);
    if(!record) {
      usageMap.set(id, {operations});
    } else {
      record.operations += operations;
    }

    if(usageMap.size >= maxSize) {
      await this.flush();
    }
  }

  async flush() {
    if(this.usageMap.size === 0) {
      // nothing to flush
      return;
    }

    // replace existing `usageMap` with a new one
    const {usageMap} = this;
    this.usageMap = new Map();

    // create updates for bulk write
    const updates = [];
    const now = Date.now();
    for(const [meterId, {operations}] of usageMap.entries()) {
      updates.push({
        updateOne: {
          filter: {'meter.id': meterId},
          update: {
            $set: {'meta.touched': true, 'meta.updated': now},
            $inc: {'meter.unreported.operations': operations}
          }
        }
      });
    }

    // do bulk write
    const collection = database.collections['meter-usage-reporter-meter'];
    try {
      await collection.bulkWrite(updates, {ordered: false});
    } catch(e) {
      logger.error(`Could not flush operation usage cache.`, {error: e});
    }
  }
}
