# Supported Languages

Extraction depth varies by runtime. The CLI agent has a dedicated Java
extractor, while the browser indexer currently uses structural extraction for
Java.

## Full Extraction (symbols + calls + imports)

| Language | Runtime | Symbols | Call Relationships | Imports |
|----------|---------|---------|-------------------|---------|
| Python | CLI agent and browser indexer | Yes | Yes | Yes |
| TypeScript | CLI agent and browser indexer | Yes | Yes | Yes |
| JavaScript | CLI agent and browser indexer | Yes | Yes | Yes |
| Go | CLI agent and browser indexer | Yes | Yes | Yes |
| Java | CLI agent | Yes | Yes | Yes |

## Structural Extraction (symbols only)

| Language | Runtime | Symbols |
|----------|---------|---------|
| Rust | Browser indexer | Yes |
| Java | Browser indexer | Yes |
| Kotlin | Browser indexer | Yes |
| C# | Browser indexer | Yes |
| C/C++ | Browser indexer | Yes |
| Ruby | Browser indexer | Yes |
| Swift | Browser indexer | Yes |

## Config & Data Files

The following file types are indexed as file nodes (no symbol extraction):

JSON, YAML, TOML, Protobuf, SQL, GraphQL, Bash
