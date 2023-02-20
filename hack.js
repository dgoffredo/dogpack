#!/usr/bin/env node

const dogpack = require('./dogpack.js');
const util = require('util');

console.log(
util.inspect(dogpack.protoToMessagePackTisch({protoFiles: ['scratch/span.proto', 'scratch/tracer_payload.proto']}),
    {depth: null}))
