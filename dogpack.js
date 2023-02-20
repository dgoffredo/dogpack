const tisch = require('./dependencies/tisch/tisch.js');
const child_process = require('child_process');
const path = require('path');

function invokeProtocJson(protoIncludePaths, protoFiles) {
    // `protoc` gets cranky if the .proto files aren't in directories. To make
    // it work, add the parent directory for each .proto file.
    protoIncludePaths = [...protoIncludePaths, ...protoFiles.map(path.dirname)];

    const includeArgs = protoIncludePaths.map(path => `--proto_path=${path}`);

    const compilerPath =
        path.normalize(
            path.join(
                __dirname, 'dependencies', 'protojson', 'tool.py'));

    const args = [...includeArgs, ...protoFiles];

    const options = {
        encoding: 'utf8',
        // Let `stderr` pass through to our `stderr`, because I couldn't get
        // node to capture the error output using "pipe". I don't know why.
        stdio: ['ignore', 'pipe', 'inherit']
    };

    const result = child_process.spawnSync(compilerPath, args, options);

    if (result.status !== 0) {
        // "protoc terminated with status 1", or
        // "protoc terminated with signal 11"
        const what = result.status === null ? 'signal' : 'status';
        const value = result.status === null ? result.signal : result.status;
        throw Error(`protoc terminated with ${what} ${value}`);
    }

    return JSON.parse(result.stdout);
}

function protoToMessagePackTisch(protoFiles) {
    // TODO
    return invokeProtocJson([], ['span.proto', 'tracer_payload.proto']);
}

module.exports = {
    protoToMessagePackTisch
};
