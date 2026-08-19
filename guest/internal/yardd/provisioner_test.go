package yardd

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestPruneBuilderCacheRemovesUnusedBuildData(t *testing.T) {
	t.Parallel()
	runner := &fakeRunner{}
	var log bytes.Buffer

	pruneBuilderCache(context.Background(), runner, &log)

	if len(runner.calls) != 1 {
		t.Fatalf("expected one command, got %d", len(runner.calls))
	}
	call := runner.calls[0]
	if call.name != "docker" || strings.Join(call.args, " ") != "builder prune --force" {
		t.Fatalf("unexpected cache cleanup command: %s %v", call.name, call.args)
	}
}

func TestPruneBuilderCacheDoesNotFailProvisioning(t *testing.T) {
	t.Parallel()
	runner := &fakeRunner{errors: []error{errors.New("prune unavailable")}}
	var log bytes.Buffer

	pruneBuilderCache(context.Background(), runner, &log)

	if !strings.Contains(log.String(), "WARNING: Docker build cache could not be removed") {
		t.Fatalf("expected a cleanup warning, got %q", log.String())
	}
}
