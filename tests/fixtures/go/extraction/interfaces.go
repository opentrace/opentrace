package main

type Store interface {
	Get(key string) (string, error)
	Set(key string, value string) error
}

type Any interface{}
