package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A stand-in must tell the truth about itself. These are the Go twins of the
// Python rules in tests/test_standin_honesty.py.
//
// Before this: a local server's 401 fell through to the generic stub, so the
// record read "[offline:local:…] handled: <prompt>" — an outage — while the
// Python gateway for the same 401 says "[rejected:local:…] provider refused
// the request (HTTP 401): API key required" — the fix. And the stub reported
// 8–47 output tokens, hash-derived, for a reply that never came.

func statusServer(t *testing.T, status int, body any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func localGateway(srvURL string, client *http.Client) *Gateway {
	g := newGateway()
	g.localBaseURL = srvURL
	g.localKey = "wrong-key"
	g.client = client
	return g
}

var ask = []message{{"role": "user", "content": "summarise the new notes"}}

func TestARefusedCallIsNamedNotStubbed(t *testing.T) {
	srv := statusServer(t, http.StatusUnauthorized, map[string]any{"detail": "API key required"})
	g := localGateway(srv.URL, srv.Client())
	text, _, tout, isReal, _ := g.invoke(ask, roundTrip(t, g.Route("summarise the new notes", local)))

	if isReal {
		t.Fatalf("a 401 is not a completion: %q", text)
	}
	if !strings.HasPrefix(text, "[rejected:local:") {
		t.Fatalf("a 401 is the server refusing the request, not an outage; got %q", text)
	}
	if !strings.Contains(text, "HTTP 401") || !strings.Contains(text, "API key required") {
		t.Fatalf("the refusal must carry the status and the server's own words; got %q", text)
	}
	if tout != 0 {
		t.Fatalf("no reply came back, yet %d output tokens were reported", tout)
	}
}

func TestTheStubReportsNoOutputTokens(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	dead.Close() // nothing listens here any more
	g := localGateway(dead.URL, &http.Client{Timeout: time.Second})
	text, _, tout, isReal, _ := g.invoke(ask, roundTrip(t, g.Route("summarise the new notes", local)))

	if isReal || !strings.HasPrefix(text, "[offline:") {
		t.Fatalf("an unreachable server is the offline stand-in; got real=%v %q", isReal, text)
	}
	if tout != 0 {
		t.Fatalf("the stub reported %d output tokens for a reply that never came", tout)
	}
}

func TestAServerErrorIsStillAnOutage(t *testing.T) {
	// 5xx (and the retryable 429) are the provider failing, not refusing what
	// we sent — the same line gateway.py draws with RETRY_STATUSES.
	for _, status := range []int{http.StatusServiceUnavailable, http.StatusTooManyRequests} {
		srv := statusServer(t, status, map[string]any{"error": "try later"})
		g := localGateway(srv.URL, srv.Client())
		text, _, _, _, _ := g.invoke(ask, roundTrip(t, g.Route("summarise the new notes", local)))
		if !strings.HasPrefix(text, "[offline:") {
			t.Fatalf("HTTP %d must stay an outage stand-in, got %q", status, text)
		}
	}
}
