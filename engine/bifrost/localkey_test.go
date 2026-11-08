package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A local OpenAI-compatible server may require an API key — oMLX does, and it
// answers an unauthenticated POST with 401 "API key required".
//
// The daemon knows the key (OPENAI_API_KEY → g.localKey) and localDecision()
// puts it on the route. But every production call arrives over the socket:
// the Python side calls `route`, gets the decision as JSON, and sends it back
// with `model_call`. RouteDecision.APIKey is `json:"-"` — correct, a key must
// never cross the wire — so the route that reaches invoke() has an EMPTY key,
// and invoke() only re-derived keys for cloud routes. Local routes went out
// with no Authorization header at all, the server said 401, and the call fell
// to the offline stub. Found 2026-11-08 in the user's oMLX log: thirteen 401s,
// one per model call of three scheduled manager jobs, each of which the engine
// then filed as passed.
//
// authServer behaves like oMLX: 401 without the exact bearer, a real
// completion with it.
func authServer(t *testing.T, key string) (*httptest.Server, *int) {
	t.Helper()
	unauthenticated := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer "+key {
			unauthenticated++
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"detail": "API key required"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{
				"message":       map[string]any{"content": "a real answer"},
				"finish_reason": "stop",
			}},
			"usage": map[string]any{"prompt_tokens": 3, "completion_tokens": 2},
		})
	}))
	t.Cleanup(srv.Close)
	return srv, &unauthenticated
}

// roundTrip does to a route exactly what the socket does: JSON out, JSON in.
func roundTrip(t *testing.T, d RouteDecision) RouteDecision {
	t.Helper()
	blob, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	var back RouteDecision
	if err := json.Unmarshal(blob, &back); err != nil {
		t.Fatal(err)
	}
	if back.APIKey != "" {
		t.Fatalf("the key must never serialize, got %q", back.APIKey)
	}
	return back
}

func TestLocalRouteStillAuthenticatesAfterTheSocketRoundTrip(t *testing.T) {
	srv, unauthenticated := authServer(t, "local-secret")
	g := newGateway()
	g.localBaseURL = srv.URL
	g.localKey = "local-secret"
	g.client = srv.Client()

	route := roundTrip(t, g.Route("summarise the new notes", local))
	if !route.IsLocal {
		t.Fatalf("expected a local route, got %+v", route)
	}

	res := g.ModelCall([]message{{"role": "user", "content": "summarise the new notes"}}, route)

	if *unauthenticated != 0 {
		t.Fatalf("the daemon sent %d request(s) with no Authorization header", *unauthenticated)
	}
	if !res.IsReal {
		t.Fatalf("want a real completion, got the stand-in %q", res.Text)
	}
	if res.Text != "a real answer" {
		t.Fatalf("unexpected text %q", res.Text)
	}
}

func TestLocalRouteWithoutAKeySendsNoHeader(t *testing.T) {
	// A keyless local server must keep working: no key configured → no header,
	// not an empty "Bearer ".
	seen := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 1, "completion_tokens": 1},
		})
	}))
	t.Cleanup(srv.Close)
	g := newGateway()
	g.localBaseURL = srv.URL
	g.localKey = ""
	g.client = srv.Client()
	res := g.ModelCall([]message{{"role": "user", "content": "hello"}}, roundTrip(t, g.Route("hello", local)))
	if !res.IsReal || seen != "" {
		t.Fatalf("keyless local call: real=%v header=%q", res.IsReal, seen)
	}
}
