package sandboxd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
)

type RunResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

type Runner interface {
	Run(ctx context.Context, stdout, stderr io.Writer, name string, args ...string) (RunResult, error)
}

type OSRunner struct{}

func (OSRunner) Run(
	ctx context.Context,
	stdout io.Writer,
	stderr io.Writer,
	name string,
	args ...string,
) (RunResult, error) {
	var stdoutBuffer bytes.Buffer
	var stderrBuffer bytes.Buffer
	command := exec.CommandContext(ctx, name, args...)
	command.Stdout = io.MultiWriter(stdout, &stdoutBuffer)
	command.Stderr = io.MultiWriter(stderr, &stderrBuffer)
	err := command.Run()

	result := RunResult{
		ExitCode: 0,
		Stdout:   stdoutBuffer.String(),
		Stderr:   stderrBuffer.String(),
	}
	if err == nil {
		return result, nil
	}

	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.ExitCode = exitError.ExitCode()
		return result, fmt.Errorf("%s exited with code %d", name, result.ExitCode)
	}
	result.ExitCode = 1
	return result, err
}
