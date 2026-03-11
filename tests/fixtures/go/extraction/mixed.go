package main

type Config struct {
	Debug bool
}

type Logger interface {
	Log(msg string)
}

func NewConfig() *Config {
	return nil
}

func (c *Config) Validate() error {
	return nil
}
