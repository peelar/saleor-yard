package sandboxd

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

var (
	environmentIDPattern = regexp.MustCompile(`^env_[a-z0-9_]+$`)
	commitPattern        = regexp.MustCompile(`^[a-f0-9]{40}$`)
	cloneURLPattern      = regexp.MustCompile(`^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$`)
	refPattern           = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`)
	dashboardTagPattern  = regexp.MustCompile(`^[0-9]+\.[0-9]+(?:\.[0-9]+)?$`)
)

func ValidateJob(job Job) error {
	if !environmentIDPattern.MatchString(job.EnvironmentID) {
		return fmt.Errorf("environment ID is invalid")
	}
	if !cloneURLPattern.MatchString(job.CloneURL) {
		return fmt.Errorf("clone URL must be a public GitHub HTTPS URL")
	}
	if !commitPattern.MatchString(job.Commit) || !commitPattern.MatchString(job.PlatformCommit) {
		return fmt.Errorf("source and platform commits must be full lowercase commit SHAs")
	}
	if !refPattern.MatchString(job.SourceRef) || strings.Contains(job.SourceRef, "..") || strings.Contains(job.SourceRef, "@{") {
		return fmt.Errorf("source ref is invalid")
	}
	if !dashboardTagPattern.MatchString(job.DashboardTag) {
		return fmt.Errorf("dashboard tag is invalid")
	}
	parsed, err := url.Parse(job.PrivateURL)
	if err != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("private URL must be an allowed origin")
	}
	isExeDev := parsed.Scheme == "https" && strings.HasSuffix(parsed.Hostname(), ".exe.xyz")
	isLocal := parsed.Scheme == "http" && (parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost") && parsed.Port() != ""
	if !isExeDev && !isLocal {
		return fmt.Errorf("private URL must use a private exe.dev domain or a local forwarded port")
	}
	return nil
}

func ValidateService(service string) error {
	allowed := map[string]bool{
		"api": true, "worker": true, "db": true, "cache": true,
		"dashboard": true, "gateway": true, "mailpit": true, "jaeger": true,
	}
	if !allowed[service] {
		return fmt.Errorf("unknown Saleor service: %s", service)
	}
	return nil
}
