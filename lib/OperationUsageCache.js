/*!
 * Copyright (c) 2021-2026 Digital Bazaar, Inc.
 */
import * as database from '@bedrock/mongodb';
import assert from 'assert-plus';
import {logger} from './logger.js';

export class OperationUsageCache {
  constructor({flushSchedule = 30 * 1000, maxSize = 1000} = {}) {
    this.flushSchedule = flushSchedule;
    this.maxSize = maxSize;
    this.scheduledFlushId = null;
    this.usageMap = new Map();
  }

  async use({id, operations = 0, storage = 0}) {
    assert.string(id, 'id');
    assert.number(operations, 'operations');
    assert.number(storage, 'storage');

    if(operations === 0 && storage === 0) {
      // nothing to track
      return;
    }

    const {maxSize, usageMap} = this;

    // upsert operation usage
    const record = usageMap.get(id);
    if(!record) {
      usageMap.set(id, {operations, storage});
    } else {
      record.operations += operations;
      record.storage += storage;
    }

    if(usageMap.size >= maxSize) {
      await this.flush();
    } else if(this.scheduledFlushId !== null) {
      // schedule an automatic flush
      this.scheduledFlushId = setTimeout(
        () => this.flush().catch(), this.flushSchedule);
    }
  }

  async flush() {
    if(this.scheduledFlushId !== null) {
      clearTimeout(this.scheduledFlushId);
      this.scheduledFlushId = null;
    }

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
    for(const [meterId, {operations, storage}] of usageMap.entries()) {
      updates.push({
        updateOne: {
          filter: {'meter.id': meterId},
          update: {
            $inc: {
              'meter.unreported.operations': operations,
              'meter.usage.operations': operations,
              'meter.usage.storage': storage
            },
            $max: {'meta.updated': now},
            $set: {'meta.touched': true}
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
