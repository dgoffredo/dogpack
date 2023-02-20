#!/usr/bin/env node

const dogpack = require('./dogpack.js');
const tisch = require('./dependencies/tisch/tisch.js');
const util = require('util');

function debug(object) {
    console.log(util.inspect(object, {depth: null}));
}

const rootSchema = dogpack.protoToMessagePackTisch({protoFiles: ['scratch/span.proto', 'scratch/tracer_payload.proto']});
debug(rootSchema);

const validateRoot = tisch.compileFunction(rootSchema);
debug(validateRoot);

module.exports = {dogpack, tisch, debug, schema: rootSchema, validate: validateRoot};
