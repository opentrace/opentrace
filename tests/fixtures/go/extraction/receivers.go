package main

type Server struct{}

func (s Server) Start() error {
	return nil
}

func (s *Server) Stop() {
	s.cleanup()
}
