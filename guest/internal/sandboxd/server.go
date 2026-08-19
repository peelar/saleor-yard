package sandboxd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	config      Config
	store       *StatusStore
	provisioner *Provisioner
	httpClient  *http.Client
}

func NewServer(config Config) *Server {
	store := NewStatusStore(config.StatusPath())
	return &Server{
		config:      config,
		store:       store,
		provisioner: NewProvisioner(config, store),
		httpClient:  &http.Client{Timeout: 30 * time.Second},
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("GET /v1/status", s.handleStatus)
	mux.HandleFunc("POST /v1/provision", s.handleProvision)
	mux.HandleFunc("GET /v1/logs", s.handleLogs)
	mux.HandleFunc("POST /v1/exec", s.handleExec)
	mux.HandleFunc("POST /v1/http", s.handleHTTP)
	return mux
}

func (s *Server) Serve(ctx context.Context) error {
	if err := os.MkdirAll(filepath.Dir(s.config.SocketPath), 0o755); err != nil {
		return err
	}
	if err := os.Remove(s.config.SocketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", s.config.SocketPath)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := os.Chmod(s.config.SocketPath, 0o600); err != nil {
		return err
	}

	httpServer := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownContext)
	}()

	err = httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) handleHealth(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleStatus(response http.ResponseWriter, _ *http.Request) {
	status, err := s.store.Read()
	if err != nil {
		writeError(response, http.StatusInternalServerError, err)
		return
	}
	writeJSON(response, http.StatusOK, status)
}

func (s *Server) handleProvision(response http.ResponseWriter, request *http.Request) {
	var job Job
	if err := decodeJSON(request.Body, &job); err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	if err := ValidateJob(job); err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	if err := s.provisioner.Start(job); err != nil {
		writeError(response, http.StatusConflict, err)
		return
	}
	writeJSON(response, http.StatusAccepted, NewStatus("provisioning", "allocating_environment", job.Commit, ""))
}

func (s *Server) handleLogs(response http.ResponseWriter, request *http.Request) {
	tail, err := parseTail(request.URL.Query().Get("tail"))
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	follow := request.URL.Query().Get("follow") == "true"
	phase := request.URL.Query().Get("phase")
	service := request.URL.Query().Get("service")

	var name string
	var args []string
	if phase == "provision" {
		name = "tail"
		args = []string{"-n", strconv.Itoa(tail)}
		if follow {
			args = append(args, "-F")
		}
		args = append(args, s.config.ProvisionLogPath())
	} else {
		if service != "" {
			if err := ValidateService(service); err != nil {
				writeError(response, http.StatusBadRequest, err)
				return
			}
		}
		name = "docker"
		args = append(s.composeArgs(), "logs", "--tail", strconv.Itoa(tail))
		if follow {
			args = append(args, "--follow")
		}
		if service != "" {
			args = append(args, service)
		}
	}

	response.Header().Set("Content-Type", "text/plain; charset=utf-8")
	response.WriteHeader(http.StatusOK)
	if follow {
		s.streamCommand(request.Context(), response, name, args...)
		return
	}
	result, runError := s.config.CommandRunner.Run(request.Context(), response, response, name, args...)
	if runError != nil {
		_, _ = fmt.Fprintf(response, "\n%s\n", result.Stderr)
	}
}

func (s *Server) handleExec(response http.ResponseWriter, request *http.Request) {
	var input ExecRequest
	if err := decodeJSON(request.Body, &input); err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	if err := ValidateService(input.Service); err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	if len(input.Command) == 0 {
		writeError(response, http.StatusBadRequest, fmt.Errorf("command cannot be empty"))
		return
	}
	for _, argument := range input.Command {
		if strings.ContainsRune(argument, '\x00') {
			writeError(response, http.StatusBadRequest, fmt.Errorf("command contains a null byte"))
			return
		}
	}

	args := append(s.composeArgs(), "exec", "-T", input.Service)
	args = append(args, input.Command...)
	result, _ := s.config.CommandRunner.Run(request.Context(), io.Discard, io.Discard, "docker", args...)
	writeJSON(response, http.StatusOK, ExecResponse{
		ExitCode: result.ExitCode,
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
	})
}

func (s *Server) handleHTTP(response http.ResponseWriter, request *http.Request) {
	var input HTTPRequest
	if err := decodeJSON(request.Body, &input); err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	method := strings.ToUpper(input.Method)
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodPut && method != http.MethodPatch && method != http.MethodDelete {
		writeError(response, http.StatusBadRequest, fmt.Errorf("HTTP method is not supported"))
		return
	}
	if !strings.HasPrefix(input.Path, "/") || strings.HasPrefix(input.Path, "//") || strings.ContainsAny(input.Path, "\r\n") {
		writeError(response, http.StatusBadRequest, fmt.Errorf("HTTP path is invalid"))
		return
	}
	target := fmt.Sprintf("http://127.0.0.1:%d%s", s.config.GatewayPort, input.Path)
	upstreamRequest, err := http.NewRequestWithContext(request.Context(), method, target, strings.NewReader(input.Body))
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	for name, value := range input.Headers {
		if strings.EqualFold(name, "Host") || strings.ContainsAny(name+value, "\r\n") {
			writeError(response, http.StatusBadRequest, fmt.Errorf("HTTP header is not allowed"))
			return
		}
		upstreamRequest.Header.Set(name, value)
	}
	upstreamResponse, err := s.httpClient.Do(upstreamRequest)
	if err != nil {
		writeError(response, http.StatusBadGateway, err)
		return
	}
	defer upstreamResponse.Body.Close()
	body, err := io.ReadAll(io.LimitReader(upstreamResponse.Body, 10<<20))
	if err != nil {
		writeError(response, http.StatusBadGateway, err)
		return
	}
	writeJSON(response, http.StatusOK, HTTPResponse{
		Status:  upstreamResponse.StatusCode,
		Headers: upstreamResponse.Header,
		Body:    string(body),
	})
}

func (s *Server) composeArgs() []string {
	return []string{
		"compose",
		"-f", filepath.Join(s.config.PlatformDir(), "docker-compose.yml"),
		"-f", filepath.Join(s.config.PlatformDir(), "sandbox.override.yml"),
	}
}

func (s *Server) streamCommand(ctx context.Context, output io.Writer, name string, args ...string) {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdout = output
	command.Stderr = output
	_ = command.Run()
}

func parseTail(value string) (int, error) {
	if value == "" {
		return 200, nil
	}
	tail, err := strconv.Atoi(value)
	if err != nil || tail < 1 || tail > 10000 {
		return 0, fmt.Errorf("tail must be between 1 and 10000")
	}
	return tail, nil
}

func decodeJSON(reader io.Reader, destination any) error {
	decoder := json.NewDecoder(io.LimitReader(reader, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid JSON request: %w", err)
	}
	return nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, err error) {
	writeJSON(response, status, map[string]string{"error": err.Error()})
}
