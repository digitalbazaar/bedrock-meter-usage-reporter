/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
export const mockData = {};

// mock product IDs and reverse lookup for webkms/edv/etc service products
mockData.productIdMap = new Map([
  // webkms service
  ['webkms', 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41'],
  ['urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a41', 'webkms'],
  // edv service
  ['edv', 'urn:uuid:dbd15f08-ff67-11eb-893b-10bf48838a41'],
  ['urn:uuid:dbd15f08-ff67-11eb-893b-10bf48838a41', 'edv']
]);
