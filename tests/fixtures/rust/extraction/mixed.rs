struct Server {
    host: String,
    port: u16,
}

enum Status {
    Active,
    Inactive,
    Error,
}

fn create_server(host: &str, port: u16) -> Server {
    Server {
        host: host.to_string(),
        port,
    }
}

impl Server {
    fn start(&self) {}
    fn stop(&self) {}
}
