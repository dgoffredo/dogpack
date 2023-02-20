[dependencies/](dependencies/) contains git submodules that are the runtime
dependencies of this tool. Run the following command to make sure they're
cloned:
```console
$ git submodule update --init --recursive
```

[dependencies/protojson](dependencies/protojson) depends on the Protocol Buffer
compiler, `protoc`. This you install as a system-level command line tool, e.g.
```console
sudo apt install protobuf-compiler
```
The requirement is that `protoc` be available in the `PATH`.

protojson also depends on Python 3.

[dependencies/massagepack](dependencies/massagepack) depends on the NPM module
"msgpack-lite". Once you've installed `npm`, you can install msgpack-lite via:
```console
npm install msgpack-lite
```

This project is a Node.js library used to implement two command line tools:

- `./validate-msgpack [--message <type>] <proto> ...`
  - Parses a specified Protocol Buffer schema files (`.proto` files), and then
    reads MessagePack formatted data from standard input.
  - If the input matches the schema, then the tool exits with status zero
    without producing any output.
  - If the input does not match the schema, then the tool prints a diagnostic
    to standard error and exits with a nonzero status.
  - Optionally specify the name of a Protocol Buffer message `<type>` against
    which the input will be validated. If `<type>` is not specified, then the
    topologically "highest" message type will be used, i.e. the message type
    having the largest number of message type descendants.

- `./validate-dogpack [--message <type>] <proto> ...`
  - Behaves like `validate-msgpack`, except that the input MessagePack is
    expected to be in the "compact" format, where strings are replaced by
    integer offsets into a string table, and messages are represented as
    keyless arrays instead of as maps. The shape of such messages, as expressed
    in [tisch][1], will be:
    - `[[String, String, ...etc], [field_1_schema, field_2_schema, Any, ...etc]]`
    - where the array of strings is the string table, and the array of schemas
      are the schemas for the fields of the message (in this example, the
      message has two fields).

[1]: https://github.com/dgoffredo/tisch
