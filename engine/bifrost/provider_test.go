package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The daemon's OpenAI-compat builder had the SAME silent-truncation bug the
// Python gateway carried: no max_tokens at all (so the server's own default
// decided how long an answer could be) and no finish_reason parsing (so a
// guillotined reply was handed back as if it were complete). These tests hold
// both halves of the fix, mirroring TestGatewayMaxTokens /
// TestGatewayTruncationHonesty in engine/tests/test_gateway.py.

// serve stands up a local OpenAI-compat endpoint that records the request body
// and replies with `reply`. Returns the gateway pointed at it, a local route,
// and the captured body (populated after the call).
func serve(t *testing.T, reply map[string]any) (*Gateway, RouteDecision, *map[string]any) {
	t.Helper()
	body := map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reply)
	}))
	t.Cleanup(srv.Close)

	g := newGateway()
	g.localBaseURL = srv.URL
	g.client = srv.Client()
	return g, g.Route("write the report", local), &body
}

func okReply(finish string) map[string]any {
	return map[string]any{
		"choices": []any{map[string]any{
			"message":       map[string]any{"content": "fix 1 ... fix 2 is cut"},
			"finish_reason": finish,
		}},
		"usage": map[string]any{"prompt_tokens": 3, "completion_tokens": 9},
	}
}

func TestPayloadCarriesDefaultMaxTokens(t *testing.T) {
	g, route, body := serve(t, okReply("stop"))
	if res := g.ModelCall([]message{{"role": "user", "content": "write the report"}}, route); !res.IsReal {
		t.Fatalf("want a real call, got %+v", res)
	}
	got, ok := (*body)["max_tokens"].(float64) // JSON numbers decode as float64
	if !ok {
		t.Fatalf("payload must carry max_tokens, got %+v", *body)
	}
	if int(got) != defaultMaxTokens {
		t.Fatalf("max_tokens = %d, want %d", int(got), defaultMaxTokens)
	}
	if defaultMaxTokens <= 1024 {
		t.Fatal("1024 was the truncating floor")
	}
}

func TestMaxTokensEnvOverride(t *testing.T) {
	// Precedence mirrors gateway.py: explicit (SCPRISM_BIFROST_MAX_TOKENS, set
	// by the Python client's max_tokens kwarg) > SCPRISM_MAX_TOKENS > default.
	cases := []struct {
		bifrost, shared string
		want            int
	}{
		{"", "", defaultMaxTokens},
		{"", "7777", 7777},
		{"321", "7777", 321},
		{"", "not-a-number", defaultMaxTokens},
	}
	for _, c := range cases {
		t.Setenv("SCPRISM_BIFROST_MAX_TOKENS", c.bifrost)
		t.Setenv("SCPRISM_MAX_TOKENS", c.shared)
		if got := NewGatewayFromEnv().maxTokens; got != c.want {
			t.Errorf("maxTokens(bifrost=%q, shared=%q) = %d, want %d",
				c.bifrost, c.shared, got, c.want)
		}
	}
}

func TestLengthFinishReasonIsReportedAsTruncated(t *testing.T) {
	g, route, _ := serve(t, okReply("length"))
	res := g.ModelCall([]message{{"role": "user", "content": "top 3 fixes"}}, route)
	if !res.Truncated {
		t.Fatal("finish_reason=length must be reported as truncated")
	}
	// The Python client reads this field off the wire — it has to serialize.
	if !containsSub(marshal(t, res), `"truncated":true`) {
		t.Fatalf("truncated must ride the wire: %s", marshal(t, res))
	}
}

func TestCleanStopIsNotTruncated(t *testing.T) {
	g, route, _ := serve(t, okReply("stop"))
	if res := g.ModelCall([]message{{"role": "user", "content": "top 3 fixes"}}, route); res.Truncated {
		t.Fatal("a clean stop must not be marked truncated")
	}
}

func TestOfflineStubIsNeverTruncated(t *testing.T) {
	g := newGateway() // unreachable endpoint -> deterministic stub
	res := g.ModelCall([]message{{"role": "user", "content": "hi"}}, g.Route("hi", ""))
	if res.IsReal {
		t.Fatal("sanity: want the offline stub")
	}
	if res.Truncated {
		t.Fatal("the stub is always complete")
	}
}

