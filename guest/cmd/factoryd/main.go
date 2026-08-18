package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/saleor/saleor-factory/guest/internal/factoryd"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return fmt.Errorf("usage: factoryd <serve|provision|status|logs|exec|http|version>")
	}
	config := factoryd.DefaultConfig()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch arguments[0] {
	case "serve":
		return factoryd.NewServer(config).Serve(ctx)
	case "provision":
		return provision(ctx, config, arguments[1:])
	case "status":
		return status(ctx, config)
	case "logs":
		return logs(ctx, config, arguments[1:])
	case "exec":
		return execute(ctx, config, arguments[1:])
	case "http":
		return httpRequest(ctx, config, arguments[1:])
	case "version":
		fmt.Println(version)
		return nil
	default:
		return fmt.Errorf("unknown factoryd command: %s", arguments[0])
	}
}

func provision(ctx context.Context, config factoryd.Config, arguments []string) error {
	flags := flag.NewFlagSet("provision", flag.ContinueOnError)
	jobPath := flags.String("job", "-", "job JSON file, or - for standard input")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	var reader io.Reader = os.Stdin
	if *jobPath != "-" {
		file, err := os.Open(*jobPath)
		if err != nil {
			return err
		}
		defer file.Close()
		reader = file
	}
	var job factoryd.Job
	decoder := json.NewDecoder(io.LimitReader(reader, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&job); err != nil {
		return fmt.Errorf("invalid job: %w", err)
	}
	result, err := factoryd.NewClient(config.SocketPath).Provision(ctx, job)
	if err != nil {
		return err
	}
	return printJSON(result)
}

func status(ctx context.Context, config factoryd.Config) error {
	result, err := factoryd.NewClient(config.SocketPath).Status(ctx)
	if err != nil {
		return err
	}
	return printJSON(result)
}

func logs(ctx context.Context, config factoryd.Config, arguments []string) error {
	flags := flag.NewFlagSet("logs", flag.ContinueOnError)
	service := flags.String("service", "", "Saleor service name")
	phase := flags.String("phase", "", "use provision for setup logs")
	follow := flags.Bool("follow", false, "follow new log lines")
	tail := flags.Int("tail", 200, "number of existing lines")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	return factoryd.NewClient(config.SocketPath).Logs(ctx, os.Stdout, *service, *phase, *follow, *tail)
}

func execute(ctx context.Context, config factoryd.Config, arguments []string) error {
	flags := flag.NewFlagSet("exec", flag.ContinueOnError)
	service := flags.String("service", "api", "Saleor service name")
	requestPath := flags.String("request", "", "request JSON file, or - for standard input")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	input := factoryd.ExecRequest{Service: *service, Command: flags.Args()}
	if len(input.Command) > 0 && input.Command[0] == "--" {
		input.Command = input.Command[1:]
	}
	if *requestPath != "" {
		if err := readJSONInput(*requestPath, &input); err != nil {
			return err
		}
	}
	result, err := factoryd.NewClient(config.SocketPath).Exec(ctx, input)
	if err != nil {
		return err
	}
	if err := printJSON(result); err != nil {
		return err
	}
	return nil
}

func httpRequest(ctx context.Context, config factoryd.Config, arguments []string) error {
	flags := flag.NewFlagSet("http", flag.ContinueOnError)
	method := flags.String("method", "GET", "HTTP method")
	path := flags.String("path", "/", "gateway path")
	body := flags.String("body", "", "request body")
	contentType := flags.String("content-type", "application/json", "request content type")
	requestPath := flags.String("request", "", "request JSON file, or - for standard input")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	input := factoryd.HTTPRequest{
		Method:  strings.ToUpper(*method),
		Path:    *path,
		Headers: map[string]string{"Content-Type": *contentType},
		Body:    *body,
	}
	if *requestPath != "" {
		if err := readJSONInput(*requestPath, &input); err != nil {
			return err
		}
	}
	result, err := factoryd.NewClient(config.SocketPath).HTTP(ctx, input)
	if err != nil {
		return err
	}
	return printJSON(result)
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func readJSONInput(path string, destination any) error {
	var reader io.Reader = os.Stdin
	if path != "-" {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		reader = file
	}
	decoder := json.NewDecoder(io.LimitReader(reader, 10<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid request: %w", err)
	}
	return nil
}
