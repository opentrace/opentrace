/**
 * Template-based code summarizer — generates semantic summaries from identifier
 * names and structural metadata, with no ML inference.
 *
 * Function/class names are already semantic (`toCamelCase`, `validateEmail`).
 * A name analyzer that splits identifiers and maps verb prefixes to descriptions
 * produces quality summaries instantly — <100ms for 10k nodes.
 */

import type { Summarizer, NodeKind, SymbolMetadata } from './types';

// ---------------------------------------------------------------------------
// Verb prefix → description mapping
// ---------------------------------------------------------------------------

const VERB_MAP: Record<string, string> = {
  get: 'Retrieves',
  fetch: 'Retrieves',
  load: 'Retrieves',
  find: 'Retrieves',
  query: 'Retrieves',
  read: 'Reads',
  lookup: 'Looks up',
  set: 'Updates',
  update: 'Updates',
  modify: 'Updates',
  patch: 'Updates',
  put: 'Updates',
  validate: 'Validates',
  verify: 'Validates',
  check: 'Validates',
  ensure: 'Ensures',
  create: 'Creates',
  make: 'Creates',
  build: 'Creates',
  generate: 'Creates',
  new: 'Creates',
  add: 'Adds',
  insert: 'Adds',
  append: 'Adds',
  register: 'Registers',
  delete: 'Removes',
  remove: 'Removes',
  destroy: 'Removes',
  drop: 'Removes',
  unset: 'Removes',
  clear: 'Clears',
  parse: 'Parses',
  extract: 'Extracts',
  decode: 'Decodes',
  handle: 'Handles',
  process: 'Processes',
  run: 'Runs',
  execute: 'Executes',
  do: 'Performs',
  perform: 'Performs',
  convert: 'Converts',
  transform: 'Converts',
  to: 'Converts to',
  format: 'Formats',
  encode: 'Encodes',
  serialize: 'Serializes',
  marshal: 'Serializes',
  deserialize: 'Deserializes',
  unmarshal: 'Deserializes',
  is: 'Checks whether',
  has: 'Checks whether',
  can: 'Checks whether',
  should: 'Checks whether',
  init: 'Initializes',
  setup: 'Initializes',
  configure: 'Configures',
  start: 'Starts',
  stop: 'Stops',
  open: 'Opens',
  close: 'Closes',
  connect: 'Connects',
  disconnect: 'Disconnects',
  render: 'Renders',
  display: 'Renders',
  show: 'Renders',
  draw: 'Renders',
  paint: 'Renders',
  hide: 'Hides',
  send: 'Sends',
  emit: 'Emits',
  dispatch: 'Dispatches',
  publish: 'Publishes',
  broadcast: 'Broadcasts',
  notify: 'Notifies',
  receive: 'Receives',
  listen: 'Listens for',
  subscribe: 'Subscribes to',
  on: 'Handles',
  sort: 'Sorts',
  filter: 'Filters',
  map: 'Maps',
  reduce: 'Reduces',
  merge: 'Merges',
  join: 'Joins',
  split: 'Splits',
  group: 'Groups',
  flatten: 'Flattens',
  test: 'Tests',
  assert: 'Tests',
  expect: 'Tests',
  log: 'Logs',
  print: 'Logs',
  warn: 'Logs warning for',
  error: 'Logs error for',
  debug: 'Logs debug info for',
  write: 'Writes',
  save: 'Saves',
  store: 'Stores',
  cache: 'Caches',
  flush: 'Flushes',
  sync: 'Synchronizes',
  reset: 'Resets',
  refresh: 'Refreshes',
  reload: 'Reloads',
  retry: 'Retries',
  wrap: 'Wraps',
  unwrap: 'Unwraps',
  apply: 'Applies',
  resolve: 'Resolves',
  reject: 'Rejects',
  throw: 'Throws',
  raise: 'Raises',
  try: 'Attempts',
  await: 'Awaits',
  wait: 'Waits for',
  schedule: 'Schedules',
  defer: 'Defers',
  cancel: 'Cancels',
  abort: 'Aborts',
  clone: 'Clones',
  copy: 'Copies',
  compare: 'Compares',
  equals: 'Checks equality of',
  match: 'Matches',
  contains: 'Checks whether contains',
  include: 'Includes',
  exclude: 'Excludes',
  enable: 'Enables',
  disable: 'Disables',
  toggle: 'Toggles',
  mount: 'Mounts',
  unmount: 'Unmounts',
  use: 'Uses',
  with: 'Configures with',
  from: 'Creates from',
  of: 'Creates',
};

