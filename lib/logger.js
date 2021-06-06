/*
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from 'bedrock';

export const logger =
  bedrock.loggers.get('app').child('bedrock-meter-usage-reporter');
