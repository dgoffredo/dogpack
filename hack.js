#!/usr/bin/env node

const dogpack = require('./dogpack.js');
const tisch = require('./dependencies/tisch/tisch.js');
const util = require('util');

function debug(object) {
    console.log(util.inspect(object, {depth: null}));
}

const msgpackSchema = dogpack.protoToMessagePackTisch({protoFiles: ['scratch/span.proto', 'scratch/tracer_payload.proto']});
const validateMsgpack = tisch.compileFunction(msgpackSchema);
const dogpackSchema = dogpack.protoToDogPackTisch({protoFiles: ['scratch/span.proto', 'scratch/tracer_payload.proto']});
const validateDogpack = tisch.compileFunction(dogpackSchema);

module.exports = {dogpack, tisch, debug, msgpackSchema, validateMsgpack, dogpackSchema, validateDogpack};
