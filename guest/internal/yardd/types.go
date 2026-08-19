package yardd

import "time"

type Job struct {
	EnvironmentID  string `json:"environmentId"`
	CloneURL       string `json:"cloneUrl"`
	SourceRef      string `json:"sourceRef"`
	Commit         string `json:"commit"`
	PlatformCommit string `json:"platformCommit"`
	DashboardTag   string `json:"dashboardTag"`
	PrivateURL     string `json:"privateUrl"`
}

type Status struct {
	State     string `json:"state"`
	Phase     string `json:"phase"`
	UpdatedAt string `json:"updatedAt"`
	Commit    string `json:"commit,omitempty"`
	Error     string `json:"error,omitempty"`
}

func NewStatus(state, phase, commit, message string) Status {
	return Status{
		State:     state,
		Phase:     phase,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Commit:    commit,
		Error:     message,
	}
}

type ExecRequest struct {
	Service string   `json:"service"`
	Command []string `json:"command"`
}

type ExecResponse struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

type HTTPRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

type HTTPResponse struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
	Body    string              `json:"body"`
}
