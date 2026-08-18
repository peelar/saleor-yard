package factoryd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type runnerCall struct {
	name string
	args []string
}

type fakeRunner struct {
	mu      sync.Mutex
	calls   []runnerCall
	results []RunResult
	errors  []error
}

func (f *fakeRunner) Run(
	_ context.Context,
	stdout io.Writer,
	stderr io.Writer,
	name string,
	args ...string,
) (RunResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, runnerCall{name: name, args: append([]string(nil), args...)})
	var result RunResult
	if len(f.results) > 0 {
		result = f.results[0]
		f.results = f.results[1:]
	}
	var err error
	if len(f.errors) > 0 {
		err = f.errors[0]
		f.errors = f.errors[1:]
	}
	_, _ = io.WriteString(stdout, result.Stdout)
	_, _ = io.WriteString(stderr, result.Stderr)
	return result, err
}

func testConfig(t *testing.T, runner Runner) Config {
	t.Helper()
	root := t.TempDir()
	return Config{
		RootDir:       filepath.Join(root, "factory"),
		StateDir:      filepath.Join(root, "state"),
		SocketPath:    filepath.Join(root, "run", "factoryd.sock"),
		GatewayPort:   8080,
		CommandRunner: runner,
	}
}

func TestStatusEndpointReturnsDefaultState(t *testing.T) {
	t.Parallel()
	server := NewServer(testConfig(t, &fakeRunner{}))
	request := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	var status Status
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.State != "requested" {
		t.Fatalf("unexpected body: %#v", status)
	}
}

func TestProvisionEndpointRejectsUnknownAndUnsafeFields(t *testing.T) {
	t.Parallel()
	server := NewServer(testConfig(t, &fakeRunner{}))
	for name, body := range map[string]string{
		"unknown field": `{"environmentId":"env_ok","unexpected":true}`,
		"unsafe job":    `{"environmentId":"../../secret"}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/v1/provision", bytes.NewBufferString(body))
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d", response.Code)
			}
		})
	}
}

func TestExecUsesTypedArguments(t *testing.T) {
	t.Parallel()
	runner := &fakeRunner{results: []RunResult{{ExitCode: 7, Stdout: "out", Stderr: "err"}}}
	server := NewServer(testConfig(t, runner))
	body := `{"service":"api","command":["python","manage.py","check; touch /tmp/unsafe"]}`
	request := httptest.NewRequest(http.MethodPost, "/v1/exec", bytes.NewBufferString(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	runner.mu.Lock()
	call := runner.calls[0]
	runner.mu.Unlock()
	if call.name != "docker" {
		t.Fatalf("unexpected executable: %s", call.name)
	}
	last := call.args[len(call.args)-1]
	if last != "check; touch /tmp/unsafe" {
		t.Fatalf("command argument was changed: %q", last)
	}
	var result ExecResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 7 {
		t.Fatalf("expected exit code 7, got %d", result.ExitCode)
	}
}

func TestHTTPProxyKeepsTargetOnLocalGateway(t *testing.T) {
	t.Parallel()
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/graphql/" {
			t.Errorf("unexpected path: %s", request.URL.Path)
		}
		response.Header().Set("X-Test", "yes")
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte("ok"))
	}))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	upstream.Listener = listener
	upstream.Start()
	defer upstream.Close()

	config := testConfig(t, &fakeRunner{})
	config.GatewayPort = listener.Addr().(*net.TCPAddr).Port
	server := NewServer(config)
	body := `{"method":"POST","path":"/graphql/","body":"{}"}`
	request := httptest.NewRequest(http.MethodPost, "/v1/http", bytes.NewBufferString(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	var result HTTPResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Status != http.StatusCreated || result.Body != "ok" {
		t.Fatalf("unexpected proxy result: %#v", result)
	}
}

func TestProvisionerRecordsAPlainFailure(t *testing.T) {
	t.Parallel()
	runner := &fakeRunner{errors: []error{errors.New("git is missing")}}
	config := testConfig(t, runner)
	store := NewStatusStore(config.StatusPath())
	provisioner := NewProvisioner(config, store)
	if err := provisioner.Start(validJob()); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status, err := store.Read()
		if err != nil {
			t.Fatal(err)
		}
		if status.State == "failed" {
			if status.Phase != "provisioning_vm" {
				t.Fatalf("unexpected failure phase: %s", status.Phase)
			}
			if status.Error == "" {
				t.Fatal("failure should explain where to find details")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("provisioner did not record its failure")
}
