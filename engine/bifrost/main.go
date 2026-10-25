// Command bifrostd is the REAL Bifrost gateway for SC Prism (ADR-002/026):
// Bifrost embedded as a supervised subprocess over a Unix domain socket.
//
// It listens on a UDS (path from argv[1] or $SCPRISM_BIFROST_SOCKET) speaking a
// newline-delimited JSON protocol — one JSON request per line, one JSON
// response per line:
//
//	{"op":"ping"}                                  -> {"ok":true}
//	{"op":"route","intent":"..."}                  -> RouteDecision
//	{"op":"model_call","messages":[...],"route":{...},"providers":{...}}
//	                                               -> ModelCallResult
//
// It takes over the ROLE of engine/scprism_engine/gateway.py: sensitivity
// routing, prompt + semantic cache, real OpenAI-compatible calls, and a
// deterministic offline stub. Graceful shutdown on SIGINT/SIGTERM.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

// request is a single protocol frame. Only the fields relevant to the op need
// be present.
type request struct {
	Op     string `json:"op"`
	Intent string `json:"intent"`
	// Hint is the OPTIONAL per-message route REQUEST ("local" | "cloud"); an
	// empty string means no hint (byte-identical to before route hints existed).
	// The daemon stays authoritative — it honors the hint only within its
	// sensitivity floor (see Gateway.Route), mirroring the Python gateway.
	Hint      string                  `json:"hint"`
	Messages  []message               `json:"messages"`
	Route     *RouteDecision          `json:"route"`
	Providers map[string]providerConf `json:"providers"`
}

func socketPath() (string, error) {
	if len(os.Args) > 1 && os.Args[1] != "" {
		return os.Args[1], nil
	}
	if p := os.Getenv("SCPRISM_BIFROST_SOCKET"); p != "" {
		return p, nil
	}
	return "", fmt.Errorf("no socket path: pass it as argv[1] or $SCPRISM_BIFROST_SOCKET")
}

func main() {
	path, err := socketPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, "bifrostd:", err)
		os.Exit(2)
	}
	// A stale socket file from a crashed predecessor would block Listen.
	_ = os.Remove(path)

	ln, err := net.Listen("unix", path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bifrostd: listen:", err)
		os.Exit(1)
	}

	gw := NewGatewayFromEnv()

	// Graceful shutdown: on SIGINT/SIGTERM close the listener (unblocking
	// Accept) and remove the socket file, then exit 0.
	var once sync.Once
	shutdown := func() {
		once.Do(func() {
			_ = ln.Close()
			_ = os.Remove(path)
		})
	}
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		shutdown()
	}()

	// Signal readiness on stderr so a supervisor can also gate on it (the
	// Python client gates on a ping, but this is a cheap extra signal).
	fmt.Fprintf(os.Stderr, "bifrostd: listening on %s\n", path)

	var wg sync.WaitGroup
	for {
		conn, err := ln.Accept()
		if err != nil {
			// Listener closed by shutdown -> drain in-flight conns and exit.
			wg.Wait()
			return
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			handleConn(conn, gw)
		}()
	}
}

// handleConn services one connection: many newline-delimited requests, each
// answered with one newline-delimited response.
func handleConn(conn net.Conn, gw *Gateway) {
	defer conn.Close()
	reader := bufio.NewReaderSize(conn, 1<<20)
	writer := bufio.NewWriter(conn)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			resp := dispatch(gw, line)
			out, mErr := json.Marshal(resp)
			if mErr != nil {
				out, _ = json.Marshal(map[string]any{"error": mErr.Error()})
			}
			out = append(out, '\n')
			if _, wErr := writer.Write(out); wErr != nil {
				return
			}
			if fErr := writer.Flush(); fErr != nil {
				return
			}
		}
		if err != nil {
			return // EOF or read error -> client hung up
		}
	}
}

// dispatch parses one request frame and returns the response value to marshal.
func dispatch(gw *Gateway, line []byte) any {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return map[string]any{"error": "bad json: " + err.Error()}
	}
	switch req.Op {
	case "ping":
		return map[string]any{"ok": true}
	case "route":
		return gw.Route(req.Intent, req.Hint)
	case "model_call":
		if req.Route == nil {
			return map[string]any{"error": "model_call requires a route"}
		}
		return gw.ModelCall(req.Messages, *req.Route)
	default:
		return map[string]any{"error": "unknown op: " + req.Op}
	}
}
