package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
)

// Cache + hashing helpers, mirroring gateway.py:
//   * prompt cache — exact sha256 of the messages (byte-identical prompt).
//   * semantic cache — sha256 of a normalized-intent bucket (lowercase,
//     punctuation -> space, collapsed whitespace).
// Both keys are computed the SAME way the Python gateway computes them, so the
// two implementations agree on what counts as a hit.

var (
	nonAlnum   = regexp.MustCompile(`[^a-z0-9]+`)
	multiSpace = regexp.MustCompile(`\s+`)
)

// message is one chat message; content may be any JSON scalar (usually string).
type message map[string]any

func contentOf(m message) string {
	c, ok := m["content"]
	if !ok || c == nil {
		return ""
	}
	if s, ok := c.(string); ok {
		return s
	}
	// Non-string content: render deterministically (mirrors Python str()).
	b, _ := json.Marshal(c)
	return string(b)
}

func messagesText(messages []message) string {
	parts := make([]string, len(messages))
	for i, m := range messages {
		parts[i] = contentOf(m)
	}
	return strings.Join(parts, "\n")
}

func userText(messages []message) string {
	var users []string
	for _, m := range messages {
		if r, _ := m["role"].(string); r == "user" {
			users = append(users, contentOf(m))
		}
	}
	if len(users) == 0 {
		return messagesText(messages)
	}
	return strings.Join(users, "\n")
}

// promptHash is a stable sha256 over the messages. Go's json.Marshal emits map
// keys in sorted order, matching Python's json.dumps(..., sort_keys=True).
func promptHash(messages []message) string {
	blob, _ := json.Marshal(messages)
	sum := sha256.Sum256(blob)
	return hex.EncodeToString(sum[:])
}

func semanticKey(messages []message) string {
	norm := strings.ToLower(userText(messages))
	norm = nonAlnum.ReplaceAllString(norm, " ")
	norm = strings.TrimSpace(norm)
	norm = multiSpace.ReplaceAllString(norm, " ")
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

func estTokens(text string) int {
	if n := len(text) / 4; n > 1 {
		return n
	}
	return 1
}
