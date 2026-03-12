trait Drawable {
    fn draw(&self);
    fn area(&self) -> f64;
}

trait Logger {
    fn log(&self, msg: &str) {
        println!("{}", msg);
    }

    fn error(&self, msg: &str);
}