// ---------------------------------------------------------------------------
// Class suffix patterns
// ---------------------------------------------------------------------------

const CLASS_SUFFIX_MAP: Record<string, string> = {
  service: 'Service',
  handler: 'Handler',
  controller: 'Controller',
  factory: 'Factory',
  repository: 'Repository',
  repo: 'Repository',
  manager: 'Manager',
  provider: 'Provider',
  adapter: 'Adapter',
  middleware: 'Middleware',
  guard: 'Guard',
  interceptor: 'Interceptor',
  resolver: 'Resolver',
  validator: 'Validator',
  builder: 'Builder',
  parser: 'Parser',
  formatter: 'Formatter',
  converter: 'Converter',
  serializer: 'Serializer',
  client: 'Client',
  server: 'Server',
  router: 'Router',
  store: 'Store',
  cache: 'Cache',
  queue: 'Queue',
  pool: 'Pool',
  registry: 'Registry',
  observer: 'Observer',
  emitter: 'Emitter',
  listener: 'Listener',
  subscriber: 'Subscriber',
  publisher: 'Publisher',
  component: 'Component',
  module: 'Module',
  plugin: 'Plugin',
  helper: 'Helper',
  util: 'Utility',
  utils: 'Utility',
  error: 'Error',
  exception: 'Exception',
  model: 'Model',
  entity: 'Entity',
  dto: 'DTO',
  config: 'Configuration',
  options: 'Options',
  context: 'Context',
  state: 'State',
  hook: 'Hook',
};

// ---------------------------------------------------------------------------
// File/directory pattern maps
// ---------------------------------------------------------------------------

const FILE_PATTERNS: Array<[RegExp, string]> = [
  [/_test\.go$/, 'Tests for'],
  [/_test\.py$/, 'Tests for'],
  [/\.test\.[jt]sx?$/, 'Tests for'],
  [/\.spec\.[jt]sx?$/, 'Tests for'],
  [/^test_/, 'Tests for'],
  [/^conftest\.py$/, 'Pytest fixtures and configuration'],
  [/^setup\.[jt]s$/, 'Setup configuration'],
  [/^index\.[jt]sx?$/, 'Barrel exports for'],
  [/^main\.[a-z]+$/, 'Application entry point'],
  [/^mod\.rs$/, 'Module declarations'],
  [/^__init__\.py$/, 'Package initialization for'],
  [/^constants?\.[a-z]+$/, 'Constants and configuration values'],
  [/^types?\.[a-z]+$/, 'Type definitions'],
  [/^utils?\.[a-z]+$/, 'Utility functions'],
  [/^helpers?\.[a-z]+$/, 'Helper functions'],
  [/^middleware\.[a-z]+$/, 'Middleware definitions'],
  [/^routes?\.[a-z]+$/, 'Route definitions'],
  [/^models?\.[a-z]+$/, 'Data model definitions'],
  [/^schema\.[a-z]+$/, 'Schema definitions'],
  [/^migrations?/, 'Database migration'],
  [/^dockerfile/i, 'Docker container configuration'],
  [/^makefile$/i, 'Build automation rules'],
  [/^readme/i, 'Project documentation'],
  [/^changelog/i, 'Version change history'],
  [/^license/i, 'License information'],
  [/\.config\.[a-z]+$/, 'Configuration for'],
  [/rc\.[a-z]+$/, 'Configuration for'],
];

