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

// Seen in the app 2026-11-08: an agent's proof on the local model closed after
// 2003 ms with "local returned no completion" while oMLX was still LOADING the
// model (9.4 s). The call had timed out — but the stub said "handled: <prompt>",
// which names nothing, so the seat could not say why. A bound we enforced is a
// cause we can name, as gateway.py does ("did not answer within 180s").
func TestATimeoutIsNamedAsOne(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(slow.Close)
	g := localGateway(slow.URL, &http.Client{Timeout: 50 * time.Millisecond})
	text, _, tout, isReal, _ := g.invoke(ask, roundTrip(t, g.Route("summarise the new notes", local)))

	if isReal || tout != 0 {
		t.Fatalf("a call that timed out is not a completion: real=%v tout=%d %q", isReal, tout, text)
	}
	if !strings.HasPrefix(text, "[offline:local:") {
		t.Fatalf("a timeout is still the offline stand-in; got %q", text)
	}
	if !strings.Contains(text, "did not answer within 0.05s") {
		t.Fatalf("the stand-in must name the bound we enforced; got %q", text)
	}
}

// A server that is not running is the other cause a user can act on — the
// Python twin says "the server refused the connection — is it running?".
func TestARefusedConnectionIsNamed(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	dead.Close() // nothing listens here any more
	g := localGateway(dead.URL, &http.Client{Timeout: time.Second})
	text, _, _, isReal, _ := g.invoke(ask, roundTrip(t, g.Route("summarise the new notes", local)))

	if isReal || !strings.HasPrefix(text, "[offline:local:") {
		t.Fatalf("an unreachable server is the offline stand-in; got real=%v %q", isReal, text)
	}
	if !strings.Contains(text, "refused the connection") {
		t.Fatalf("the stand-in must say the server is not listening; got %q", text)
	}
}

// The daemon's own default, for a daemon started without the supervisor's
// env: the Python gateway's 120 s, not the 2 s that closed a local call while
// the model was still loading.
func TestTheDaemonsDefaultBoundLeavesRoomToLoadAModel(t *testing.T) {
	if defaultTimeout < 120*time.Second {
		t.Fatalf("defaultTimeout is %s; a cold local model needs longer than that to load", defaultTimeout)
	}
}
