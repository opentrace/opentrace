/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

class Logger {
    func log(_ message: String) {}
    func getLevel() -> Int { return 0 }
    func isEnabled() -> Bool { return true }
}

func createLogger() -> Logger {
    return Logger()
}

func greet(name: String) -> String {
    return "Hello \(name)"
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
