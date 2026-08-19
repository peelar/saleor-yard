package yardd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Provisioner struct {
	config  Config
	store   *StatusStore
	mu      sync.Mutex
	running bool
}

func NewProvisioner(config Config, store *StatusStore) *Provisioner {
	return &Provisioner{config: config, store: store}
}

func (p *Provisioner) Start(job Job) error {
	if err := ValidateJob(job); err != nil {
		return err
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return fmt.Errorf("provisioning is already running")
	}
	p.running = true
	go func() {
		defer func() {
			p.mu.Lock()
			p.running = false
			p.mu.Unlock()
		}()
		p.run(job)
	}()
	return nil
}

func (p *Provisioner) run(job Job) {
	if err := os.MkdirAll(p.config.StateDir, 0o700); err != nil {
		_ = p.store.Write(NewStatus("failed", "allocating_environment", job.Commit, err.Error()))
		return
	}
	logFile, err := os.OpenFile(p.config.ProvisionLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		_ = p.store.Write(NewStatus("failed", "allocating_environment", job.Commit, err.Error()))
		return
	}
	defer logFile.Close()

	ctx := context.Background()
	phase := "allocating_environment"
	fail := func(cause error) {
		message := fmt.Sprintf("Provisioning failed during %s. Read the provisioning log for details.", phase)
		_, _ = fmt.Fprintf(logFile, "\nERROR: %v\n", cause)
		_ = p.store.Write(NewStatus("failed", phase, job.Commit, message))
	}
	setPhase := func(next string) error {
		phase = next
		_, _ = fmt.Fprintf(logFile, "\n[%s] %s\n", time.Now().UTC().Format(time.RFC3339), phase)
		return p.store.Write(NewStatus("provisioning", phase, job.Commit, ""))
	}
	run := func(name string, args ...string) error {
		_, _ = fmt.Fprintf(logFile, "$ %s %s\n", name, strings.Join(args, " "))
		_, commandError := p.config.CommandRunner.Run(ctx, logFile, logFile, name, args...)
		return commandError
	}

	if err := setPhase("allocating_environment"); err != nil {
		fail(err)
		return
	}
	for _, command := range [][]string{{"git", "--version"}, {"docker", "version"}, {"docker", "compose", "version"}} {
		if err := run(command[0], command[1:]...); err != nil {
			fail(err)
			return
		}
	}

	if err := setPhase("building_core"); err != nil {
		fail(err)
		return
	}
	if err := os.RemoveAll(p.config.SaleorDir()); err != nil {
		fail(err)
		return
	}
	if err := run("git", "init", p.config.SaleorDir()); err != nil {
		fail(err)
		return
	}
	if err := run("git", "-C", p.config.SaleorDir(), "remote", "add", "origin", job.CloneURL); err != nil {
		fail(err)
		return
	}
	if err := run("git", "-C", p.config.SaleorDir(), "fetch", "--depth=1", "origin", job.SourceRef); err != nil {
		fail(err)
		return
	}
	fetched, err := p.output(ctx, "git", "-C", p.config.SaleorDir(), "rev-parse", "FETCH_HEAD")
	if err != nil {
		fail(err)
		return
	}
	if strings.TrimSpace(fetched) != job.Commit {
		if err := run("git", "-C", p.config.SaleorDir(), "fetch", "--depth=1", "origin", job.Commit); err != nil {
			fail(fmt.Errorf("the source ref moved and the exact commit could not be fetched: %w", err))
			return
		}
		fetched, err = p.output(ctx, "git", "-C", p.config.SaleorDir(), "rev-parse", "FETCH_HEAD")
		if err != nil || strings.TrimSpace(fetched) != job.Commit {
			fail(fmt.Errorf("fetched source does not match requested commit"))
			return
		}
	}
	if err := run("git", "-C", p.config.SaleorDir(), "checkout", "--detach", job.Commit); err != nil {
		fail(err)
		return
	}

	if err := os.RemoveAll(p.config.PlatformDir()); err != nil {
		fail(err)
		return
	}
	if err := run("git", "init", p.config.PlatformDir()); err != nil {
		fail(err)
		return
	}
	if err := run("git", "-C", p.config.PlatformDir(), "remote", "add", "origin", "https://github.com/saleor/saleor-platform.git"); err != nil {
		fail(err)
		return
	}
	if err := run("git", "-C", p.config.PlatformDir(), "fetch", "--depth=1", "origin", job.PlatformCommit); err != nil {
		fail(err)
		return
	}
	if err := run("git", "-C", p.config.PlatformDir(), "checkout", "--detach", job.PlatformCommit); err != nil {
		fail(err)
		return
	}
	if err := run("docker", "build", "--tag", "saleor-yard-core:"+job.Commit, p.config.SaleorDir()); err != nil {
		fail(err)
		return
	}
	pruneBuilderCache(ctx, p.config.CommandRunner, logFile)

	if err := os.WriteFile(filepath.Join(p.config.PlatformDir(), "yard.nginx.conf"), []byte(nginxConfiguration(job)), 0o644); err != nil {
		fail(err)
		return
	}
	if err := os.WriteFile(filepath.Join(p.config.PlatformDir(), "yard.override.yml"), []byte(composeOverride(job)), 0o644); err != nil {
		fail(err)
		return
	}

	if err := setPhase("migrating_database"); err != nil {
		fail(err)
		return
	}
	if err := run("docker", append(p.composeArgs(), "up", "-d", "db", "cache", "jaeger", "mailpit")...); err != nil {
		fail(err)
		return
	}
	if err := p.waitForPostgres(ctx, logFile); err != nil {
		fail(err)
		return
	}
	if err := run("docker", append(p.composeArgs(), "run", "--rm", "api", "python3", "manage.py", "migrate")...); err != nil {
		fail(err)
		return
	}

	if err := setPhase("seeding_database"); err != nil {
		fail(err)
		return
	}
	if err := run("docker", append(p.composeArgs(), "run", "--rm", "api", "python3", "manage.py", "populatedb", "--createsuperuser")...); err != nil {
		fail(err)
		return
	}

	if err := setPhase("starting_services"); err != nil {
		fail(err)
		return
	}
	if err := run("docker", append(p.composeArgs(), "up", "-d")...); err != nil {
		fail(err)
		return
	}

	if err := setPhase("checking_readiness"); err != nil {
		fail(err)
		return
	}
	if err := p.waitForReadiness(ctx, logFile); err != nil {
		fail(err)
		return
	}

	_, _ = fmt.Fprintf(logFile, "\nSaleor environment is ready.\n")
	_ = p.store.Write(NewStatus("ready", "ready", job.Commit, ""))
}

