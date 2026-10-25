package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A LOCAL model that cannot be LOADED (2026-08-17). oMLX answers 507 with
// "projected memory 42.36GB would exceed the metal_cap memory ceiling 24.96GB".
// The daemon ignored the status, failed to parse the error body as a
// completion, and returned the deterministic offline stub — which the app
// reported to the user as an unreachable provider. Go twin of
// engine/tests/test_gateway_local_load.py.

const omlx507 = `{"detail":"projected memory 42.36GB would exceed the metal_cap memory ceiling 24.96GB"}`

// serveStatus stands up a local endpoint that always answers `status`/`body`.
func serveStatus(t *testing.T, status int, body string) (*Gateway, RouteDecision) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	g := newGateway()
	g.localBaseURL = srv.URL
	g.client = srv.Client()
	return g, g.Route("write the report", local)
}

func TestLocalLoadFailureIsNamed(t *testing.T) {
	g, route := serveStatus(t, 507, omlx507)
	res := g.ModelCall([]message{{"role": "user", "content": "write the report"}}, route)

	if res.IsReal {
		t.Fatalf("a refused load is not a real completion: %+v", res)
	}
	if !strings.Contains(res.Text, loadFailedMark) {
		t.Fatalf("want the load-failed marker, got %q", res.Text)
	}
	// The server's OWN numbers, not ours.
	if !strings.Contains(res.Text, "42.4 GB") || !strings.Contains(res.Text, "25.0 GB") {
		t.Fatalf("want the server's own GB figures, got %q", res.Text)
	}
	if strings.Contains(res.Text, "handled:") {
		t.Fatalf("this must not fall through to the deterministic stub: %q", res.Text)
	}
	if res.TokensOut != 0 {
		t.Fatalf("nothing was generated, so tokens_out must be 0, got %d", res.TokensOut)
	}
}

func TestOtherLocalFailuresStillStub(t *testing.T) {
	// A 500 with nothing about memory is NOT a load failure — it keeps the
	// existing stub, so this fix cannot quietly relabel every server error.
	g, route := serveStatus(t, 500, `{"detail":"internal error"}`)
	res := g.ModelCall([]message{{"role": "user", "content": "write the report"}}, route)
	if strings.Contains(res.Text, loadFailedMark) {
		t.Fatalf("a plain 500 must not be called a load failure: %q", res.Text)
	}
	if !strings.Contains(res.Text, "handled:") {
		t.Fatalf("want the deterministic stub, got %q", res.Text)
	}
}

func TestLoadFailureReasonWithoutNumbersStaysHonest(t *testing.T) {
	// No parseable figures: say what is known and quote the server, never
	// invent a footprint.
	reason := loadFailureReason(507, "out of memory")
	if !strings.Contains(reason, "not enough GPU memory") {
		t.Fatalf("want the plain cause, got %q", reason)
	}
	if strings.Contains(reason, "GB and the server") {
		t.Fatalf("no figures were given, so none may be printed: %q", reason)
	}
	if !strings.Contains(reason, "out of memory") {
		t.Fatalf("want the server's own words quoted, got %q", reason)
	}
}
