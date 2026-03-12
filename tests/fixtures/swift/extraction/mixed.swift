class Logger {
    func log(_ message: String) {}
}

func createLogger() -> Logger {
    return Logger()
}

struct Config {
    var port: Int
}

enum Direction {
    case north
    case south
    case east
    case west
}
