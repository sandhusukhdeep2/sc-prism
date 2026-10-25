package main

import (
	"os"
	"strings"
)

// Routing — the REAL Bifrost's role, mirroring engine/scprism_engine/gateway.py.
//
// ALL model calls route through here: sensitivity keywords FORCE local (no
// egress), reasoning-heavy keywords go to the primary cloud provider, and
// sensitivity always wins (precedence). Keyword lists + order are kept in
// lock-step with the Python gateway so behavior is identical across the seam.

const (
	local           = "local"
	cloud           = "cloud"
	defaultLocalURL = "http://localhost:1234"
)

// Sensitivity FORCES local — sensitive data must never leave the machine.
// Precedence: these win over everything. Order mirrors gateway.py.
var sensitiveKeywords = []string{
	"password",
	"passwd",
	"credential",
	"customer",
	"auth",
	"authentication",
	"authorization",
	"login",
	"token",
	"secret",
	"prod",
	"production",
	"pii",
	"ssn",
	"private-key",
	"privatekey",
	"api-key",
	"apikey",
}

// Reasoning-heavy work benefits from a larger cloud model (absent sensitivity).
var reasoningKeywords = []string{
	"architect",
	"design",
	"refactor",
	"plan",
	"algorithm",
	"distributed",
	"concurrency",
	"optimize",
	"optimise",
	"migrate",
	"proof",
}

// providerConf mirrors _PROVIDERS in gateway.py — REAL cloud endpoints.
//   - openai — OpenAI Chat Completions (Bearer).
//   - gemini — Google's OpenAI-compat endpoint (/v1beta/openai/…, Bearer).
//   - claude — Anthropic Messages API (NOT OpenAI-compatible; see provider.go).
//
// Kind selects the request builder ("openai" | "anthropic"); ChatPath is the
// POST path appended to BaseURL for OpenAI-compat providers.
type providerConf struct {
	BaseURL  string `json:"base_url"`
	Model    string `json:"model"`
	Kind     string `json:"kind,omitempty"`
	ChatPath string `json:"chat_path,omitempty"`
}

var providers = map[string]providerConf{
	"openai": {
		BaseURL: "https://api.openai.com", Model: "gpt-4o-mini",
		Kind: "openai", ChatPath: "/v1/chat/completions",
	},
	"gemini": {
		BaseURL: "https://generativelanguage.googleapis.com", Model: "gemini-2.0-flash",
		Kind: "openai", ChatPath: "/v1beta/openai/chat/completions",
	},
	"claude": {
		BaseURL: "https://api.anthropic.com", Model: "claude-3-5-sonnet-latest",
		Kind: "anthropic", ChatPath: "/v1/messages",
	},
}

// modelFor returns the model string for a provider — an env override
// (SCPRISM_<PROVIDER>_MODEL), else the honest default above.
func (g *Gateway) modelFor(provider string) string {
	if m, ok := g.modelOverrides[provider]; ok && m != "" {
		return m
	}
	if conf, ok := providers[provider]; ok {
		return conf.Model
	}
	return providers["openai"].Model
}

