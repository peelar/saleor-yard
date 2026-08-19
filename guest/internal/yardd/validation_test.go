package yardd

import "testing"

func validJob() Job {
	return Job{
		EnvironmentID:  "env_20260818120000_abc123",
		CloneURL:       "https://github.com/saleor/saleor.git",
		SourceRef:      "main",
		Commit:         "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		PlatformCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		DashboardTag:   "3.23",
		PrivateURL:     "http://127.0.0.1:28080",
	}
}

func TestValidateJob(t *testing.T) {
	t.Parallel()
	if err := ValidateJob(validJob()); err != nil {
		t.Fatalf("valid job was rejected: %v", err)
	}
}

func TestValidateJobRejectsUnsafeInput(t *testing.T) {
	t.Parallel()
	tests := map[string]func(*Job){
		"environment path traversal": func(job *Job) { job.EnvironmentID = "../../secret" },
		"credential clone URL":       func(job *Job) { job.CloneURL = "https://token@github.com/saleor/saleor.git" },
		"non GitHub clone URL":       func(job *Job) { job.CloneURL = "https://example.com/saleor/saleor.git" },
		"short commit":               func(job *Job) { job.Commit = "abc123" },
		"moving ref expression":      func(job *Job) { job.SourceRef = "main@{1}" },
		"shell metacharacter in ref": func(job *Job) { job.SourceRef = "main;shutdown" },
		"image injection":            func(job *Job) { job.DashboardTag = "3.23;touch" },
		"remote HTTP URL":            func(job *Job) { job.PrivateURL = "http://remote.example.com:8080" },
		"remote HTTPS URL":           func(job *Job) { job.PrivateURL = "https://remote.example.com" },
		"local URL without port":     func(job *Job) { job.PrivateURL = "http://localhost" },
		"wrong private host":         func(job *Job) { job.PrivateURL = "https://attacker.example.com" },
	}

	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			job := validJob()
			mutate(&job)
			if err := ValidateJob(job); err == nil {
				t.Fatal("unsafe job was accepted")
			}
		})
	}
}

func TestValidateService(t *testing.T) {
	t.Parallel()
	if err := ValidateService("api"); err != nil {
		t.Fatalf("api should be valid: %v", err)
	}
	if err := ValidateService("api; shutdown"); err == nil {
		t.Fatal("unsafe service was accepted")
	}
}