func pruneBuilderCache(ctx context.Context, runner Runner, log io.Writer) {
	_, _ = fmt.Fprintln(log, "$ docker builder prune --force")
	if _, err := runner.Run(ctx, log, log, "docker", "builder", "prune", "--force"); err != nil {
		_, _ = fmt.Fprintf(log, "WARNING: Docker build cache could not be removed: %v\n", err)
	}
}

func (p *Provisioner) waitForPostgres(ctx context.Context, log io.Writer) error {
	for attempt := 1; attempt <= 60; attempt++ {
		args := append(p.composeArgs(), "exec", "-T", "db", "pg_isready", "-U", "saleor")
		if _, err := p.config.CommandRunner.Run(ctx, io.Discard, io.Discard, "docker", args...); err == nil {
			return nil
		}
		_, _ = fmt.Fprintf(log, "Postgres readiness attempt %d/60 failed.\n", attempt)
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("Postgres did not become ready within two minutes")
}

func (p *Provisioner) output(ctx context.Context, name string, args ...string) (string, error) {
	result, err := p.config.CommandRunner.Run(ctx, io.Discard, io.Discard, name, args...)
	return result.Stdout, err
}

func (p *Provisioner) composeArgs() []string {
	return []string{
		"compose",
		"-f", filepath.Join(p.config.PlatformDir(), "docker-compose.yml"),
		"-f", filepath.Join(p.config.PlatformDir(), "yard.override.yml"),
	}
}

func (p *Provisioner) waitForReadiness(ctx context.Context, log io.Writer) error {
	client := &http.Client{Timeout: 10 * time.Second}
	query := strings.NewReader(`{"query":"{ shop { name } }"}`)
	for attempt := 1; attempt <= 60; attempt++ {
		request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:8000/graphql/", query)
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err == nil {
			var body struct {
				Data struct {
					Shop *struct {
						Name string `json:"name"`
					} `json:"shop"`
				} `json:"data"`
			}
			decodeError := json.NewDecoder(response.Body).Decode(&body)
			response.Body.Close()
			if response.StatusCode == http.StatusOK && decodeError == nil && body.Data.Shop != nil {
				return p.waitForURLs(ctx, client, []string{"http://127.0.0.1:9000/", "http://127.0.0.1:8080/"})
			}
		}
		_, _ = fmt.Fprintf(log, "GraphQL readiness attempt %d/60 failed.\n", attempt)
		time.Sleep(5 * time.Second)
		query = strings.NewReader(`{"query":"{ shop { name } }"}`)
	}
	return fmt.Errorf("GraphQL did not become ready within five minutes")
}

func (p *Provisioner) waitForURLs(ctx context.Context, client *http.Client, urls []string) error {
	for _, target := range urls {
		ready := false
		for attempt := 1; attempt <= 30; attempt++ {
			request, _ := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
			response, err := client.Do(request)
			if err == nil {
				response.Body.Close()
				if response.StatusCode >= 200 && response.StatusCode < 500 {
					ready = true
					break
				}
			}
			time.Sleep(2 * time.Second)
		}
		if !ready {
			return fmt.Errorf("%s did not become ready", target)
		}
	}
	return nil
}
