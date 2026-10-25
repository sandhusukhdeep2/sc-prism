package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Gateway — provider abstraction + sensitivity routing + prompt/semantic cache.
// This is the daemon's stateful core, mirroring the Python Gateway class. Config
// is read from the environment at startup (the Python supervisor passes it when
// it spawns the daemon), so route/model_call need no config on the wire.

const defaultTimeout = 2 * time.Second

// Output budget for every real provider call — the Go twin of
// DEFAULT_MAX_TOKENS in gateway.py. Without an explicit max_tokens the
// server's own per-request default silently guillotines the reply, and a
// reasoning model spends much of that budget thinking before the visible
// answer even starts. Keep this in lock-step with the Python constant.
const defaultMaxTokens = 4096

// ModelCallResult is the gateway's return contract; JSON shape matches
// ModelCallResult.to_dict() in gateway.py.
type ModelCallResult struct {
	Text      string `json:"text"`
	TokensIn  int    `json:"tokens_in"`
	TokensOut int    `json:"tokens_out"`
	Cache     string `json:"cache"` // 'miss' | 'prompt' | 'semantic'
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	IsReal    bool   `json:"is_real"`
	// The provider said it stopped because it hit the output cap
	// (finish_reason == "length"), so Text is CUT OFF, not finished. Carried
	// out over the wire so bifrost_client.py's ModelCallResult.truncated tells
	// the truth. False = a clean completion.
	Truncated bool `json:"truncated"`
}

type Gateway struct {
	localBaseURL string
	localModel   string
	localKey     string
	openaiKey    string
	claudeKey    string
	geminiKey    string
	primary      string
	// True when the USER explicitly chose a non-local primary — default
	// routing then honors it (mirrors Gateway.primary_explicit in gateway.py).
	primaryExplicit bool
	// Per-provider model overrides (SCPRISM_<PROVIDER>_MODEL). nil is fine.
	modelOverrides map[string]string
	timeout        time.Duration
	// Explicit output cap sent on every real call (see defaultMaxTokens).
	maxTokens int

	mu            sync.Mutex
	promptCache   map[string]ModelCallResult
	semanticCache map[string]ModelCallResult
	stats         map[string]int

	client *http.Client
}

// NewGatewayFromEnv builds the gateway from the same env vars the Python
// Gateway reads (plus SCPRISM_BIFROST_PRIMARY / _TIMEOUT overrides).
func NewGatewayFromEnv() *Gateway {
	g := &Gateway{
		localBaseURL: getenvDefault("OPENAI_BASE_URL", defaultLocalURL),
		localModel:   getenvDefault("OPENAI_MODEL", "local-model"),
		// A local OpenAI-compatible server may itself require an API key; it
		// shares OPENAI_API_KEY with the cloud OpenAI provider (the base URL
		// disambiguates which endpoint is called).
		localKey:  os.Getenv("OPENAI_API_KEY"),
		openaiKey: os.Getenv("OPENAI_API_KEY"),
		claudeKey: firstNonEmpty(os.Getenv("CLAUDE_API_KEY"), os.Getenv("ANTHROPIC_API_KEY")),
		geminiKey: firstNonEmpty(os.Getenv("GEMINI_API_KEY"), os.Getenv("GOOGLE_API_KEY")),
		modelOverrides: map[string]string{
			"openai": os.Getenv("SCPRISM_OPENAI_MODEL"),
			"claude": os.Getenv("SCPRISM_CLAUDE_MODEL"),
			"gemini": os.Getenv("SCPRISM_GEMINI_MODEL"),
		},
		timeout:       defaultTimeout,
		maxTokens:     defaultMaxTokens,
		promptCache:   map[string]ModelCallResult{},
		semanticCache: map[string]ModelCallResult{},
		stats:         map[string]int{"prompt_hit": 0, "semantic_hit": 0, "miss": 0},
	}
	if v := os.Getenv("SCPRISM_BIFROST_TIMEOUT"); v != "" {
		if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
			g.timeout = time.Duration(secs * float64(time.Second))
		}
	}
	// Output cap precedence mirrors gateway.py's (explicit arg > env > default):
	// SCPRISM_BIFROST_MAX_TOKENS carries the client's explicit `max_tokens`
	// kwarg (bifrost_client.py sets it only when one was passed), then the
	// shared SCPRISM_MAX_TOKENS env, then defaultMaxTokens.
	for _, v := range []string{
		os.Getenv("SCPRISM_BIFROST_MAX_TOKENS"), os.Getenv("SCPRISM_MAX_TOKENS"),
	} {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			g.maxTokens = n
			break
		}
	}
	// Primary cloud provider: SCPRISM_PRIMARY (client-forwarded, matches the
	// Python gateway) > SCPRISM_BIFROST_PRIMARY (daemon override) > pickPrimary.
	if p := firstNonEmpty(os.Getenv("SCPRISM_PRIMARY"), os.Getenv("SCPRISM_BIFROST_PRIMARY")); p != "" {
		g.primary = p
		g.primaryExplicit = p != "local"
	} else {
		g.primary = g.pickPrimary()
	}
	g.client = &http.Client{Timeout: g.timeout}
	return g
}

