const tisch = require('./dependencies/tisch/tisch.js');
const child_process = require('child_process');
const path = require('path');

function invokeProtocJson({protoIncludePaths = [], protoFiles = []}) {
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

function enforce(predicate, generateErrorMessage) {
    if (predicate()) {
        return;
    }

    // Assertion failed. Throw an exception with an error message.
    let message = `Assertion predicate failed: ${predicate.toString()}`;
    if (generateErrorMessage) {
        message += ` ${generateErrorMessage()}`;
    }
    throw Error(message);
}

// If `comment` contains a line like '@gotags: json:"type" msg:"type"',
// then return {json: 'type', msg: 'type'}. Otherwise, return {}.
// If `comment` contains multiple '@gotags' lines, throw an exception.
function parseGotags(comment) {
    const gotagsLines = comment
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('@gotags:'));
    
    if (gotagsLines.length === 0) {
        return {};
    }
    enforce(() => gotagsLines.length === 1, () => `comment has more than one @gotags line: ${comment}`);

    return gotagsLines[0]
    .split(/\s+/)
    .slice(1)
    .reduce((tags, term) => {
        const [key, jsonString] = term.split(':');
        const value = JSON.parse(jsonString);
        tags[key] = value;
        return tags;
    }, {});
}

function parseTypeDefinitions(protoJson) {
    const types = {};
    // Note: The output of the Protocol Buffer compiler likes to use singular
    // field names for arrays, but only some of the time. Smells like XSD.
    for (const protoFile of protoJson.protoFile) {
        const package = protoFile.package;
        for (const type of protoFile.messageType) {
            // fully qualified type name
            const typeName = `.${package}.${type.name}`;
            const typeDefinition = {fields: []};
            // Each message type has an array of fields, but first let's get
            // the definitions of any map<> types referenced by this type.
            for (const mapType of type.nestedType || []) {
                if (!mapType.options || !mapType.options.mapEntry) {
                    continue;
                }
                const mapDefinition = {fields: []};
                // A map type has two fields: key and value.
                // Key is always a string or an integral type.
                // Value might be a message type.
                for (const field of mapType.field) {
                    if (field.name === 'key') {
                        mapDefinition.keyType = field.type;
                    } else {
                        enforce(() => field.name === 'value', () => `bogus map<...> field.name: ${field.name}`);
                        mapDefinition.valueType = field.type;
                        if (field.typeName) {
                            // Value is a message, and `typeName` is the fully
                            // qualified name of the type.
                            mapDefinition.valueTypeName = field.typeName;
                        }
                    }
                }
                const mapName = `${typeName}.${mapType.name}`;
                types[mapName] = {name: mapName, map: mapDefinition};
            }

            // Now the type's fields.
            for (const field of type.field || []) {
                // Aside from copying over the `name`, `type`, and `typeName`
                // (if present) properties, we also need to parse
                // `location.leadingComments` for text of the form
                // '@gotags: ... msg:"foo" ...'.
                // This library is designed for use with a Go-based
                // MessagePack->struct mapper, and that mapper allows for
                // fields to be renamed using such comments in the .proto file.
                const fieldDefinition = {
                    name: field.name,
                    type: field.type
                };
                if (field.typeName) {
                    fieldDefinition.typeName = field.typeName
                }
                const gotagsMsgName = parseGotags(field.location.leadingComments || '').msg;
                fieldDefinition.msgpackName = gotagsMsgName || field.name;
                
                typeDefinition.fields.push(fieldDefinition);
            }

            types[typeName] = {name: typeName, message: typeDefinition};
        }
    }

    return types;
}

function protoToMessagePackTisch({protoFiles, messageType}) {
    // TODO:
    // ✅ run protojson
    // ✅ create a mapping of types, including map<> types and @gotags names. 
    // ✅ if messageType is undefined, then get the messageType from 
    //   last(topologicallySorted(...)).
    // - build up schemas = {[proto type name]: schema function}
    // - return schemas[messageType]
    
    const protoJson = invokeProtocJson({protoFiles});
    const types = parseTypeDefinitions(protoJson);

    if (messageType === undefined) {
        const root = last(topologicallySorted({nodes: Object.values(types), getChildren: function* (typeDefinition) {
            if (typeDefinition.map) {
                // The value in (key, value) might be a message type.
                const map = typeDefinition;
                if (map.valueTypeName) {
                    yield types[map.valueTypeName];
                }
                return;
            }

            // We're a message type. Return any of our fields whose types have
            // names.
            for (const field of typeDefinition.message.fields) {
                if (field.typeName) {
                    yield types[field.typeName];
                }
            }
        }}));
        messageType = root.name;
    }

    // TODO
    return {
        types, messageType
    };
}

function last(iterator, fallback) {
    let current = fallback;
    for (const element of iterator) {
        current = element;
    }
    return current;
}

function* topologicallySorted({nodes, getChildren}) {
    const visited = new WeakSet();

    function* visit(node) {
        if (visited.has(node)) {
            return;
        }
        visited.add(node);
        for (const child of getChildren(node)) {
            yield* visit(child);
        }
        yield node;
    }
    
    for (const node of nodes) {
        yield* visit(node);
    }
}

module.exports = {
    protoToMessagePackTisch
};
