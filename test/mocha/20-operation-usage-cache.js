/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
const {OperationUsageCache} = require(
  'bedrock-meter-usage-reporter/lib/OperationUsageCache');

describe('OperationUsageCache', () => {
  it('should insert operation usage records into usageMap', async () => {
    const operationUsageCache = new OperationUsageCache();

    operationUsageCache.maxSize.should.equal(1000);
    operationUsageCache.usageMap.size.should.equal(0);

    const id1 = 'test-1';
    const id2 = 'test-2';
    const op1 = 200;
    const op2 = 400;

    operationUsageCache.use({id: id1, operations: op1});
    operationUsageCache.use({id: id2, operations: op2});

    operationUsageCache.usageMap.size.should.equal(2);
    operationUsageCache.usageMap.get(id1).should.eql({operations: op1});
    operationUsageCache.usageMap.get(id2).should.eql({operations: op2});
  });
  it('should update operation usage if the id already exists in usageMap',
    async () => {
      const operationUsageCache = new OperationUsageCache();
      const id = 'test';
      const op1 = 200;
      operationUsageCache.use({id, operations: op1});

      operationUsageCache.usageMap.size.should.equal(1);
      operationUsageCache.usageMap.get(id).should.eql({operations: op1});

      const op2 = 1000;
      operationUsageCache.use({id, operations: op2});
      operationUsageCache.usageMap.size.should.equal(1);
      operationUsageCache.usageMap.get(id).should.eql({operations: op1 + op2});
    });
  it('should flush the usageMap when "usageMap.size" equals maxSize',
    async () => {
      const operationUsageCache = new OperationUsageCache({maxSize: 2});

      operationUsageCache.maxSize.should.equal(2);
      operationUsageCache.usageMap.size.should.equal(0);

      const id1 = 'test-1';
      const id2 = 'test-2';
      const id3 = 'test-3';
      const op = 100;
      operationUsageCache.use({id: id1, operations: op});
      operationUsageCache.use({id: id2, operations: op});
      operationUsageCache.use({id: id3, operations: op});

      operationUsageCache.usageMap.size.should.equal(1);
      operationUsageCache.usageMap.get(id3).should.eql({operations: op});
    });
});