// ModelCall honors the prompt + semantic cache, then invokes (real or stub).
func (g *Gateway) ModelCall(messages []message, route RouteDecision) ModelCallResult {
	pkey := promptHash(messages)

	g.mu.Lock()
	if base, ok := g.promptCache[pkey]; ok {
		g.stats["prompt_hit"]++
		g.mu.Unlock()
		return withCache(base, "prompt")
	}
	skey := semanticKey(messages)
	if base, ok := g.semanticCache[skey]; ok {
		g.stats["semantic_hit"]++
		hit := withCache(base, "semantic")
		// Promote to the exact-prompt cache for next time.
		g.promptCache[pkey] = hit
		g.mu.Unlock()
		return hit
	}
	g.mu.Unlock()

	// Cache miss — invoke (real or stub).
	text, tin, tout, isReal, truncated := g.invoke(messages, route)
	result := ModelCallResult{
		Text:      text,
		TokensIn:  tin,
		TokensOut: tout,
		Cache:     "miss",
		Provider:  route.Provider,
		Model:     route.Model,
		IsReal:    isReal,
		Truncated: truncated,
	}
	g.mu.Lock()
	g.stats["miss"]++
	g.promptCache[pkey] = result
	g.semanticCache[skey] = result
	g.mu.Unlock()
	return result
}

func withCache(base ModelCallResult, cache string) ModelCallResult {
	base.Cache = cache
	return base
}

// chatURL builds the OpenAI-compatible chat/completions URL for a route.
// Gemini uses Google's OpenAI-compat path (/v1beta/openai/…); local + OpenAI
// use the standard /v1/chat/completions.
func chatURL(route RouteDecision) string {
	base := trimRightSlash(route.BaseURL)
	if route.Provider == "gemini" {
		return base + "/v1beta/openai/chat/completions"
	}
	return base + "/v1/chat/completions"
}