func TestCacheHitKeepsTheTruncationFlag(t *testing.T) {
	g, route, _ := serve(t, okReply("length"))
	msgs := []message{{"role": "user", "content": "top 3 fixes"}}
	if first := g.ModelCall(msgs, route); !first.Truncated {
		t.Fatal("sanity: first call should be truncated")
	}
	hit := g.ModelCall(msgs, route)
	if hit.Cache != "prompt" {
		t.Fatalf("want a prompt-cache hit, got %q", hit.Cache)
	}
	if !hit.Truncated {
		t.Fatal("honesty must survive the cache")
	}
}

// A reply that holds no answer text (2026-11-14). An OpenAI-compatible server
// leaves `content` out of the message when the model wrote no answer — its
// thinking travels in `reasoning_content`, a tool request in `tool_calls`. The
// struct read that as "" and handed it back as a REAL completion: an empty
// answer marked genuine. The Python twin had the opposite fault (a KeyError,
// retried three times). Both now say what happened, in the same words — see
// engine/tests/test_gateway_no_answer.py.

func noTextReply(message map[string]any, finish string) map[string]any {
	return map[string]any{
		"choices": []any{map[string]any{"message": message, "finish_reason": finish}},
		"usage":   map[string]any{"prompt_tokens": 1989, "completion_tokens": 4096},
	}
}

func askOnce(t *testing.T, reply map[string]any) ModelCallResult {
	t.Helper()
	g, route, _ := serve(t, reply)
	return g.ModelCall([]message{{"role": "user", "content": "add a third line"}}, route)
}

func TestAnAllowanceSpentThinkingIsANamedNoAnswer(t *testing.T) {
	res := askOnce(t, noTextReply(map[string]any{"role": "assistant", "reasoning_content": "hm"}, "length"))
	if res.IsReal {
		t.Fatal("a reply with no answer text is not a real completion")
	}
	want := "the model spent its whole answer allowance (4,096 tokens) thinking and wrote no answer"
	if !containsSub(res.Text, "[offline:local:") || !containsSub(res.Text, want) {
		t.Fatalf("want the named cause, got %q", res.Text)
	}
	// The server measured these: they are kept, not zeroed and not estimated.
	if res.TokensIn != 1989 || res.TokensOut != 4096 {
		t.Fatalf("want the measured 1989/4096, got %d/%d", res.TokensIn, res.TokensOut)
	}
}

func TestANullOrBlankContentIsTheSame(t *testing.T) {
	for _, content := range []any{nil, "", "  \n"} {
		res := askOnce(t, noTextReply(map[string]any{"content": content, "reasoning_content": "hm"}, "length"))
		if res.IsReal || !containsSub(res.Text, "thinking and wrote no answer") {
			t.Fatalf("content=%#v: want a named no-answer, got real=%v %q", content, res.IsReal, res.Text)
		}
	}
}

func TestCutOffWithNoThinkingDoesNotClaimThinking(t *testing.T) {
	res := askOnce(t, noTextReply(map[string]any{"role": "assistant"}, "length"))
	want := "the model reached its answer allowance (4,096 tokens) before writing an answer"
	if res.IsReal || !containsSub(res.Text, want) {
		t.Fatalf("got real=%v %q", res.IsReal, res.Text)
	}
}

func TestAToolRequestWithNoTextSaysThat(t *testing.T) {
	res := askOnce(t, noTextReply(map[string]any{
		"role":       "assistant",
		"tool_calls": []any{map[string]any{"id": "1", "type": "function"}},
	}, "tool_calls"))
	want := "the model answered with a tool request only, in a form this app does not read, and wrote no text"
	if res.IsReal || !containsSub(res.Text, want) {
		t.Fatalf("got real=%v %q", res.IsReal, res.Text)
	}
}

func TestAFinishedReplyWithNothingInItIsAnEmptyAnswer(t *testing.T) {
	res := askOnce(t, noTextReply(map[string]any{"role": "assistant"}, "stop"))
	if res.IsReal || !containsSub(res.Text, "the model returned an empty answer") {
		t.Fatalf("got real=%v %q", res.IsReal, res.Text)
	}
}

func TestAnAnswerBesideThinkingIsStillTheAnswer(t *testing.T) {
	res := askOnce(t, noTextReply(map[string]any{"content": "Done.", "reasoning_content": "easy"}, "stop"))
	if !res.IsReal || res.Text != "Done." {
		t.Fatalf("got real=%v %q", res.IsReal, res.Text)
	}
}
