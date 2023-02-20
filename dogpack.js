const child_process = require('child_process');
const path = require('path');
const mpack = require('./dependencies/massagepack/massagepack.js');
const tisch = require('./dependencies/tisch/tisch.js');


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
                // `label: "LABEL_REPEATED"` could mean that it's a
                // `repeated` field (i.e. an array), but it also could be a
                // `map<...>`, because maps are just syntactic sugar for
                // `repeated` key/value messages.
                // So, we detect the latter case by seeing whether the field
                // type name begins with the type name. That means its a nested
                // type, which maps are.
                // Non-map nested types I we won't worry about.
                if (field.label === 'LABEL_REPEATED' && !(field.typeName || '').startsWith(`${typeName}.`)) {
                    fieldDefinition.isArray = true;
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

function deduceRootType(types) {
    // Deduce the "root type name" by topologically sorting the type
    // definitions. Assign the resulting name to `messageType`.
    return last(topologicallySorted({nodes: Object.values(types), getChildren: function* (typeDefinition) {
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
}

// TODO: Add `Buffer` support to tisch.
function primitiveTypeToMessagePackTisch(type) {
    return ({
        TYPE_DOUBLE: () => Number,
        TYPE_FLOAT: () => Number,
        TYPE_INT64: ({Integer}) => Integer,
        TYPE_UINT64:({Integer}) => Integer,
        TYPE_INT32: ({Integer}) => Integer,
        TYPE_FIXED64: ({Integer}) => Integer,
        TYPE_FIXED32: ({Integer}) => Integer,
        TYPE_BOOL: () => Boolean,
        TYPE_STRING: () => String,
        TYPE_BYTES: () => Buffer,
        TYPE_UINT32: ({Integer}) => Integer,
        TYPE_SFIXED32: ({Integer}) => Integer,
        TYPE_SFIXED64: ({Integer}) => Integer,
        TYPE_SINT32: ({Integer}) => Integer,
        TYPE_SINT64: ({Integer}) => Integer,
    }[type]);
}

// TODO: Add `Buffer` support to tisch.
// It's like `primitiveTypeToMessagePackTisch`, except that strings map to
// integers (so that they're offsets into the string table).
function primitiveTypeToDogPackTisch(type) {
    return ({
        TYPE_DOUBLE: () => Number,
        TYPE_FLOAT: () => Number,
        TYPE_INT64: ({Integer}) => Integer,
        TYPE_UINT64:({Integer}) => Integer,
        TYPE_INT32: ({Integer}) => Integer,
        TYPE_FIXED64: ({Integer}) => Integer,
        TYPE_FIXED32: ({Integer}) => Integer,
        TYPE_BOOL: () => Boolean,
        TYPE_STRING: ({Integer}) => Integer,
        TYPE_BYTES: () => Buffer,
        TYPE_UINT32: ({Integer}) => Integer,
        TYPE_SFIXED32: ({Integer}) => Integer,
        TYPE_SFIXED64: ({Integer}) => Integer,
        TYPE_SINT32: ({Integer}) => Integer,
        TYPE_SINT64: ({Integer}) => Integer,
    }[type]);
}

function mapTypeToMessagePackTisch({type, getSchemaFunction}) {
    return function ({etc, map}) {
        let valueSchemaFunction;
        if (type.map.valueTypeName) {
            valueSchemaFunction = getSchemaFunction(type.map.valueTypeName);
        } else {
            valueSchemaFunction = primitiveTypeToMessagePackTisch(type.map.valueType);
        }
        const keySchemaFunction = primitiveTypeToMessagePackTisch(type.map.keyType);

        const keySchema = keySchemaFunction(...arguments);
        const valueSchema = valueSchemaFunction(...arguments);
        return map([keySchema, valueSchema], ...etc);
    };
}

function mapTypeToDogPackTisch({type, getSchemaFunction}) {
    return function ({etc, map}) {
        let valueSchemaFunction;
        if (type.map.valueTypeName) {
            valueSchemaFunction = getSchemaFunction(type.map.valueTypeName);
        } else {
            valueSchemaFunction = primitiveTypeToDogPackTisch(type.map.valueType);
        }
        const keySchemaFunction = primitiveTypeToDogPackTisch(type.map.keyType);

        const keySchema = keySchemaFunction(...arguments);
        const valueSchema = valueSchemaFunction(...arguments);
        return map([keySchema, valueSchema], ...etc);
    };
}

function typeToDogPackTisch({type, getSchemaFunction}) {
    if (typeof type === 'string') {
        return primitiveTypeToDogPackTisch(type);
    }

    if (type.map) {
        return mapTypeToDogPackTisch({type, getSchemaFunction});
    }

    // It's a message.
    const message = type.message;
    return function ({Any, etc}) {
        return [...message.fields.map(field => {
                let valueSchemaFunction;
                if (field.typeName) {
                    valueSchemaFunction = getSchemaFunction(field.typeName);
                } else {
                    valueSchemaFunction = primitiveTypeToDogPackTisch(field.type);
                }
                const valueSchema = valueSchemaFunction(...arguments);
                if (field.isArray) {
                    return [valueSchema, ...etc];
                }
                return valueSchema;
            }),
            Any, ...etc];
    };
}

function typeToMessagePackTisch({type, getSchemaFunction}) {
    if (typeof type === 'string') {
        return primitiveTypeToMessagePackTisch(type);
    }

    if (type.map) {
        return mapTypeToMessagePackTisch({type, getSchemaFunction});
    }

    // It's a message.
    const message = type.message;
    return function ({etc}) {
        return {
            ...Object.fromEntries(message.fields.map(field => {
                let valueSchemaFunction;
                if (field.typeName) {
                    valueSchemaFunction = getSchemaFunction(field.typeName);
                } else {
                    valueSchemaFunction = primitiveTypeToMessagePackTisch(field.type);
                }
                // The question mark means "optional" in tisch. Every field is
                // optional in proto3.
                const keySchema = `${field.msgpackName}?`;
                const valueSchema = valueSchemaFunction(...arguments);
                if (field.isArray) {
                    return [keySchema, [valueSchema, ...etc]];
                }
                return [keySchema, valueSchema];
            })),
            ...etc
        };
    };
}

// TODO: Cyclic dependencies will shatter this function. That's fine for now.
// `types` is `{[type name]: type definition}`.
// `typeToTisch` is a function that converts a type definition into a tisch
// schema. It's a parameter because there are two versions: one for MessagePack
// and one for DogPack (which is a subset of MessagePack).
function typesToTisch({types, typeToTisch}) {
    // {[type name]: type definition}  ->  {[type name]: tisch schema function}
    const schemaFunctions = {};

    function getSchemaFunction(typeName) {
        const already = schemaFunctions[typeName];
        if (already !== undefined) {
            return already;
        }

        const schemaFunction = typeToTisch({type: types[typeName], getSchemaFunction});
        schemaFunctions[typeName] = schemaFunction;
        return schemaFunction;
    }

    Object.keys(types).forEach(key => schemaFunctions[key] = getSchemaFunction(key));
    return schemaFunctions;
}

function protoToMessagePackTisch({protoFiles, messageType}) {
    const protoJson = invokeProtocJson({protoFiles});
    const types = parseTypeDefinitions(protoJson);

    if (messageType === undefined) {
        messageType = deduceRootType(types).name;
    }

    const tischFunctions = typesToTisch({types, typeToTisch: typeToMessagePackTisch});
    return tischFunctions[messageType];
}

function protoToDogPackTisch({protoFiles, messageType, options}) {
    const protoJson = invokeProtocJson({protoFiles});
    const types = parseTypeDefinitions(protoJson);

    if (messageType === undefined) {
        messageType = deduceRootType(types).name;
    }

    const tischFunctions = typesToTisch({types, typeToTisch: typeToDogPackTisch});
    
    if (options && options.omitStringTable) {
        return function () {
            return tischFunctions[messageType](...arguments);
        };
    }

    return function ({etc}) {
        return [
            [String, String, ...etc],
            tischFunctions[messageType](...arguments)
        ];
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

function validate(msgpackMessage, tischValidate) {
    const jsMessage = mpack.decode(msgpackMessage, {usemap: true});
    if (tischValidate(jsMessage)) {
        return {match: jsMessage};
    }
    return {errors: tischValidate.errors};
}

function protoToValidator({protoFiles, messageType, options, protoToTisch}) {
    const schema = protoToTisch({protoFiles, messageType, options});
    const validateJs = tisch.compileFunction(schema);
    const validator = function (msgpackMessage) {
        return validate(msgpackMessage, validateJs);
    };
    validator.schema = schema;
    return validator;
}

function protoToMessagePackValidator({protoFiles, messageType, options}) {
    return protoToValidator({protoFiles, messageType, options, protoToTisch: protoToMessagePackTisch});
}

function protoToDogPackValidator({protoFiles, messageType, options}) {
    return protoToValidator({protoFiles, messageType, options, protoToTisch: protoToDogPackTisch});
}

module.exports = {
    protoToMessagePackTisch,
    protoToDogPackTisch,
    protoToMessagePackValidator,
    protoToDogPackValidator,
};
