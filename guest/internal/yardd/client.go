package yardd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
)

type Client struct {
	httpClient *http.Client
}

func NewClient(socketPath string) *Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		},
	}
	return &Client{httpClient: &http.Client{Transport: transport}}
}

func (c *Client) Provision(ctx context.Context, job Job) (Status, error) {
	var status Status
	err := c.jsonRequest(ctx, http.MethodPost, "/v1/provision", job, &status)
	return status, err
}

func (c *Client) Status(ctx context.Context) (Status, error) {
	var status Status
	err := c.jsonRequest(ctx, http.MethodGet, "/v1/status", nil, &status)
	return status, err
}

func (c *Client) Exec(ctx context.Context, input ExecRequest) (ExecResponse, error) {
	var result ExecResponse
	err := c.jsonRequest(ctx, http.MethodPost, "/v1/exec", input, &result)
	return result, err
}

func (c *Client) HTTP(ctx context.Context, input HTTPRequest) (HTTPResponse, error) {
	var result HTTPResponse
	err := c.jsonRequest(ctx, http.MethodPost, "/v1/http", input, &result)
	return result, err
}

func (c *Client) Logs(ctx context.Context, output io.Writer, service, phase string, follow bool, tail int) error {
	query := url.Values{}
	query.Set("tail", strconv.Itoa(tail))
	query.Set("follow", strconv.FormatBool(follow))
	if service != "" {
		query.Set("service", service)
	}
	if phase != "" {
		query.Set("phase", phase)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://yardd/v1/logs?"+query.Encode(), nil)
	if err != nil {
		return err
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return fmt.Errorf("yardd returned HTTP %d: %s", response.StatusCode, body)
	}
	_, err = io.Copy(output, response.Body)
	return err
}

func (c *Client) jsonRequest(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://yardd"+path, body)
	if err != nil {
		return err
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return fmt.Errorf("yardd returned HTTP %d: %s", response.StatusCode, data)
	}
	if output == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(output)
}
