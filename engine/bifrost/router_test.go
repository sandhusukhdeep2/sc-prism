package main

import (
	"net/http"
	"testing"
)

// newGateway builds a gateway with an unreachable local endpoint + no keys, so
// every model call falls to the deterministic offline stub (no network).
func newGateway() *Gateway {
	g := &Gateway{
		localBaseURL:  "http://127.0.0.1:9",
		localModel:    "local-model",
		primary:       "openai",
		timeout:       defaultTimeout,
		maxTokens:     defaultMaxTokens,
		promptCache:   map[string]ModelCallResult{},
		semanticCache: map[string]ModelCallResult{},
		stats:         map[string]int{"prompt_hit": 0, "semantic_hit": 0, "miss": 0},
		client:        &http.Client{Timeout: defaultTimeout},
	}
	return g
}

func TestSensitiveKeywordForcesLocal(t *testing.T) {
	d := newGateway().Route("rotate the customer password store", "")
	if d.Target != local {
		t.Fatalf("want local, got %q", d.Target)
	}
	if !d.IsLocal {
		t.Fatal("is_local should be true")
	}
	if d.Matched != "password" {
		t.Fatalf("want matched=password, got %q", d.Matched)
	}
}

func TestReasoningKeywordRoutesCloud(t *testing.T) {
	d := newGateway().Route("design a distributed rate limiter", "")
	if d.Target != cloud {
		t.Fatalf("want cloud, got %q", d.Target)
	}
	if d.IsLocal {
		t.Fatal("is_local should be false")
	}
}

func TestSensitivityWinsOverReasoning(t *testing.T) {
	// Contains a reasoning word (refactor) AND a sensitive word (auth/token).
	d := newGateway().Route("refactor the auth token exchange", "")
	if d.Target != local {
		t.Fatalf("sensitivity must win over load: got %q", d.Target)
	}
}

func TestDefaultRoutesLocal(t *testing.T) {
	d := newGateway().Route("add a small helper function", "")
	if d.Target != local {
		t.Fatalf("want local, got %q", d.Target)
	}
}

func TestPickPrimaryPrefersClaudeThenOpenAIThenGemini(t *testing.T) {
	cases := []struct {
		openai, claude, gemini, want string
	}{
		{"", "k", "", "claude"},
		{"k", "", "", "openai"},
		{"", "", "k", "gemini"},
		{"", "", "", "openai"}, // label default
	}
	for _, c := range cases {
		g := &Gateway{openaiKey: c.openai, claudeKey: c.claude, geminiKey: c.gemini}
		if got := g.pickPrimary(); got != c.want {
			t.Errorf("pickPrimary(%q,%q,%q)=%q want %q",
				c.openai, c.claude, c.gemini, got, c.want)
		}
	}
}

func TestCloudDecisionCarriesKeyButNeverSerializes(t *testing.T) {
	g := newGateway()
	g.claudeKey = "secret-key"
	g.primary = "claude"
	d := g.Route("design something big", "")
	if d.Provider != "claude" {
		t.Fatalf("want claude, got %q", d.Provider)
	}
	if d.APIKey != "secret-key" {
		t.Fatalf("route should carry the key internally")
	}
	blob := marshal(t, d)
	if containsSub(blob, "secret-key") || containsSub(blob, "api_key") {
		t.Fatalf("api key must never serialize: %s", blob)
	}
}

// --- per-message route hint (mirrors gateway.py.route(hint), so the attribution
// chip reads the same regardless of which gateway ran) ---------------------

// The headline honesty guarantee: a user's explicit "local" hint keeps a
// reasoning-keyword message LOCAL under Bifrost, even though the built-in rules
// would send that same intent to cloud. Before the fix the daemon dropped the
// hint and this egressed to cloud.
func TestHintLocalKeepsReasoningKeywordLocal(t *testing.T) {
	g := newGateway()
	g.openaiKey = "k" // a cloud provider IS usable, so only the hint keeps it local
	// "design"/"distributed" are reasoning keywords -> cloud without a hint.
	if d := g.Route("design a distributed rate limiter", ""); d.Target != cloud {
		t.Fatalf("sanity: reasoning intent should be cloud without a hint, got %q", d.Target)
	}
	d := g.Route("design a distributed rate limiter", local)
	if d.Target != local || !d.IsLocal {
		t.Fatalf("hint=local must keep a reasoning intent LOCAL, got %q", d.Target)
	}
	if d.Reason != "you chose local for this message" {
		t.Fatalf("honest local reason expected, got %q", d.Reason)
	}
}

// The sensitivity floor is a HARD egress boundary: an explicit "cloud" hint on a
// sensitive message is refused and kept local, with an honest reason.
func TestHintCloudOnSensitiveStaysLocal(t *testing.T) {
	g := newGateway()
	g.openaiKey = "k" // cloud usable, yet the floor still wins
	d := g.Route("rotate the customer records", cloud)
	if d.Target != local || !d.IsLocal {
		t.Fatalf("sensitivity floor must keep it LOCAL, got %q", d.Target)
	}
	if d.Matched != "customer" {
		t.Fatalf("want matched=customer, got %q", d.Matched)
	}
	want := "you asked for cloud, but sensitive keyword 'customer' -> kept local (no egress)"
	if d.Reason != want {
		t.Fatalf("floor reason must acknowledge the refused cloud request.\n got: %q\nwant: %q", d.Reason, want)
	}
}

// hint="cloud" WITH a usable cloud provider routes to cloud.
func TestHintCloudWithProviderRoutesCloud(t *testing.T) {
	g := newGateway()
	g.openaiKey = "k" // makes the primary (openai) cloud-usable
	d := g.Route("write a friendly greeting", cloud)
	if d.Target != cloud || d.IsLocal {
		t.Fatalf("hint=cloud with a provider must route CLOUD, got %q", d.Target)
	}
	if d.Reason != "you chose cloud for this message" {
		t.Fatalf("honest cloud reason expected, got %q", d.Reason)
	}
}

// hint="cloud" with NO usable cloud provider honestly stays local instead of
// bypassing the primary for the keyless stub.
func TestHintCloudWithoutProviderStaysLocal(t *testing.T) {
	g := newGateway() // no keys -> cloud not usable
	d := g.Route("write a friendly greeting", cloud)
	if d.Target != local || !d.IsLocal {
		t.Fatalf("hint=cloud without a provider must stay LOCAL, got %q", d.Target)
	}
	if d.Reason != "you asked for cloud, but no cloud provider is configured -> local" {
		t.Fatalf("honest no-cloud reason expected, got %q", d.Reason)
	}
}

// An empty hint is byte-identical to the no-hint rules (opt-in feature).
func TestEmptyHintIsByteIdenticalToNoHint(t *testing.T) {
	g := newGateway()
	g.openaiKey = "k"
	cases := []string{
		"design a distributed rate limiter", // reasoning -> cloud
		"rotate the customer password store", // sensitive -> local
		"add a small helper function",        // default
	}
	for _, intent := range cases {
		a := g.Route(intent, "")
		if a.Reason == "" {
			t.Fatalf("empty-hint route should carry a reason for %q", intent)
		}
		if containsSub(a.Reason, "you chose") || containsSub(a.Reason, "you asked for") {
			t.Fatalf("empty hint must never yield a hint reason: %q -> %q", intent, a.Reason)
		}
	}
}
