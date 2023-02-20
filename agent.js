#!/usr/bin/env node

// This Node.js script is an HTTP server that pretends to be the Datadog Agent.
// Rather than send traces to Datadog, it instead validates the request body
// against a schema deduced from the request endpoint.
// If the request body matches, 200 is returned with a JSON response body of {}.
// If the request body does not match, 400 is returned with a JSON response
// body that contains an array of errors.

const http = require('http');
const mpack = require('./dependencies/massagepack/massagepack.js');
const tisch = require('./dependencies/tisch/tisch.js');
const dogpack = require('./dogpack.js');
const process = require('process');

const getValidator = (function () {
    const protoFiles = ['example/span.proto', 'example/tracer_payload.proto'];
     // {[endpoint]: msgpack validator function}
    const validators = {
        "/v0.4/traces": (() => {
            const spanSchema = dogpack.protoToMessagePackTisch({protoFiles, messageType: '.pb.Span'});
            console.log({spanSchema});
            const v04Schema = function ({etc}) {
                return [[spanSchema(...arguments), ...etc], ...etc];
            };
            console.log({v04Schema});
            const v04Validator = tisch.compileFunction(v04Schema);
            console.log({v04Validator});
            return function (jsMessage) {
                if (v04Validator(jsMessage)) {
                    return {match: jsMessage};
                }
                return {errors: v04Validator.errors};
            };
        })(),
        "/v0.5/traces": (() => {
            const spanSchema = dogpack.protoToDogPackTisch({protoFiles, messageType: '.pb.Span', options: {omitStringTable: true}});
            const v05Schema = function ({etc}) {
                return [
                    [String, String, ...etc],
                    [[spanSchema(...arguments), ...etc], ...etc]
                ];
            };
            const v05Validator = tisch.compileFunction(v05Schema);
            return function (jsMessage) {
                if (v05Validator(jsMessage)) {
                    return {match: jsMessage};
                }
                return {errors: v05Validator.errors};
            };
        })(),
        "/v0.7/traces": (() => {
            return dogpack.protoToMessagePackValidator({protoFiles});
        })(),
        "/v0.8/traces": (() => {
            return dogpack.protoToDogPackValidator({protoFiles});
        })()
    };

    return function ({endpoint}) {
        return validators[endpoint];
    };
}());

const requestListener = function (request, response) {
  const validator = getValidator({endpoint: request.url});
  console.log('Received request for ', request.url, ' which has validator: ', validator); 
  if (validator === undefined) {
      response.writeHead(404);
      response.end();
      return;
  }
  
  let body = [];
  request.on('data', chunk => {
    // console.log('Received a chunk of data.');
    body.push(chunk);
  }).on('end', () => {
    // console.log('Received end of request.');
    body = Buffer.concat(body);
    const payload = mpack.decode(body, {usemap: true});
    console.log('received message: ', payload);
    const result = validator(payload);
    if (result) {
        response.writeHead(200);
        response.end(JSON.stringify({}));
        return;
    }
    // Didn't match the request schema.
    response.writeHead(400);
    console.error(validator.errors);
    response.end(JSON.stringify(result.errors));
  });
};

const port = 8126;
const server = http.createServer(requestListener);
server.listen(port).on('listening', () => console.log(`node.js web server (agent) is running on port ${port}`));

process.on('SIGTERM', function () {
  console.log('Received SIGTERM');
  server.close(() => process.exit());
});

process.on('SIGINT', function () {
  console.log('Received SIGINT');
  server.close(() => process.exit());
});
