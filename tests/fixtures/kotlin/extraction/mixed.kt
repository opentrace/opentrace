class Logger {
    fun log(msg: String) {}
}

fun createLogger(): Logger {
    return Logger()
}

object Config {
    fun load() {}
}