const DIR_PATTERNS: Record<string, string> = {
  api: 'API layer',
  apis: 'API layer',
  handlers: 'Request handlers',
  handler: 'Request handlers',
  controllers: 'Request controllers',
  controller: 'Request controllers',
  routes: 'Route definitions',
  routing: 'Route definitions',
  models: 'Data models',
  model: 'Data models',
  entities: 'Data entities',
  schema: 'Schema definitions',
  schemas: 'Schema definitions',
  services: 'Service layer',
  service: 'Service layer',
  middleware: 'Middleware',
  middlewares: 'Middleware',
  utils: 'Utility functions',
  util: 'Utility functions',
  helpers: 'Helper functions',
  helper: 'Helper functions',
  lib: 'Library modules',
  libs: 'Library modules',
  pkg: 'Package modules',
  internal: 'Internal packages',
  cmd: 'Command entry points',
  config: 'Configuration',
  configs: 'Configuration',
  tests: 'Test suite',
  test: 'Test suite',
  __tests__: 'Test suite',
  spec: 'Test specifications',
  specs: 'Test specifications',
  fixtures: 'Test fixtures',
  mocks: 'Test mocks',
  components: 'UI components',
  component: 'UI components',
  pages: 'Page components',
  views: 'View components',
  layouts: 'Layout components',
  hooks: 'React hooks',
  store: 'State management',
  stores: 'State management',
  state: 'State management',
  reducers: 'State reducers',
  actions: 'State actions',
  selectors: 'State selectors',
  types: 'Type definitions',
  interfaces: 'Interface definitions',
  constants: 'Constants',
  static: 'Static assets',
  assets: 'Static assets',
  public: 'Public assets',
  styles: 'Stylesheets',
  css: 'Stylesheets',
  docs: 'Documentation',
  doc: 'Documentation',
  scripts: 'Build and utility scripts',
  migrations: 'Database migrations',
  seeds: 'Database seed data',
  templates: 'Templates',
  i18n: 'Internationalization',
  locales: 'Locale translations',
  proto: 'Protocol buffer definitions',
  generated: 'Generated code',
  gen: 'Generated code',
  dist: 'Build output',
  build: 'Build output',
  vendor: 'Vendored dependencies',
  node_modules: 'NPM dependencies',
  bin: 'Executable binaries',
  examples: 'Usage examples',
  example: 'Usage examples',
  plugins: 'Plugin modules',
  extensions: 'Extension modules',
  auth: 'Authentication and authorization',
  security: 'Security modules',
  crypto: 'Cryptographic utilities',
  db: 'Database layer',
  database: 'Database layer',
  cache: 'Caching layer',
  queue: 'Message queue handlers',
  workers: 'Background workers',
  jobs: 'Background jobs',
  tasks: 'Task definitions',
  events: 'Event handlers',
  subscribers: 'Event subscribers',
  publishers: 'Event publishers',
  adapters: 'Adapter implementations',
  providers: 'Service providers',
  repositories: 'Data repositories',
  repository: 'Data repositories',
  clients: 'External API clients',
  sdk: 'SDK modules',
  common: 'Shared common modules',
  shared: 'Shared modules',
  core: 'Core modules',
  base: 'Base classes and interfaces',
  errors: 'Error definitions',
  exceptions: 'Exception definitions',
  validators: 'Input validators',
  validation: 'Validation logic',
  serializers: 'Data serializers',
  parsers: 'Data parsers',
  formatters: 'Data formatters',
  converters: 'Data converters',
  transformers: 'Data transformers',
  mappers: 'Data mappers',
  resolvers: 'GraphQL resolvers',
  guards: 'Route guards',
  interceptors: 'Request interceptors',
  decorators: 'Decorators',
  annotations: 'Annotations',
  factories: 'Factory functions',
  builders: 'Builder patterns',
  observers: 'Observer implementations',
  strategies: 'Strategy pattern implementations',
  commands: 'Command implementations',
  queries: 'Query implementations',
  notifications: 'Notification handlers',
  mailers: 'Email sending',
  logging: 'Logging configuration',
  monitoring: 'Monitoring and metrics',
  metrics: 'Application metrics',
  tracing: 'Distributed tracing',
  indexer: 'Indexing pipeline',
  graph: 'Graph data structures',
  summarizer: 'Summarization modules',
  embedder: 'Embedding modules',
  extractors: 'Data extractors',
};

// ---------------------------------------------------------------------------
// Keyword extraction patterns
// ---------------------------------------------------------------------------

interface KeywordPattern {
  domain: string;
  patterns: RegExp[];
}