// invoke makes a real provider HTTP POST; on ANY error / no endpoint / no key
// it falls back to the deterministic offline stub. Per-provider handling
// mirrors gateway.py for local + openai + gemini (all OpenAI-compatible).
//
// TODO(cloud-providers): Claude routes are N/A on the Go path — Anthropic's
// Messages API is a DIFFERENT request shape (x-api-key + anthropic-version, a
// {model, max_tokens, messages, system} body, content[0].text parsing) and is
// intentionally not implemented here. The Python gateway (gateway.py
// _invoke_anthropic) is the primary, complete implementation; a Claude route
// reaching the Go daemon falls through to the deterministic offline stub.
func (g *Gateway) invoke(messages []message, route RouteDecision) (string, int, int, bool, bool) {
	key := route.APIKey
	if key == "" && !route.IsLocal {
		key = g.keyFor(route.Provider)
	}
	// A cloud route without a key can't authenticate — go straight to stub.
	if !route.IsLocal && key == "" {
		return g.stub(messages, route)
	}
	// Claude is not implemented on the Go path (see TODO above) — offline stub.
	if route.Provider == "claude" {
		return g.stub(messages, route)
	}

	url := chatURL(route)
	payload := map[string]any{
		"model":       route.Model,
		"messages":    messages,
		"temperature": 0,
		// ALWAYS explicit: without it the server's own per-request default
		// decides how long an answer may be (see defaultMaxTokens).
		"max_tokens": g.maxTokens,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return g.stub(messages, route)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return g.stub(messages, route)
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return g.stub(messages, route)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return g.stub(messages, route)
	}
	// HONESTY (2026-08-17): a LOCAL model that could not be LOADED. The server
	// answered — 507, "projected memory 42.36GB would exceed the metal_cap
	// memory ceiling 24.96GB" — it is up, it simply cannot fit this model
	// beside what is already resident. This path ignored the status entirely,
	// failed to parse the error body as a completion, and fell into the stub,
	// which the app then reported as an unreachable provider. Same marker and
	// same contract as the Python twin (gateway.py :: local_load_failure).
	if route.IsLocal && resp.StatusCode >= 400 {
		if reason := loadFailureReason(resp.StatusCode, string(raw)); reason != "" {
			return fmt.Sprintf("[offline:%s:%s] %s", route.Provider, route.Model, reason),
				estTokens(messagesText(messages)), 0, false, false
		}
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || len(parsed.Choices) == 0 {
		return g.stub(messages, route)
	}
	text := parsed.Choices[0].Message.Content
	tin := parsed.Usage.PromptTokens
	if tin == 0 {
		tin = estTokens(messagesText(messages))
	}
	tout := parsed.Usage.CompletionTokens
	if tout == 0 {
		tout = estTokens(text)
	}
	// OpenAI-compat says finish_reason == "length" when the cap cut the reply
	// off. Capture it — a cut-off answer must never be presented as complete.
	truncated := parsed.Choices[0].FinishReason == "length"
	return text, tin, tout, true, truncated
}

// loadFailedMark is the client's contract for "the local model could not be
// LOADED" — kept byte-identical to gateway.py's LOAD_FAILED_MARK and
// src/lib/runBudget.ts's LOAD_FAILED_MARK. Text carrying it is rendered as a
// memory problem the user can fix, never as an outage.
const loadFailedMark = "local model could not load"

var (
	loadFailedBody = regexp.MustCompile(`(?i)memory ceiling|metal_cap|out of memory|insufficient memory|cannot fit|won'?t fit`)
	projectedGB    = regexp.MustCompile(`(?i)projected memory\s*([0-9.]+)\s*GB`)
	ceilingGB      = regexp.MustCompile(`(?i)ceiling\s*([0-9.]+)\s*GB`)
)

// loadFailureReason returns the honest reason when a local call failed because
// the model could not be loaded, or "" when this was some other failure. Pure
// (status + body in, one sentence out) and the Go twin of gateway.py's
// local_load_failure — every number in the result is the SERVER's own.
func loadFailureReason(status int, body string) string {
	text := strings.TrimSpace(body)
	if status != 507 && !loadFailedBody.MatchString(text) {
		return ""
	}
	detail := "not enough GPU memory"
	p := projectedGB.FindStringSubmatch(text)
	c := ceilingGB.FindStringSubmatch(text)
	if len(p) == 2 && len(c) == 2 {
		needed, errN := strconv.ParseFloat(p[1], 64)
		ceil, errC := strconv.ParseFloat(c[1], 64)
		if errN == nil && errC == nil {
			detail = fmt.Sprintf(
				"not enough GPU memory — this model needs %.1f GB and the server's ceiling is %.1f GB",
				needed, ceil)
		}
	}
	said := strings.Join(strings.Fields(text), " ")
	if len(said) > 200 {
		said = said[:200]
	}
	if said == "" {
		return fmt.Sprintf("%s: %s (HTTP %d)", loadFailedMark, detail, status)
	}
	return fmt.Sprintf("%s: %s (the server said, HTTP %d: %q)", loadFailedMark, detail, status, said)
}

// stub is the deterministic offline response, seeded by the message hash —
// mirrors Gateway._stub so the engine always runs offline.
func (g *Gateway) stub(messages []message, route RouteDecision) (string, int, int, bool, bool) {
	h := promptHash(messages)
	seed, _ := strconv.ParseInt(h[:8], 16, 64)
	prompt := userText(messages)
	text := fmt.Sprintf("[offline:%s:%s] handled: %s (%s)",
		route.Provider, route.Model, prompt, h[:8])
	tin := estTokens(messagesText(messages))
	tout := int(seed%40) + 8 // stable, non-zero, hash-derived
	if tout < 1 {
		tout = 1
	}
	return text, tin, tout, false, false // the stub is always complete
}

func trimRightSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}
