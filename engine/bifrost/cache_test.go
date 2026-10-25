package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func marshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func containsSub(s, sub string) bool { return strings.Contains(s, sub) }

func TestPromptCacheHitOnRepeat(t *testing.T) {
	g := newGateway()
	msgs := []message{{"role": "user", "content": "explain the widget pipeline"}}
	route := g.Route("explain the widget pipeline", "")

	first := g.ModelCall(msgs, route)
	if first.Cache != "miss" {
		t.Fatalf("first call want miss, got %q", first.Cache)
	}
	second := g.ModelCall(msgs, route)
	if second.Cache != "prompt" {
		t.Fatalf("repeat want prompt-cache hit, got %q", second.Cache)
	}
	if second.Text != first.Text {
		t.Fatal("cached text must match")
	}
	if g.stats["prompt_hit"] != 1 || g.stats["miss"] != 1 {
		t.Fatalf("stats off: %+v", g.stats)
	}
}

func TestSemanticCacheHitOnNormalizedIntent(t *testing.T) {
	g := newGateway()
	route := g.Route("summarize the report", "")
	a := []message{{"role": "user", "content": "Summarize the Report."}}
	b := []message{{"role": "user", "content": "summarize   the report"}}

	if r := g.ModelCall(a, route); r.Cache != "miss" {
		t.Fatalf("first want miss, got %q", r.Cache)
	}
	// Different exact bytes, same normalized intent bucket.
	if r := g.ModelCall(b, route); r.Cache != "semantic" {
		t.Fatalf("want semantic-cache hit, got %q", r.Cache)
	}
	if g.stats["semantic_hit"] != 1 {
		t.Fatalf("semantic_hit want 1, got %d", g.stats["semantic_hit"])
	}
}

func TestOfflineStubIsDeterministic(t *testing.T) {
	// Two independent gateways, same messages -> identical stub output.
	g1, g2 := newGateway(), newGateway()
	msgs := []message{{"role": "user", "content": "produce a deterministic answer"}}
	r1 := g1.ModelCall(msgs, g1.Route("produce a deterministic answer", ""))
	r2 := g2.ModelCall(msgs, g2.Route("produce a deterministic answer", ""))

	if r1.IsReal {
		t.Fatal("offline stub should not be real")
	}
	if r1.Text != r2.Text {
		t.Fatalf("stub text not deterministic:\n %q\n %q", r1.Text, r2.Text)
	}
	if r1.TokensIn != r2.TokensIn || r1.TokensOut != r2.TokensOut {
		t.Fatal("stub token counts not deterministic")
	}
	if r1.TokensOut <= 0 {
		t.Fatal("stub tokens_out must be > 0")
	}
	if !strings.HasPrefix(r1.Text, "[offline:") {
		t.Fatalf("unexpected stub text: %q", r1.Text)
	}
}