// RouteDecision — where a call is routed and why (audit trail). JSON shape
// matches RouteDecision.to_dict() in gateway.py; the api key is NEVER
// serialized (json:"-").
type RouteDecision struct {
	Target   string `json:"target"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	BaseURL  string `json:"base_url"`
	IsLocal  bool   `json:"is_local"`
	Reason   string `json:"reason"`
	Matched  string `json:"matched"`
	APIKey   string `json:"-"`
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func getenvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// pickPrimary chooses the single primary cloud provider by available key,
// mirroring Gateway._pick_primary.
func (g *Gateway) pickPrimary() string {
	if g.claudeKey != "" {
		return "claude"
	}
	if g.openaiKey != "" {
		return "openai"
	}
	if g.geminiKey != "" {
		return "gemini"
	}
	return "openai" // label default; the offline stub covers a missing key
}

func (g *Gateway) keyFor(provider string) string {
	switch provider {
	case "openai":
		return g.openaiKey
	case "claude":
		return g.claudeKey
	case "gemini":
		return g.geminiKey
	}
	return ""
}

// Route decides local vs cloud. Sensitivity wins over reasoning load — and over
// an explicit per-message hint.
//
// hint is an OPTIONAL per-message route REQUEST ("local" | "cloud" | ""). The
// daemon stays authoritative and grants it only WITHIN the zero-egress floor,
// mirroring Gateway.route(hint) in gateway.py EXACTLY (same precedence, same
// reason strings) so the attribution chip reads the same regardless of which
// gateway ran:
//   - The SENSITIVITY branch is checked FIRST and is a HARD override — a
//     sensitive keyword keeps the message local even when the user asked for
//     cloud; the reason then acknowledges the refusal so the chip stays honest.
//   - With no sensitivity hit, the hint is honored immediately (before the
//     reasoning/primary lanes): "local" forces local; "cloud" routes to the
//     primary IF a cloud provider is usable, else honestly stays local.
//   - hint == "" (the default) falls through to the EXISTING rules unchanged —
//     every no-hint call is byte-identical to before route hints landed.
func (g *Gateway) Route(intent string, hint string) RouteDecision {
	low := strings.ToLower(intent)

	for _, k := range sensitiveKeywords {
		if strings.Contains(low, k) {
			// The sensitivity floor is a HARD override: even an explicit "cloud"
			// request cannot egress a secret. Acknowledge the refusal in the
			// reason so the chip tells the truth (asked cloud, kept local).
			if hint == cloud {
				return g.localDecision(
					"you asked for cloud, but sensitive keyword '"+k+
						"' -> kept local (no egress)", k)
			}
			return g.localDecision(
				"sensitive keyword '"+k+"' -> keep local (no egress)", k)
		}
	}

	// Per-message route hint — honored AFTER the sensitivity floor, BEFORE the
	// reasoning/primary lanes. Only "local"/"cloud" act; "" falls through to the
	// existing rules (byte-identical when no hint).
	if hint == local {
		return g.localDecision("you chose local for this message", "")
	}
	if hint == cloud {
		// Honor "cloud" only when a cloud provider is actually usable (a real
		// key); otherwise forcing the cloud lane would just hit the keyless
		// offline stub while bypassing the local primary — so stay local and say
		// so honestly (mirrors gateway.py).
		if g.cloudUsable() {
			return g.cloudDecision("you chose cloud for this message", "")
		}
		return g.localDecision(
			"you asked for cloud, but no cloud provider is configured -> local", "")
	}

	for _, k := range reasoningKeywords {
		if strings.Contains(low, k) {
			return g.cloudDecision("reasoning keyword '"+k+"' -> cloud", k)
		}
	}
	// The user's explicit primary answers by default (mirrors gateway.py).
	if g.primaryExplicit {
		return g.cloudDecision("default -> primary ("+g.primary+") per user selection", "")
	}
	return g.localDecision("default -> local (cheap, zero egress)", "")
}

// cloudUsable reports whether the primary cloud provider can actually answer —
// i.e. a real API key is present for it. Mirrors Gateway._cloud_usable in
// gateway.py; the daemon never serves CLI-bridge primaries (make_gateway forces
// those onto the Python gateway), so key presence is the whole test here.
func (g *Gateway) cloudUsable() bool {
	return g.keyFor(g.primary) != ""
}

func (g *Gateway) localDecision(reason, matched string) RouteDecision {
	return RouteDecision{
		Target:   local,
		Provider: "local",
		Model:    g.localModel,
		BaseURL:  g.localBaseURL,
		IsLocal:  true,
		Reason:   reason,
		Matched:  matched,
		APIKey:   g.localKey,
	}
}

func (g *Gateway) cloudDecision(reason, matched string) RouteDecision {
	conf, ok := providers[g.primary]
	if !ok {
		conf = providers["openai"]
	}
	return RouteDecision{
		Target:   cloud,
		Provider: g.primary,
		Model:    g.modelFor(g.primary),
		BaseURL:  conf.BaseURL,
		IsLocal:  false,
		Reason:   reason,
		Matched:  matched,
		APIKey:   g.keyFor(g.primary),
	}
}