const KEYWORD_PATTERNS: KeywordPattern[] = [
  {
    domain: 'database',
    patterns: [
      /\bsql\b/i,
      /\bquery\b/i,
      /\bSELECT\b/,
      /\bINSERT\b/,
      /\bUPDATE\b.*\bSET\b/,
      /\bdb\./i,
      /\bcursor\b/i,
      /\bconnection\b/i,
      /\bprisma\b/i,
      /\bknex\b/i,
      /\bsequelize\b/i,
      /\bmongoose\b/i,
      /\bsqlx\b/i,
      /\borm\b/i,
      /\bmigration\b/i,
      /\bschema\b/i,
      /\btable\b/i,
      /\btransaction\b/i,
      /\bcolumn\b/i,
    ],
  },
  {
    domain: 'auth',
    patterns: [
      /\bauth\b/i,
      /\bjwt\b/i,
      /\btoken\b/i,
      /\bpassword\b/i,
      /\blogin\b/i,
      /\bsession\b/i,
      /\boauth\b/i,
      /\bbcrypt\b/i,
      /\bcredential\b/i,
      /\bpermission\b/i,
      /\brole\b/i,
      /\bacl\b/i,
      /\bsignin\b/i,
      /\bsignup\b/i,
    ],
  },
  {
    domain: 'http',
    patterns: [
      /\bhttp\b/i,
      /\brequest\b/i,
      /\bresponse\b/i,
      /\bfetch\s*\(/i,
      /\baxios\b/i,
      /\bhandler\b/i,
      /\bmiddleware\b/i,
      /\bcors\b/i,
      /\bendpoint\b/i,
      /\broute\b/i,
      /\bREST\b/i,
      /\bgraphql\b/i,
      /\bheader\b/i,
    ],
  },
  {
    domain: 'filesystem',
    patterns: [
      /\bfs\./i,
      /\breadFile\b/i,
      /\bwriteFile\b/i,
      /\bpath\./i,
      /\bstream\b/i,
      /\bbuffer\b/i,
      /\bmkdir\b/i,
      /\bunlink\b/i,
      /\bglob\b/i,
    ],
  },
  {
    domain: 'crypto',
    patterns: [
      /\bcrypto\b/i,
      /\bencrypt\b/i,
      /\bdecrypt\b/i,
      /\bhash\b/i,
      /\bsign\b/i,
      /\bverify\b/i,
      /\bcipher\b/i,
      /\bhmac\b/i,
    ],
  },
  {
    domain: 'cache',
    patterns: [
      /\bcache\b/i,
      /\bredis\b/i,
      /\bmemcached\b/i,
      /\bttl\b/i,
      /\binvalidate\b/i,
      /\bLRU\b/i,
    ],
  },
  {
    domain: 'queue',
    patterns: [
      /\bqueue\b/i,
      /\bworker\b/i,
      /\bjob\b/i,
      /\bpublish\b/i,
      /\bsubscribe\b/i,
      /\bkafka\b/i,
      /\brabbitmq\b/i,
      /\bamqp\b/i,
    ],
  },
  {
    domain: 'config',
    patterns: [
      /\bconfig\b/i,
      /\benv\b/i,
      /\bsettings\b/i,
      /\byaml\b/i,
      /\bdotenv\b/i,
      /\.env\b/i,
    ],
  },
  {
    domain: 'logging',
    patterns: [
      /\blogger\b/i,
      /\bwinston\b/i,
      /\bpino\b/i,
      /\blogrus\b/i,
      /\bslog\b/i,
      /\blog\./i,
    ],
  },
  {
    domain: 'testing',
    patterns: [
      /\btest\b/i,
      /\bassert\b/i,
      /\bexpect\b/i,
      /\bmock\b/i,
      /\bstub\b/i,
      /\bspy\b/i,
      /\bfixture\b/i,
      /\bjest\b/i,
      /\bpytest\b/i,
    ],
  },
  {
    domain: 'async',
    patterns: [
      /\basync\b/i,
      /\bawait\b/i,
      /\bPromise\b/,
      /\bgoroutine\b/i,
      /\bchannel\b/i,
      /\bconcurrent\b/i,
      /\bparallel\b/i,
      /\bmutex\b/i,
    ],
  },
  {
    domain: 'error',
    patterns: [
      /\btry\b/,
      /\bcatch\b/,
      /\bthrow\b/,
      /\bError\b/,
      /\bpanic\b/i,
      /\brecover\b/i,
      /\berrno\b/i,
    ],
  },
  {
    domain: 'validation',
    patterns: [
      /\bvalidate\b/i,
      /\bsanitize\b/i,
      /\bzod\b/i,
      /\byup\b/i,
      /\bjoi\b/i,
      /\bregexp\b/i,
      /\bregex\b/i,
    ],
  },
  {
    domain: 'websocket',
    patterns: [
      /\bwebsocket\b/i,
      /\bws\./i,
      /\bsocket\b/i,
      /\bWebSocket\b/,
      /\bemit\s*\(/i,
    ],
  },
  {
    domain: 'email',
    patterns: [/\bemail\b/i, /\bsmtp\b/i, /\bsendmail\b/i, /\bmailer\b/i],
  },
];

// ---------------------------------------------------------------------------
// Identifier splitter
// ---------------------------------------------------------------------------

/**
 * Split an identifier into words, handling camelCase, PascalCase, snake_case,
 * SCREAMING_SNAKE_CASE, and acronyms (e.g. parseHTTPResponse → ["parse", "HTTP", "response"]).
 */
export function splitIdentifier(name: string): string[] {
  // Strip common prefixes/suffixes
  let cleaned = name.replace(/^[_$]+/, '').replace(/[_$]+$/, '');

  if (!cleaned) return [name];

  // Split on underscores/hyphens first
  const parts = cleaned.split(/[_\-]+/).filter(Boolean);

  const words: string[] = [];
  for (const part of parts) {
    // Split camelCase/PascalCase with acronym awareness
    const subWords = part
      // Insert boundary between lowercase→uppercase: "camelCase" → "camel Case"
      .replace(/([a-z])([A-Z])/g, '$1\0$2')
      // Insert boundary between acronym→word: "HTTPResponse" → "HTTP Response"
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2')
      // Insert boundary between digit→letter and letter→digit
      .replace(/([a-zA-Z])(\d)/g, '$1\0$2')
      .replace(/(\d)([a-zA-Z])/g, '$1\0$2')
      .split('\0')
      .filter(Boolean);

    words.push(...subWords);
  }

  return words.length > 0 ? words : [name];
}

/**
 * Convert word list to a readable object phrase: ["user", "by", "id"] → "user by ID".
 * Short all-caps words (2-4 letters) stay uppercase; everything else lowercased.
 */
function wordsToPhrase(words: string[]): string {
  return words
    .map((w) => {
      if (w.length <= 4 && w === w.toUpperCase() && /^[A-Z]+$/.test(w))
        return w;
      return w.toLowerCase();
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/** Scan source code for domain indicators and return deduplicated keywords (max 4). */
export function extractKeywords(source: string): string[] {
  if (!source) return [];

  const found: string[] = [];
  for (const kp of KEYWORD_PATTERNS) {
    if (found.length >= 4) break;
    for (const pat of kp.patterns) {
      if (pat.test(source)) {
        found.push(kp.domain);
        break; // one match per domain is enough
      }
    }
  }

  return found;
}

/** Format keywords suffix: ["database", "async"] → " [database, async]" */
function formatKeywords(keywords: string[]): string {
  return keywords.length > 0 ? ` [${keywords.join(', ')}]` : '';
}

// ---------------------------------------------------------------------------
// Function summarizer
// ---------------------------------------------------------------------------

const CONSTRUCTOR_NAMES = new Set([
  '__init__',
  'constructor',
  'init',
  'initialize',
  'New',
]);

/** Check if a name is non-descriptive (single letter, too short, or generic). */
function isNonDescriptive(name: string): boolean {
  if (name.length <= 2) return true;
  const lower = name.toLowerCase();
  return [
    'foo',
    'bar',
    'baz',
    'tmp',
    'temp',
    'x',
    'y',
    'z',
    'fn',
    'cb',
    'f',
    'g',
  ].includes(lower);
}

export function summarizeFunction(
  name: string,
  _signature?: string,
  _language?: string,
  _lineCount?: number,
  receiverType?: string,
  source?: string,
): string {
  // Handle constructors
  if (CONSTRUCTOR_NAMES.has(name)) {
    const subject = receiverType || 'instance';
    return `Initializes ${subject}`;
  }

  // Handle test functions
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith('test_') || lowerName.startsWith('test')) {
    const words = splitIdentifier(name);
    const testWords =
      words[0].toLowerCase() === 'test' ? words.slice(1) : words;
    if (testWords.length > 0) {
      return `Tests ${wordsToPhrase(testWords)}`;
    }
    return `Tests ${name}`;
  }

  // Handle non-descriptive names
  if (isNonDescriptive(name)) {
    return `Function ${name}`;
  }

  const words = splitIdentifier(name);
  if (words.length === 0) return `Function ${name}`;

  const firstWord = words[0].toLowerCase();
  const restWords = words.slice(1);

  // Look up verb prefix
  const verb = VERB_MAP[firstWord];
  if (verb) {
    const object = restWords.length > 0 ? ` ${wordsToPhrase(restWords)}` : '';

    let prefix = '';
    if (receiverType) {
      prefix = `${receiverType} method that `;
      // Use lowercase verb for the "method that <verbs>" form
      const lowerVerb = verb.toLowerCase();
      const result = `${prefix}${lowerVerb}${object}`;
      const keywords = source ? extractKeywords(source) : [];
      return result + formatKeywords(keywords);
    }

    const result = `${verb}${object}`;
    const keywords = source ? extractKeywords(source) : [];
    return result + formatKeywords(keywords);
  }

  // No known verb — describe as noun phrase
  const phrase = wordsToPhrase(words);
  let result: string;

  if (receiverType) {
    result = `${receiverType} method for ${phrase}`;
  } else {
    // Capitalize first letter
    result = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  }

  const keywords = source ? extractKeywords(source) : [];
  return result + formatKeywords(keywords);
}

// ---------------------------------------------------------------------------
// Class summarizer
// ---------------------------------------------------------------------------

const CRUD_METHODS = new Set([
  'create',
  'read',
  'get',
  'find',
  'update',
  'delete',
  'remove',
  'save',
  'list',
]);

export function summarizeClass(
  name: string,
  childNames?: string[],
  source?: string,
): string {
  const words = splitIdentifier(name);
  const readableName = wordsToPhrase(words);
  const capitalizedName =
    readableName.charAt(0).toUpperCase() + readableName.slice(1);

  // Detect class suffix pattern
  const lastWord = words[words.length - 1].toLowerCase();
  const suffixLabel = CLASS_SUFFIX_MAP[lastWord];

  // Detect CRUD pattern
  let hasCrud = false;
  if (childNames && childNames.length > 0) {
    const lowerChildren = childNames.map((c) =>
      splitIdentifier(c)[0].toLowerCase(),
    );
    const crudCount = lowerChildren.filter((c) => CRUD_METHODS.has(c)).length;
    hasCrud = crudCount >= 3;
  }

  let summary = capitalizedName;

  if (hasCrud) {
    summary += ' for CRUD operations';
  } else if (suffixLabel) {
    // Only add if the suffix isn't already the full name
    if (words.length > 1) {
      // The name already describes what it is, just format it nicely
    }
  }

  // List key methods (up to 5)
  if (childNames && childNames.length > 0) {
    const methodList = childNames.slice(0, 5).join(', ');
    const extra =
      childNames.length > 5 ? ` and ${childNames.length - 5} more` : '';
    summary += ` with methods: ${methodList}${extra}`;
  }

  const keywords = source ? extractKeywords(source) : [];
  return summary + formatKeywords(keywords);
}

// ---------------------------------------------------------------------------
// File summarizer
// ---------------------------------------------------------------------------

export function summarizeFile(
  fileName: string,
  symbolNames?: string[],
  language?: string,
  _source?: string,
): string {
  const lowerFile = fileName.toLowerCase();

  // Check known file patterns
  for (const [pattern, prefix] of FILE_PATTERNS) {
    if (pattern.test(lowerFile)) {
      // For "Tests for" and similar, try to derive subject from filename
      if (prefix.endsWith('for')) {
        const baseName = fileName
          .replace(/_test\.\w+$/, '')
          .replace(/\.test\.\w+$/, '')
          .replace(/\.spec\.\w+$/, '')
          .replace(/^test_/, '')
          .replace(/\.\w+$/, '');
        const subject = wordsToPhrase(splitIdentifier(baseName));
        return `${prefix} ${subject}`;
      }
      if (prefix.endsWith('for') || prefix === 'Barrel exports for') {
        // Try to derive context from parent dir (not available here — use symbols)
        if (symbolNames && symbolNames.length > 0) {
          const listing = symbolNames.slice(0, 3).join(', ');
          const extra =
            symbolNames.length > 3 ? ` and ${symbolNames.length - 3} more` : '';
          return `${prefix} ${listing}${extra}`;
        }
      }
      return prefix;
    }
  }

  // Generic file with symbols
  if (symbolNames && symbolNames.length > 0) {
    const listing = symbolNames.slice(0, 3).join(', ');
    const extra =
      symbolNames.length > 3 ? ` and ${symbolNames.length - 3} more` : '';
    const langNote = language ? ` ${language}` : '';
    return `Defines${langNote} ${listing}${extra}`;
  }

  return `Source file ${fileName}`;
}

// ---------------------------------------------------------------------------
// Directory summarizer
// ---------------------------------------------------------------------------

export function summarizeDirectory(
  dirName: string,
  childNames: string[],
): string {
  const lowerDir = dirName.toLowerCase();
  const knownPurpose = DIR_PATTERNS[lowerDir];

  if (knownPurpose) {
    if (childNames.length > 0) {
      const listing = childNames.slice(0, 5).join(', ');
      const extra =
        childNames.length > 5 ? ` and ${childNames.length - 5} more` : '';
      return `${knownPurpose} containing ${listing}${extra}`;
    }
    return knownPurpose;
  }

  // Unknown directory — list contents
  if (childNames.length > 0) {
    const listing = childNames.slice(0, 5).join(', ');
    const extra =
      childNames.length > 5 ? ` and ${childNames.length - 5} more` : '';
    return `Directory containing ${listing}${extra}`;
  }

  return `Directory ${dirName}`;
}

// ---------------------------------------------------------------------------
// Unified summarizer (from structured metadata)
// ---------------------------------------------------------------------------

/** Generate a summary from structured symbol metadata — no source code parsing needed. */
export function summarizeFromMetadata(meta: SymbolMetadata): string {
  switch (meta.kind) {
    case 'function':
      return summarizeFunction(
        meta.name,
        meta.signature,
        meta.language,
        meta.lineCount,
        meta.receiverType,
        meta.source,
      );
    case 'class':
      return summarizeClass(meta.name, meta.childNames, meta.source);
    case 'file':
      return summarizeFile(
        meta.fileName || meta.name,
        meta.childNames,
        meta.language,
        meta.source,
      );
    case 'directory':
      return summarizeDirectory(meta.name, meta.childNames || []);
    default:
      return `${meta.kind} ${meta.name}`;
  }
}

// ---------------------------------------------------------------------------
// Summarizer interface implementation (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Template-based Summarizer that implements the Summarizer interface.
 *
 * Unlike the ML-based FlanT5Summarizer, this runs synchronously (no model loading)
 * and produces instant summaries from code structure/naming conventions.
 */
export class TemplateSummarizer implements Summarizer {
  async init(): Promise<void> {
    // No model to load — templates are instant
  }

  async summarize(source: string, kind: NodeKind): Promise<string> {
    // Extract a plausible name from the first line
    const firstLine = source.split('\n')[0] || '';
    const nameMatch = firstLine.match(
      /(?:function|def|func|class|const|let|var|type|interface)\s+(\w+)/,
    );
    const name = nameMatch?.[1] || 'unknown';

    return summarizeFromMetadata({ name, kind, source });
  }

  async summarizeBatch(
    items: Array<{ source: string; kind: NodeKind }>,
  ): Promise<string[]> {
    return Promise.all(
      items.map((item) => this.summarize(item.source, item.kind)),
    );
  }

  async dispose(): Promise<void> {
    // Nothing to dispose
  }
}
