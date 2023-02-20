#!/usr/bin/env node

const dogpack = require('./dogpack.js');
const tisch = require('./dependencies/tisch/tisch.js');
const util = require('util');

function debug(object) {
    console.log(util.inspect(object, {depth: null}));
}

const protoFiles = ['example/span.proto', 'example/tracer_payload.proto'];

module.exports = {dogpack, tisch, debug, protoFiles};
