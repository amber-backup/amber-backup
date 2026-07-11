package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client is a thin HTTP wrapper around the Amber Backup REST API.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// NewClient builds a client for the given server base URL (without the /api
// prefix) and API key.
func NewClient(cfg *Config) *Client {
	return &Client{
		baseURL: cfg.URL,
		apiKey:  cfg.APIKey,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// apiError carries the server's error payload for a non-2xx response.
type apiError struct {
	status  int
	message string
}

func (e *apiError) Error() string {
	if e.message == "" {
		return fmt.Sprintf("server returned %d", e.status)
	}
	return fmt.Sprintf("server returned %d: %s", e.status, e.message)
}

// do issues a request against /api<path> and returns the raw response body for
// 2xx responses, or an *apiError otherwise.
func (c *Client) do(method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		reader = bytes.NewReader(buf)
	}

	req, err := http.NewRequest(method, c.baseURL+"/api"+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, &apiError{status: resp.StatusCode, message: extractMessage(data)}
	}
	return data, nil
}

// extractMessage pulls a human-readable message out of a NestJS error body
// (`{ statusCode, message, error }`, where message may be a string or array).
func extractMessage(data []byte) string {
	var payload struct {
		Message json.RawMessage `json:"message"`
		Error   string          `json:"error"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return string(bytes.TrimSpace(data))
	}

	if len(payload.Message) > 0 {
		var s string
		if json.Unmarshal(payload.Message, &s) == nil {
			return s
		}
		var arr []string
		if json.Unmarshal(payload.Message, &arr) == nil {
			out := ""
			for i, m := range arr {
				if i > 0 {
					out += "; "
				}
				out += m
			}
			return out
		}
	}
	return payload.Error
}

// getJSON performs a GET and decodes the JSON body into a generic value.
func (c *Client) getJSON(path string) (any, error) {
	data, err := c.do(http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return v, nil
}

// postJSON performs a POST (optionally with a body) and decodes the response.
func (c *Client) postJSON(path string, body any) (any, error) {
	data, err := c.do(http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return v, nil
}
