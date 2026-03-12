import { describe, it, expect } from 'vitest';
import { extractGeneric } from '../parser/extractors/generic';
import {
  parseCpp,
  parseRust,
  parseJava,
  parseRuby,
  parseCsharp,
  parseKotlin,
  parseSwift,
  parseC,
} from './helpers';

describe('extractGeneric', () => {
  describe('C++', () => {
    it('extracts a class with methods', async () => {
      const root = await parseCpp(`
class MyClass {
public:
  void doWork(int x) {
    return;
  }

  int getValue() {
    return 42;
  }
};
`);
      const result = extractGeneric(root, 'cpp');
      expect(result.language).toBe('cpp');
      expect(result.symbols).toHaveLength(1);

      const cls = result.symbols[0];
      expect(cls.name).toBe('MyClass');
      expect(cls.kind).toBe('class');
      expect(cls.children.length).toBeGreaterThanOrEqual(2);

      const methodNames = cls.children.map((c) => c.name);
      expect(methodNames).toContain('doWork');
      expect(methodNames).toContain('getValue');
    });

    it('extracts a struct', async () => {
      const root = await parseCpp(`
struct Point {
  int x;
  int y;
};
`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Point');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts a free function', async () => {
      const root = await parseCpp(`
int add(int a, int b) {
  return a + b;
}
`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('add');
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].startLine).toBe(2);
      expect(result.symbols[0].endLine).toBe(4);
    });

    it('extracts namespace contents', async () => {
      const root = await parseCpp(`
namespace utils {
  void helper() {}
}
`);
      const result = extractGeneric(root, 'cpp');
      // The helper function should be extracted from inside the namespace
      const funcNames = result.symbols.map((s) => s.name);
      expect(funcNames).toContain('helper');
    });

    it('extracts an enum', async () => {
      const root = await parseCpp(`
enum Color {
  Red,
  Green,
  Blue
};
`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Color');
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('extracts multiple top-level symbols', async () => {
      const root = await parseCpp(`
class Logger {
public:
  void log(const char* msg) {}
};

void initLogger() {}

struct Config {
  int port;
};
`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols).toHaveLength(3);
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('Logger');
      expect(names).toContain('initLogger');
      expect(names).toContain('Config');
    });

    it('extracts struct with methods', async () => {
      const root = await parseCpp(`
struct Rect {
  int width;
  int height;
  int area() { return width * height; }
};
`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols).toHaveLength(1);
      const s = result.symbols[0];
      expect(s.name).toBe('Rect');
      expect(s.subtype).toBe('struct');
      const methodNames = s.children.map((c) => c.name);
      expect(methodNames).toContain('area');
    });

    it('records correct line numbers for class and methods', async () => {
      const root = await parseCpp(`class Foo {
public:
  void bar() {}
  void baz() {}
};
`);
      const result = extractGeneric(root, 'cpp');
      const cls = result.symbols[0];
      expect(cls.startLine).toBe(1);
      expect(cls.endLine).toBe(5);
    });

    it('extracts nested namespace functions', async () => {
      const root = await parseCpp(`
namespace outer {
  namespace inner {
    void deepFunc() {}
  }
}
`);
      const result = extractGeneric(root, 'cpp');
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('deepFunc');
    });

    it('extracts empty class', async () => {
      const root = await parseCpp(`class Empty {};`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Empty');
      expect(result.symbols[0].children).toHaveLength(0);
    });

    it('extracts class inheriting from multiple bases', async () => {
      const root = await parseCpp(`
class Widget : public Base, protected Mixin {
public:
  void render() {}
};
`);
      const result = extractGeneric(root, 'cpp');
      const cls = result.symbols[0];
      expect(cls.superclasses).toContain('Base');
      expect(cls.superclasses).toContain('Mixin');
      expect(cls.children).toHaveLength(1);
      expect(cls.children[0].name).toBe('render');
    });
  });

  describe('C', () => {
    it('extracts a function definition', async () => {
      const root = await parseC(`
int main(int argc, char *argv[]) {
  return 0;
}
`);
      const result = extractGeneric(root, 'c');
      expect(result.language).toBe('c');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('main');
      expect(result.symbols[0].kind).toBe('function');
    });

    it('extracts a struct', async () => {
      const root = await parseC(`
struct Point {
  int x;
  int y;
};
`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Point');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts an enum', async () => {
      const root = await parseC(`
enum Direction {
  NORTH,
  SOUTH,
  EAST,
  WEST
};
`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Direction');
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('extracts multiple functions', async () => {
      const root = await parseC(`
int add(int a, int b) {
  return a + b;
}

int subtract(int a, int b) {
  return a - b;
}

void noop() {}
`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols).toHaveLength(3);
      const names = result.symbols.map((s) => s.name);
      expect(names).toEqual(['add', 'subtract', 'noop']);
    });

    it('extracts mixed structs and functions', async () => {
      const root = await parseC(`
struct Node {
  int value;
  struct Node* next;
};

struct Node* create_node(int val) {
  return 0;
}

void free_node(struct Node* n) {}
`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols).toHaveLength(3);
      const kinds = result.symbols.map((s) => s.kind);
      expect(kinds).toEqual(['class', 'function', 'function']);
    });

    it('records correct line numbers', async () => {
      const root = await parseC(`void hello() {
  return;
}
`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols[0].startLine).toBe(1);
      expect(result.symbols[0].endLine).toBe(3);
    });

    it('extracts function signature with complex params', async () => {
      const root = await parseC(`
void process(const char* name, int count, float ratio) {
  return;
}
`);
      const result = extractGeneric(root, 'c');
      const sig = result.symbols[0].signature;
      expect(sig).not.toBeNull();
      expect(sig).toContain('const char');
      expect(sig).toContain('int count');
      expect(sig).toContain('float ratio');
    });
  });

  describe('Rust', () => {
    it('extracts a struct and function', async () => {
      const root = await parseRust(`
struct Config {
    host: String,
    port: u16,
}

fn create_config() -> Config {
    Config {
        host: "localhost".to_string(),
        port: 8080,
    }
}
`);
      const result = extractGeneric(root, 'rust');
      expect(result.language).toBe('rust');
      expect(result.symbols).toHaveLength(2);

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('Config');
      expect(names).toContain('create_config');

      const struct = result.symbols.find((s) => s.name === 'Config')!;
      expect(struct.kind).toBe('class');

      const func = result.symbols.find((s) => s.name === 'create_config')!;
      expect(func.kind).toBe('function');
    });

    it('extracts a trait', async () => {
      const root = await parseRust(`
trait Drawable {
    fn draw(&self);
    fn area(&self) -> f64;
}
`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Drawable');
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].children).toHaveLength(2);
    });

    it('extracts impl block methods as top-level functions', async () => {
      const root = await parseRust(`
impl Config {
    fn new() -> Config {
        Config { host: "".into(), port: 0 }
    }
}
`);
      const result = extractGeneric(root, 'rust');
      // impl blocks are containers — methods should be extracted
      const funcNames = result.symbols.map((s) => s.name);
      expect(funcNames).toContain('new');
    });

    it('extracts an enum', async () => {
      const root = await parseRust(`
enum Color {
    Red,
    Green,
    Blue,
}
`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Color');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts trait with default method implementations', async () => {
      const root = await parseRust(`
trait Logger {
    fn log(&self, msg: &str) {
        println!("{}", msg);
    }

    fn error(&self, msg: &str);
}
`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols).toHaveLength(1);
      const trait = result.symbols[0];
      expect(trait.name).toBe('Logger');
      expect(trait.subtype).toBe('trait');
      const childNames = trait.children.map((c) => c.name);
      expect(childNames).toContain('log');
      expect(childNames).toContain('error');
    });

    it('extracts multiple impl blocks', async () => {
      const root = await parseRust(`
struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn new(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn distance(&self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

impl Default for Point {
    fn default() -> Point {
        Point { x: 0.0, y: 0.0 }
    }
}
`);
      const result = extractGeneric(root, 'rust');
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('Point');
      expect(names).toContain('new');
      expect(names).toContain('distance');
      expect(names).toContain('default');
    });

    it('records correct line numbers', async () => {
      const root = await parseRust(`fn greet(name: &str) {
    println!("Hello, {}", name);
}
`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols[0].startLine).toBe(1);
      expect(result.symbols[0].endLine).toBe(3);
    });

    it('extracts function signature with params', async () => {
      const root = await parseRust(`
fn connect(host: &str, port: u16) -> bool {
    true
}
`);
      const result = extractGeneric(root, 'rust');
      const sig = result.symbols[0].signature;
      expect(sig).not.toBeNull();
      expect(sig).toContain('host');
      expect(sig).toContain('port');
    });

    it('extracts enum with tuple and struct variants', async () => {
      const root = await parseRust(`
enum Message {
    Quit,
    Move { x: i32, y: i32 },
    Write(String),
    Color(i32, i32, i32),
}
`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Message');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('extracts empty struct', async () => {
      const root = await parseRust(`struct Unit;`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Unit');
      expect(result.symbols[0].children).toHaveLength(0);
    });
  });

  describe('Java', () => {
    it('extracts a class with methods', async () => {
      const root = await parseJava(`
public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }

    public int subtract(int a, int b) {
        return a - b;
    }
}
`);
      const result = extractGeneric(root, 'java');
      expect(result.language).toBe('java');
      expect(result.symbols).toHaveLength(1);

      const cls = result.symbols[0];
      expect(cls.name).toBe('Calculator');
      expect(cls.kind).toBe('class');
      expect(cls.children).toHaveLength(2);

      const methodNames = cls.children.map((c) => c.name);
      expect(methodNames).toContain('add');
      expect(methodNames).toContain('subtract');
    });

    it('extracts an interface', async () => {
      const root = await parseJava(`
public interface Repository {
    void save(Object item);
    Object findById(String id);
}
`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Repository');
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].children).toHaveLength(2);
    });

    it('extracts an enum', async () => {
      const root = await parseJava(`
public enum Status {
    ACTIVE,
    INACTIVE;
}
`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Status');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts a constructor', async () => {
      const root = await parseJava(`
public class User {
    private String name;

    public User(String name) {
        this.name = name;
    }
}
`);
      const result = extractGeneric(root, 'java');
      const cls = result.symbols[0];
      const constructors = cls.children.filter((c) => c.name === 'User');
      expect(constructors).toHaveLength(1);
    });

    it('records correct line numbers', async () => {
      const root = await parseJava(`public class Foo {
    public void bar() {
        return;
    }
}
`);
      const result = extractGeneric(root, 'java');
      const cls = result.symbols[0];
      expect(cls.startLine).toBe(1);
      expect(cls.endLine).toBe(5);
      expect(cls.children[0].startLine).toBe(2);
      expect(cls.children[0].endLine).toBe(4);
    });

    it('extracts abstract class with abstract methods', async () => {
      const root = await parseJava(`
public abstract class Shape {
    public abstract double area();
    public abstract double perimeter();

    public void describe() {
        System.out.println("I am a shape");
    }
}
`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols).toHaveLength(1);
      const cls = result.symbols[0];
      expect(cls.name).toBe('Shape');
      expect(cls.children).toHaveLength(3);
      const names = cls.children.map((c) => c.name);
      expect(names).toContain('area');
      expect(names).toContain('perimeter');
      expect(names).toContain('describe');
    });

    it('extracts interface with multiple methods', async () => {
      const root = await parseJava(`
public interface Comparable {
    int compareTo(Object other);
    boolean equals(Object other);
    int hashCode();
}
`);
      const result = extractGeneric(root, 'java');
      const iface = result.symbols[0];
      expect(iface.subtype).toBe('interface');
      expect(iface.children).toHaveLength(3);
    });

    it('extracts enum with methods (methods not found — v1 limitation)', async () => {
      // Java enum methods are nested inside enum_body_declarations, which
      // extractMethods doesn't recurse into. The enum itself is extracted.
      const root = await parseJava(`
public enum Planet {
    MERCURY, VENUS, EARTH;

    public double surfaceGravity() {
        return 9.8;
    }
}
`);
      const result = extractGeneric(root, 'java');
      const e = result.symbols[0];
      expect(e.name).toBe('Planet');
      expect(e.subtype).toBe('enum');
      // Methods inside enums are not extracted in v1
      expect(e.children).toHaveLength(0);
    });

    it('extracts class with multiple constructors', async () => {
      const root = await parseJava(`
public class Point {
    private int x, y;

    public Point() {
        this.x = 0;
        this.y = 0;
    }

    public Point(int x, int y) {
        this.x = x;
        this.y = y;
    }

    public int getX() { return x; }
}
`);
      const result = extractGeneric(root, 'java');
      const cls = result.symbols[0];
      const constructors = cls.children.filter((c) => c.name === 'Point');
      expect(constructors).toHaveLength(2);
      const names = cls.children.map((c) => c.name);
      expect(names).toContain('getX');
    });

    it('extracts empty class', async () => {
      const root = await parseJava(`public class Empty {}`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Empty');
      expect(result.symbols[0].children).toHaveLength(0);
    });

    it('extracts method signatures', async () => {
      const root = await parseJava(`
public class Service {
    public String process(int id, String name) {
        return name;
    }
}
`);
      const result = extractGeneric(root, 'java');
      const method = result.symbols[0].children[0];
      expect(method.signature).not.toBeNull();
      expect(method.signature).toContain('int id');
      expect(method.signature).toContain('String name');
    });
  });

  describe('Ruby', () => {
    it('extracts a class with methods', async () => {
      const root = await parseRuby(`
class Greeter
  def initialize(name)
    @name = name
  end

  def greet
    "Hello, #{@name}!"
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.language).toBe('ruby');
      expect(result.symbols).toHaveLength(1);

      const cls = result.symbols[0];
      expect(cls.name).toBe('Greeter');
      expect(cls.kind).toBe('class');
      expect(cls.children).toHaveLength(2);

      const methodNames = cls.children.map((c) => c.name);
      expect(methodNames).toContain('initialize');
      expect(methodNames).toContain('greet');
    });

    it('extracts a module', async () => {
      const root = await parseRuby(`
module Helpers
  def self.format(value)
    value.to_s
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Helpers');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts singleton methods', async () => {
      const root = await parseRuby(`
class Config
  def self.default
    new
  end

  def self.from_file(path)
    new
  end

  def initialize
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      const cls = result.symbols[0];
      const names = cls.children.map((c) => c.name);
      expect(names).toContain('default');
      expect(names).toContain('from_file');
      expect(names).toContain('initialize');
    });

    it('extracts multiple classes', async () => {
      const root = await parseRuby(`
class Dog
  def bark
    "woof"
  end
end

class Cat
  def meow
    "meow"
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].name).toBe('Dog');
      expect(result.symbols[1].name).toBe('Cat');
    });

    it('extracts module with multiple methods', async () => {
      const root = await parseRuby(`
module Enumerable
  def map
  end

  def select
  end

  def reduce
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      const mod = result.symbols[0];
      expect(mod.name).toBe('Enumerable');
      expect(mod.subtype).toBe('module');
      expect(mod.children).toHaveLength(3);
    });

    it('records correct line numbers', async () => {
      const root = await parseRuby(`class Foo
  def bar
    nil
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      const cls = result.symbols[0];
      expect(cls.startLine).toBe(1);
      expect(cls.endLine).toBe(5);
      expect(cls.children[0].startLine).toBe(2);
      expect(cls.children[0].endLine).toBe(4);
    });

    it('extracts empty class', async () => {
      const root = await parseRuby(`
class Empty
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Empty');
      expect(result.symbols[0].children).toHaveLength(0);
    });

    it('extracts class with inheritance', async () => {
      const root = await parseRuby(`
class Admin < User
  def promote
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.symbols[0].superclasses).toEqual(['User']);
      expect(result.symbols[0].children).toHaveLength(1);
    });
  });

  describe('C#', () => {
    it('extracts a class with methods', async () => {
      const root = await parseCsharp(`
public class Calculator {
    public int Add(int a, int b) {
        return a + b;
    }
}
`);
      const result = extractGeneric(root, 'csharp');
      expect(result.language).toBe('csharp');
      expect(result.symbols).toHaveLength(1);

      const cls = result.symbols[0];
      expect(cls.name).toBe('Calculator');
      expect(cls.kind).toBe('class');
      expect(cls.children).toHaveLength(1);
      expect(cls.children[0].name).toBe('Add');
    });

    it('extracts an interface', async () => {
      const root = await parseCsharp(`
public interface IRepository {
    void Save(object item);
}
`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('IRepository');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts a struct with methods', async () => {
      const root = await parseCsharp(`
public struct Vector2 {
    public float X;
    public float Y;

    public float Magnitude() {
        return 0;
    }
}
`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols).toHaveLength(1);
      const s = result.symbols[0];
      expect(s.name).toBe('Vector2');
      expect(s.subtype).toBe('struct');
      expect(s.children).toHaveLength(1);
      expect(s.children[0].name).toBe('Magnitude');
    });

    it('extracts an enum', async () => {
      const root = await parseCsharp(`
public enum LogLevel {
    Debug,
    Info,
    Warning,
    Error
}
`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('LogLevel');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('extracts class in namespace', async () => {
      const root = await parseCsharp(`
namespace MyApp.Services {
    public class UserService {
        public void Create() {}
    }
}
`);
      const result = extractGeneric(root, 'csharp');
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('UserService');
    });

    it('extracts multiple classes', async () => {
      const root = await parseCsharp(`
public class Request {
    public string Url;
}

public class Response {
    public int StatusCode;
}
`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].name).toBe('Request');
      expect(result.symbols[1].name).toBe('Response');
    });

    it('extracts interface with multiple methods', async () => {
      const root = await parseCsharp(`
public interface IService {
    void Start();
    void Stop();
    bool IsRunning();
}
`);
      const result = extractGeneric(root, 'csharp');
      const iface = result.symbols[0];
      expect(iface.subtype).toBe('interface');
      expect(iface.children).toHaveLength(3);
      const names = iface.children.map((c) => c.name);
      expect(names).toContain('Start');
      expect(names).toContain('Stop');
      expect(names).toContain('IsRunning');
    });

    it('records correct line numbers', async () => {
      const root = await parseCsharp(`public class Foo {
    public void Bar() {
        return;
    }
}
`);
      const result = extractGeneric(root, 'csharp');
      const cls = result.symbols[0];
      expect(cls.startLine).toBe(1);
      expect(cls.endLine).toBe(5);
      expect(cls.children[0].startLine).toBe(2);
      expect(cls.children[0].endLine).toBe(4);
    });

    it('extracts empty class', async () => {
      const root = await parseCsharp(`public class Empty {}`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Empty');
      expect(result.symbols[0].children).toHaveLength(0);
    });

    it('extracts class with base class and interface', async () => {
      const root = await parseCsharp(`
public class Dog : Animal, IRunnable {
    public void Run() {}
}
`);
      const result = extractGeneric(root, 'csharp');
      const cls = result.symbols[0];
      // C# doesn't distinguish class vs interface at AST level
      expect(cls.superclasses).toContain('Animal');
      expect(cls.superclasses).toContain('IRunnable');
    });
  });

  describe('Kotlin', () => {
    it('extracts a class with functions', async () => {
      const root = await parseKotlin(`
class Calculator {
    fun add(a: Int, b: Int): Int {
        return a + b
    }
}
`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.language).toBe('kotlin');
      expect(result.symbols).toHaveLength(1);

      const cls = result.symbols[0];
      expect(cls.name).toBe('Calculator');
      expect(cls.kind).toBe('class');
      expect(cls.children).toHaveLength(1);
      expect(cls.children[0].name).toBe('add');
    });

    it('extracts an object declaration', async () => {
      const root = await parseKotlin(`
object Singleton {
    fun instance(): Singleton = this
}
`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Singleton');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts a top-level function', async () => {
      const root = await parseKotlin(`
fun main(args: Array<String>) {
    println("Hello")
}
`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('main');
      expect(result.symbols[0].kind).toBe('function');
    });

    it('extracts data class', async () => {
      const root = await parseKotlin(`
data class User(val name: String, val age: Int)
`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('User');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts class with multiple methods', async () => {
      const root = await parseKotlin(`
class Service {
    fun start() {}
    fun stop() {}
    fun isRunning(): Boolean { return false }
}
`);
      const result = extractGeneric(root, 'kotlin');
      const cls = result.symbols[0];
      expect(cls.children).toHaveLength(3);
      const names = cls.children.map((c) => c.name);
      expect(names).toContain('start');
      expect(names).toContain('stop');
      expect(names).toContain('isRunning');
    });

    it('extracts multiple top-level symbols', async () => {
      const root = await parseKotlin(`
class Logger {
    fun log(msg: String) {}
}

fun createLogger(): Logger {
    return Logger()
}

object Config {
    fun load() {}
}
`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols).toHaveLength(3);
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('Logger');
      expect(names).toContain('createLogger');
      expect(names).toContain('Config');
    });

    it('records correct line numbers', async () => {
      const root = await parseKotlin(`class Foo {
    fun bar() {
        return
    }
}
`);
      const result = extractGeneric(root, 'kotlin');
      const cls = result.symbols[0];
      expect(cls.startLine).toBe(1);
      expect(cls.endLine).toBe(5);
      expect(cls.children[0].startLine).toBe(2);
      expect(cls.children[0].endLine).toBe(4);
    });

    it('extracts empty class', async () => {
      const root = await parseKotlin(`class Empty`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Empty');
    });

    it('does not extract Kotlin superclass (v1 limitation)', async () => {
      // Kotlin AST uses delegation_specifier (singular) as direct children,
      // but extractInheritance checks for delegation_specifiers (plural wrapper).
      const root = await parseKotlin(`
open class Animal
class Dog : Animal() {
    fun bark() {}
}
`);
      const result = extractGeneric(root, 'kotlin');
      const dog = result.symbols.find((s) => s.name === 'Dog')!;
      expect(dog.superclasses).toBeUndefined();
    });

    it('extracts object with methods', async () => {
      const root = await parseKotlin(`
object Database {
    fun connect() {}
    fun disconnect() {}
    fun query(sql: String) {}
}
`);
      const result = extractGeneric(root, 'kotlin');
      const obj = result.symbols[0];
      expect(obj.subtype).toBe('object');
      expect(obj.children).toHaveLength(3);
    });

    it('returns null signature for Kotlin functions (v1 limitation)', async () => {
      // Kotlin uses function_value_parameters instead of parameters field,
      // so extractFunction's parameter lookup returns null.
      const root = await parseKotlin(`
fun connect(host: String, port: Int): Boolean {
    return true
}
`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols[0].signature).toBeNull();
    });
  });

  describe('Swift', () => {
    it('extracts a class with methods', async () => {
      const root = await parseSwift(`
class Vehicle {
    func start() {
        print("Starting")
    }

    init(model: String) {
        self.model = model
    }
}
`);
      const result = extractGeneric(root, 'swift');
      expect(result.language).toBe('swift');
      expect(result.symbols).toHaveLength(1);

      const cls = result.symbols[0];
      expect(cls.name).toBe('Vehicle');
      expect(cls.kind).toBe('class');
      expect(cls.children.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts a protocol', async () => {
      const root = await parseSwift(`
protocol Drawable {
    func draw()
}
`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Drawable');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts a struct', async () => {
      const root = await parseSwift(`
struct Point {
    var x: Double
    var y: Double

    func distance() -> Double {
        return (x * x + y * y).squareRoot()
    }
}
`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols).toHaveLength(1);
      const s = result.symbols[0];
      expect(s.name).toBe('Point');
      expect(s.kind).toBe('class');
      const methodNames = s.children.map((c) => c.name);
      expect(methodNames).toContain('distance');
    });

    it('extracts an enum', async () => {
      const root = await parseSwift(`
enum Direction {
    case north
    case south
    case east
    case west
}
`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Direction');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('extracts multiple top-level symbols', async () => {
      const root = await parseSwift(`
class Logger {
    func log(_ message: String) {}
}

func createLogger() -> Logger {
    return Logger()
}

struct Config {
    var port: Int
}
`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols).toHaveLength(3);
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('Logger');
      expect(names).toContain('createLogger');
      expect(names).toContain('Config');
    });

    it('extracts protocol without methods (v1 limitation)', async () => {
      // Swift protocol body is protocol_body (not in findBody's list) and methods
      // are protocol_function_declaration (not function_declaration), so children
      // are not extracted.
      const root = await parseSwift(`
protocol Service {
    func start()
    func stop()
    func status() -> String
}
`);
      const result = extractGeneric(root, 'swift');
      const proto = result.symbols[0];
      expect(proto.subtype).toBe('protocol');
      // Protocol methods not extracted in v1
      expect(proto.children).toHaveLength(0);
    });

    it('extracts class with init and methods', async () => {
      const root = await parseSwift(`
class User {
    var name: String

    init(name: String) {
        self.name = name
    }

    func greet() -> String {
        return "Hello, \\(name)"
    }
}
`);
      const result = extractGeneric(root, 'swift');
      const cls = result.symbols[0];
      expect(cls.name).toBe('User');
      const names = cls.children.map((c) => c.name);
      expect(names).toContain('greet');
    });

    it('records correct line numbers', async () => {
      const root = await parseSwift(`class Foo {
    func bar() {
        return
    }
}
`);
      const result = extractGeneric(root, 'swift');
      const cls = result.symbols[0];
      expect(cls.startLine).toBe(1);
      expect(cls.endLine).toBe(5);
    });

    it('extracts empty class', async () => {
      const root = await parseSwift(`class Empty {}`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Empty');
      expect(result.symbols[0].children).toHaveLength(0);
    });

    it('extracts struct with methods in body', async () => {
      const root = await parseSwift(`
struct Rectangle {
    var width: Double
    var height: Double

    func area() -> Double {
        return width * height
    }

    func perimeter() -> Double {
        return 2 * (width + height)
    }
}
`);
      const result = extractGeneric(root, 'swift');
      const s = result.symbols[0];
      expect(s.name).toBe('Rectangle');
      expect(s.children).toHaveLength(2);
      const names = s.children.map((c) => c.name);
      expect(names).toContain('area');
      expect(names).toContain('perimeter');
    });

    it('does not extract Swift class inheritance (v1 limitation)', async () => {
      // Swift AST uses inheritance_specifier as direct child (not wrapped in
      // type_inheritance_clause), so extractInheritance doesn't find it.
      const root = await parseSwift(`
class Dog: Animal {
    func bark() {}
}
`);
      const result = extractGeneric(root, 'swift');
      const cls = result.symbols[0];
      expect(cls.superclasses).toBeUndefined();
    });

    it('returns null signature for Swift functions (v1 limitation)', async () => {
      // Swift function params are individual parameter children, not a
      // parameters wrapper node, so extractFunction returns null signature.
      const root = await parseSwift(`
func connect(host: String, port: Int) -> Bool {
    return true
}
`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols[0].signature).toBeNull();
    });
  });

  describe('subtype', () => {
    it('sets subtype for C++ struct', async () => {
      const root = await parseCpp(`struct Point { int x; int y; };`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols[0].subtype).toBe('struct');
    });

    it('sets no subtype for C++ class', async () => {
      const root = await parseCpp(`class MyClass { public: void run() {} };`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols[0].subtype).toBeUndefined();
    });

    it('sets subtype for C++ enum', async () => {
      const root = await parseCpp(`enum Color { Red, Green, Blue };`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('sets subtype for C struct', async () => {
      const root = await parseC(`struct Point { int x; int y; };`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols[0].subtype).toBe('struct');
    });

    it('sets subtype for C enum', async () => {
      const root = await parseC(`enum Color { Red, Green, Blue };`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('sets subtype for Java interface', async () => {
      const root = await parseJava(`public interface Runnable { void run(); }`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols[0].subtype).toBe('interface');
    });

    it('sets subtype for Java enum', async () => {
      const root = await parseJava(`public enum Color { RED, GREEN, BLUE }`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('sets no subtype for Java class', async () => {
      const root = await parseJava(`public class Foo {}`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols[0].subtype).toBeUndefined();
    });

    it('sets subtype for Rust struct', async () => {
      const root = await parseRust(`struct Config { host: String }`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols[0].subtype).toBe('struct');
    });

    it('sets subtype for Rust trait', async () => {
      const root = await parseRust(`trait Drawable { fn draw(&self); }`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols[0].subtype).toBe('trait');
    });

    it('sets subtype for Rust enum', async () => {
      const root = await parseRust(`enum Color { Red, Green, Blue }`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('sets subtype for C# interface', async () => {
      const root = await parseCsharp(`public interface IRepo { void Save(); }`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols[0].subtype).toBe('interface');
    });

    it('sets subtype for C# struct', async () => {
      const root = await parseCsharp(`public struct Point { public int X; }`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols[0].subtype).toBe('struct');
    });

    it('sets subtype for C# enum', async () => {
      const root = await parseCsharp(`
public enum LogLevel {
    Debug,
    Info,
    Warning,
    Error
}
`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols[0].subtype).toBe('enum');
    });

    it('sets subtype for Kotlin object', async () => {
      const root = await parseKotlin(`object Singleton { fun get() = this }`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols[0].subtype).toBe('object');
    });

    it('sets no subtype for Kotlin class', async () => {
      const root = await parseKotlin(`class Foo { fun bar() {} }`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols[0].subtype).toBeUndefined();
    });

    it('sets subtype for Ruby module', async () => {
      const root = await parseRuby(`
module Helpers
  def self.format(value)
    value.to_s
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.symbols[0].subtype).toBe('module');
    });

    it('sets no subtype for Ruby class', async () => {
      const root = await parseRuby(`
class Foo
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.symbols[0].subtype).toBeUndefined();
    });

    it('sets subtype for Swift protocol', async () => {
      const root = await parseSwift(`protocol Drawable { func draw() }`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols[0].subtype).toBe('protocol');
    });

    it('sets no subtype for Swift class', async () => {
      const root = await parseSwift(`class Foo { func bar() {} }`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols[0].subtype).toBeUndefined();
    });
  });

  describe('superclasses and interfaces', () => {
    it('extracts Java superclass and interfaces', async () => {
      const root = await parseJava(`
public class Dog extends Animal implements Runnable, Serializable {
    public void run() {}
}
`);
      const result = extractGeneric(root, 'java');
      const cls = result.symbols[0];
      expect(cls.superclasses).toEqual(['Animal']);
      expect(cls.interfaces).toEqual(['Runnable', 'Serializable']);
    });

    it('extracts Java class with only interface', async () => {
      const root = await parseJava(`
public class Worker implements Runnable {
    public void run() {}
}
`);
      const result = extractGeneric(root, 'java');
      const cls = result.symbols[0];
      expect(cls.superclasses).toBeUndefined();
      expect(cls.interfaces).toEqual(['Runnable']);
    });

    it('no inheritance for plain Java class', async () => {
      const root = await parseJava(`public class Foo {}`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols[0].superclasses).toBeUndefined();
      expect(result.symbols[0].interfaces).toBeUndefined();
    });

    it('extracts Java interface extending interfaces', async () => {
      const root = await parseJava(`
public interface ReadWriteRepository extends Readable, Writable {
    void sync();
}
`);
      const result = extractGeneric(root, 'java');
      const iface = result.symbols[0];
      // interface "extends" shows up in the extends_interfaces field
      expect(iface.subtype).toBe('interface');
    });

    it('extracts Ruby superclass', async () => {
      const root = await parseRuby(`
class Admin < User
  def promote
  end
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.symbols[0].superclasses).toEqual(['User']);
    });

    it('no superclass for plain Ruby class', async () => {
      const root = await parseRuby(`
class Foo
end
`);
      const result = extractGeneric(root, 'ruby');
      expect(result.symbols[0].superclasses).toBeUndefined();
    });

    it('extracts C++ base classes', async () => {
      const root = await parseCpp(`
class Dog : public Animal, public Trainable {
public:
  void bark() {}
};
`);
      const result = extractGeneric(root, 'cpp');
      const cls = result.symbols[0];
      expect(cls.superclasses).toContain('Animal');
      expect(cls.superclasses).toContain('Trainable');
    });

    it('extracts C++ single inheritance', async () => {
      const root = await parseCpp(`
class Child : public Parent {
public:
  void method() {}
};
`);
      const result = extractGeneric(root, 'cpp');
      const cls = result.symbols[0];
      expect(cls.superclasses).toEqual(['Parent']);
    });

    it('no inheritance for plain C++ class', async () => {
      const root = await parseCpp(
        `class Standalone { public: void run() {} };`,
      );
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols[0].superclasses).toBeUndefined();
    });

    it('extracts C# base types', async () => {
      const root = await parseCsharp(`
public class Dog : Animal, IRunnable {
    public void Run() {}
}
`);
      const result = extractGeneric(root, 'csharp');
      const cls = result.symbols[0];
      // C# doesn't distinguish class vs interface at AST level
      expect(cls.superclasses).toContain('Animal');
      expect(cls.superclasses).toContain('IRunnable');
    });

    it('no inheritance for plain C# class', async () => {
      const root = await parseCsharp(`public class Standalone {}`);
      const result = extractGeneric(root, 'csharp');
      expect(result.symbols[0].superclasses).toBeUndefined();
    });

    it('does not extract Kotlin superclass via delegation specifiers (v1 limitation)', async () => {
      // Kotlin AST uses delegation_specifier (singular), not delegation_specifiers
      const root = await parseKotlin(`
open class Animal
class Dog : Animal() {
    fun bark() {}
}
`);
      const result = extractGeneric(root, 'kotlin');
      const dog = result.symbols.find((s) => s.name === 'Dog')!;
      expect(dog.superclasses).toBeUndefined();
    });

    it('no inheritance for plain Kotlin class', async () => {
      const root = await parseKotlin(`class Standalone { fun run() {} }`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols[0].superclasses).toBeUndefined();
    });

    it('does not extract Swift class inheritance (v1 limitation)', async () => {
      // Swift AST uses inheritance_specifier directly, not type_inheritance_clause
      const root = await parseSwift(`
class Dog: Animal {
    func bark() {}
}
`);
      const result = extractGeneric(root, 'swift');
      const cls = result.symbols[0];
      expect(cls.superclasses).toBeUndefined();
    });

    it('no inheritance for plain Swift class', async () => {
      const root = await parseSwift(`class Standalone { func run() {} }`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols[0].superclasses).toBeUndefined();
    });
  });

  describe('C/C++ function signature', () => {
    it('extracts C function signature via declarator fallback', async () => {
      const root = await parseC(`
int add(int a, int b) {
  return a + b;
}
`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols[0].signature).not.toBeNull();
      expect(result.symbols[0].signature).toContain('int a');
    });

    it('extracts C++ function signature via declarator fallback', async () => {
      const root = await parseCpp(`
void doWork(int x) {
  return;
}
`);
      const result = extractGeneric(root, 'cpp');
      expect(result.symbols[0].signature).not.toBeNull();
      expect(result.symbols[0].signature).toContain('int x');
    });

    it('extracts C function with no params', async () => {
      const root = await parseC(`
void noop() {
  return;
}
`);
      const result = extractGeneric(root, 'c');
      const sig = result.symbols[0].signature;
      expect(sig).not.toBeNull();
      expect(sig).toBe('()');
    });

    it('extracts C++ method signature in class', async () => {
      const root = await parseCpp(`
class Math {
public:
  int multiply(int a, int b) { return a * b; }
};
`);
      const result = extractGeneric(root, 'cpp');
      const method = result.symbols[0].children[0];
      expect(method.signature).not.toBeNull();
      expect(method.signature).toContain('int a');
    });
  });

  describe('function signatures across languages', () => {
    it('extracts Java method signature', async () => {
      const root = await parseJava(`
public class Svc {
    public String handle(int id, String name) {
        return name;
    }
}
`);
      const result = extractGeneric(root, 'java');
      const method = result.symbols[0].children[0];
      expect(method.signature).not.toBeNull();
      expect(method.signature).toContain('int id');
    });

    it('extracts Rust function signature', async () => {
      const root = await parseRust(`
fn process(input: &str, count: usize) -> bool {
    true
}
`);
      const result = extractGeneric(root, 'rust');
      const sig = result.symbols[0].signature;
      expect(sig).not.toBeNull();
      expect(sig).toContain('input');
      expect(sig).toContain('count');
    });

    it('returns null signature for Kotlin (v1 limitation)', async () => {
      // Kotlin uses function_value_parameters, not parameters
      const root = await parseKotlin(`
fun greet(name: String, times: Int): String {
    return name.repeat(times)
}
`);
      const result = extractGeneric(root, 'kotlin');
      expect(result.symbols[0].signature).toBeNull();
    });

    it('returns null signature for Swift (v1 limitation)', async () => {
      // Swift params are individual parameter children, no parameters wrapper
      const root = await parseSwift(`
func calculate(width: Double, height: Double) -> Double {
    return width * height
}
`);
      const result = extractGeneric(root, 'swift');
      expect(result.symbols[0].signature).toBeNull();
    });

    it('extracts C# method signature', async () => {
      const root = await parseCsharp(`
public class Svc {
    public string Handle(int id, string name) {
        return name;
    }
}
`);
      const result = extractGeneric(root, 'csharp');
      const method = result.symbols[0].children[0];
      expect(method.signature).not.toBeNull();
      expect(method.signature).toContain('int id');
    });
  });

  describe('edge cases', () => {
    it('returns empty for unsupported language', async () => {
      // Use any valid AST — the language config lookup will miss
      const root = await parseRust('fn main() {}');
      const result = extractGeneric(root, 'bash');
      expect(result.symbols).toHaveLength(0);
    });

    it('sets calls to empty array', async () => {
      const root = await parseRust(`
fn greet() {
    println!("hello");
}
`);
      const result = extractGeneric(root, 'rust');
      expect(result.symbols[0].calls).toEqual([]);
    });

    it('sets receiverVar and receiverType to null', async () => {
      const root = await parseJava(`
public class Foo {
    public void bar() {}
}
`);
      const result = extractGeneric(root, 'java');
      const method = result.symbols[0].children[0];
      expect(method.receiverVar).toBeNull();
      expect(method.receiverType).toBeNull();
    });

    it('returns empty for empty source', async () => {
      const root = await parseJava(``);
      const result = extractGeneric(root, 'java');
      expect(result.symbols).toHaveLength(0);
    });

    it('skips nodes without names', async () => {
      // Bare semicolons or empty declarations should not produce symbols
      const root = await parseC(`;`);
      const result = extractGeneric(root, 'c');
      expect(result.symbols).toHaveLength(0);
    });

    it('preserves rootNode on result', async () => {
      const root = await parseRust(`fn main() {}`);
      const result = extractGeneric(root, 'rust');
      expect(result.rootNode).toBe(root);
    });

    it('calls are empty for class children too', async () => {
      const root = await parseJava(`
public class Foo {
    public void bar() {
        System.out.println("hello");
    }
}
`);
      const result = extractGeneric(root, 'java');
      expect(result.symbols[0].children[0].calls).toEqual([]);
    });

    it('paramTypes is null for all symbols', async () => {
      const root = await parseRust(`
struct Foo {}
fn bar() {}
`);
      const result = extractGeneric(root, 'rust');
      for (const sym of result.symbols) {
        expect(sym.paramTypes).toBeNull();
      }
    });
  });
});
