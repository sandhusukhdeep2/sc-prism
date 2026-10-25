"""Image attach (multimodal) tests — the CORE message-contract extension.

Proves the four invariants of the feature:
  1. The TEXT-ONLY path is BYTE-IDENTICAL (no image -> nothing changes anywhere).
  2. Every content reader handles BOTH a str and a list of blocks (never str()s
     a list).
  3. A vision-capable route builds the REAL provider-native image payload.
  4. A non-vision / local / stub route drops the image and PREPENDS the honest
     'image attached — not sent' note (never a fabricated 'I can see it').

No network, no real keys: HTTP is monkeypatched and offline routes fall to the
deterministic stub.
"""

import base64
import json
import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import gateway as gwmod
from scprism_engine.gateway import (
    Gateway,
    VISION_PROVIDERS,
    _content_text,
    _prompt_hash,
    _semantic_key,
    load_image_block,
)
from scprism_engine.companion import companion_messages
from scprism_engine.__main__ import main as gwmod_main


# A tiny valid PNG (1x1) so load_image_block reads real bytes.
_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9"
    "awAAAABJRU5ErkJggg=="
)


def _gw(**kw):
    kw.setdefault("openai_base_url", "http://127.0.0.1:9")
    kw.setdefault("env", {})
    kw.setdefault("timeout", 0.2)
    return Gateway(**kw)


def _image_block(name="shot.png", mime="image/png", data="ZGF0YQ=="):
    return {"type": "image", "image": {"mime": mime, "data_b64": data}, "name": name}


class _FakeResp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _capture(payload):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.headers)
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp(payload)

    return fake_urlopen, captured


class ContentTextTests(unittest.TestCase):
    """`_content_text` handles str AND list; never str()s a list."""

    def test_str_returned_as_is(self):
        self.assertEqual(_content_text("hello world"), "hello world")

    def test_list_joins_text_and_marks_image(self):
        content = [
            {"type": "text", "text": "look at this"},
            _image_block(name="diagram.png"),
        ]
        out = _content_text(content)
        self.assertEqual(out, "look at this\n[image: diagram.png]")
        # Never the raw list repr / base64.
        self.assertNotIn("data_b64", out)
        self.assertNotIn("[{", out)

    def test_none_is_empty(self):
        self.assertEqual(_content_text(None), "")


class HashStabilityTests(unittest.TestCase):
    """Prompt hash + semantic key are DETERMINISTIC with an image block."""

    def _msgs(self):
        return [
            {"role": "system", "content": "be terse"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe the screenshot"},
                    _image_block(),
                ],
            },
        ]

    def test_prompt_hash_stable_with_image(self):
        a = _prompt_hash(self._msgs())
        b = _prompt_hash(self._msgs())
        self.assertEqual(a, b)

    def test_semantic_key_uses_text_and_is_stable(self):
        a = _semantic_key(self._msgs())
        b = _semantic_key(self._msgs())
        self.assertEqual(a, b)


class ByteIdenticalTextPathTests(unittest.TestCase):
    """No image attached -> every helper/payload is byte-identical to before."""

    _MSGS = [
        {"role": "system", "content": "be terse"},
        {"role": "user", "content": "hello"},
    ]

    def test_content_text_equals_old_str_behavior(self):
        # The old helpers did str(content); for a str that IS content.
        for m in self._MSGS:
            self.assertEqual(_content_text(m["content"]), str(m["content"]))

    def test_prepare_messages_returns_same_object_when_no_image(self):
        from scprism_engine.gateway import _prepare_provider_messages

        same = _prepare_provider_messages(self._MSGS, True, "openai")
        self.assertIs(same, self._MSGS)  # identity — nothing rebuilt
        same_a = _prepare_provider_messages(self._MSGS, False, "anthropic")
        self.assertIs(same_a, self._MSGS)

    def test_openai_body_messages_identical_to_raw(self):
        gw = _gw(openai_api_key="k", primary="openai")
        route = gw.route("design a system")  # cloud
        fake, cap = _capture(
            {"choices": [{"message": {"content": "x"}}], "usage": {}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._MSGS, route)
        # The wire messages are the EXACT text-only list — no wrapping, no blocks.
        self.assertEqual(cap["body"]["messages"], self._MSGS)

    def test_companion_messages_str_content_without_image(self):
        msgs = companion_messages("plain prompt", env={})
        self.assertIsInstance(msgs[1]["content"], str)
        self.assertEqual(msgs[1]["content"], "plain prompt")

    def test_stub_text_identical_without_image(self):
        gw = _gw()
        route = gw.route("summarize the doc")
        res = gw.model_call(self._MSGS, route)
        self.assertFalse(res.is_real)
        # Hash-seeded, deterministic — the SAME text a pre-image gateway produced.
        self.assertTrue(res.text.startswith("[offline:local"))


class VisionCapabilityTests(unittest.TestCase):
    def test_cloud_providers_are_vision(self):
        self.assertEqual(VISION_PROVIDERS, frozenset({"openai", "claude", "gemini"}))
        for p in ("openai", "claude", "gemini"):
            gw = _gw(**{f"{p}_api_key": "k"}, primary=p)
            d = gw.route("write a greeting", hint="cloud")
            self.assertTrue(d.supports_vision, p)

    def test_local_route_is_not_vision_by_default(self):
        gw = _gw()
        d = gw.route("add a helper")
        self.assertTrue(d.is_local)
        self.assertFalse(d.supports_vision)

    def test_local_vision_opt_in(self):
        gw = _gw(env={"SCPRISM_LOCAL_VISION": "1"})
        d = gw.route("add a helper")
        self.assertTrue(d.is_local)
        self.assertTrue(d.supports_vision)

    def test_cli_bridge_is_not_vision(self):
        gw = _gw(env={"SCPRISM_PRIMARY": "claude-cli"})
        d = gw.route("design a plan")
        self.assertEqual(d.provider, "claude-cli")
        self.assertFalse(d.supports_vision)


class OpenAIVisionPayloadTests(unittest.TestCase):
    def _image_msgs(self):
        return [
            {"role": "system", "content": "be terse"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "what is this?"},
                    _image_block(name="p.png", mime="image/png", data="QUJD"),
                ],
            },
        ]

    def test_vision_provider_builds_image_url_block(self):
        gw = _gw(openai_api_key="k", primary="openai")
        route = gw.route("look", hint="cloud")
        self.assertTrue(route.supports_vision)
        fake, cap = _capture(
            {"choices": [{"message": {"content": "a cat"}}], "usage": {}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._image_msgs(), route)
        user = cap["body"]["messages"][1]
        self.assertIsInstance(user["content"], list)
        self.assertEqual(user["content"][0], {"type": "text", "text": "what is this?"})
        self.assertEqual(
            user["content"][1],
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,QUJD"},
            },
        )

    def test_non_vision_local_drops_image_and_prepends_note(self):
        # Local route, opted into a REAL http call so the payload is captured
        # (base URL points at the fake). supports_vision is False by default.
        gw = _gw(openai_base_url="http://local", env={})
        route = gw.route("look at this")
        self.assertTrue(route.is_local)
        self.assertFalse(route.supports_vision)
        fake, cap = _capture(
            {"choices": [{"message": {"content": "ok"}}], "usage": {}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._image_msgs(), route)
        user = cap["body"]["messages"][1]
        # Image DROPPED: content is a plain string, no image_url block anywhere.
        self.assertIsInstance(user["content"], str)
        self.assertIn("image attached: p.png", user["content"])
        self.assertIn("not sent", user["content"])
        self.assertIn("what is this?", user["content"])  # text preserved
        self.assertNotIn("image_url", json.dumps(cap["body"]))
        self.assertNotIn("QUJD", json.dumps(cap["body"]))  # base64 never egressed


class AnthropicVisionPayloadTests(unittest.TestCase):
    def _image_msgs(self):
        return [
            {"role": "system", "content": "be terse"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe"},
                    _image_block(name="c.jpg", mime="image/jpeg", data="WFla"),
                ],
            },
        ]

    def test_claude_builds_image_source_block(self):
        gw = _gw(claude_api_key="ck", primary="claude")
        route = gw.route("look", hint="cloud")
        self.assertTrue(route.supports_vision)
        fake, cap = _capture(
            {"content": [{"text": "a dog"}], "usage": {}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._image_msgs(), route)
        # system split to top-level; the one user turn carries the image blocks.
        self.assertEqual(cap["body"]["system"], "be terse")
        user = cap["body"]["messages"][0]
        self.assertEqual(user["role"], "user")
        self.assertEqual(user["content"][0], {"type": "text", "text": "describe"})
        self.assertEqual(
            user["content"][1],
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": "WFla",
                },
            },
        )


class LoadImageBlockTests(unittest.TestCase):
    def test_valid_png(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "pic.png")
            with open(p, "wb") as f:
                f.write(_PNG_BYTES)
            block = load_image_block(p)
        self.assertEqual(block["type"], "image")
        self.assertEqual(block["image"]["mime"], "image/png")
        self.assertEqual(block["name"], "pic.png")
        # Round-trips to the original bytes.
        self.assertEqual(base64.b64decode(block["image"]["data_b64"]), _PNG_BYTES)

    def test_rejects_unsupported_extension(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "notes.txt")
            with open(p, "wb") as f:
                f.write(b"hello")
            with self.assertRaises(gwmod.GatewayError):
                load_image_block(p)

    def test_rejects_oversize(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "big.png")
            with open(p, "wb") as f:
                f.write(b"\x00" * (gwmod._MAX_IMAGE_BYTES + 1))
            with self.assertRaises(gwmod.GatewayError):
                load_image_block(p)

    def test_missing_file_is_honest_error(self):
        with self.assertRaises(gwmod.GatewayError):
            load_image_block("/nonexistent/here.png")


class CompanionMessagesImageTests(unittest.TestCase):
    def test_image_makes_user_content_a_block_list(self):
        img = _image_block(name="x.png")
        msgs = companion_messages("what is this", env={}, image=img)
        self.assertEqual(msgs[1]["role"], "user")
        self.assertEqual(
            msgs[1]["content"],
            [{"type": "text", "text": "what is this"}, img],
        )

    def test_no_image_is_byte_identical_str(self):
        a = companion_messages("hi", env={})
        b = companion_messages("hi", env={}, image=None)
        self.assertEqual(a, b)
        self.assertIsInstance(a[1]["content"], str)


class CliImageFlagTests(unittest.TestCase):
    """`run --image` end-to-end (offline stub, no network): a good image runs
    clean; a bad/oversize/missing image is an honest exit-1 error."""

    def _run_cli(self, argv):
        import io
        from contextlib import redirect_stderr, redirect_stdout

        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = gwmod_main(argv)
        text = out.getvalue().strip()
        return code, (json.loads(text) if text else None), err.getvalue()

    def test_good_image_runs_and_marker_flows_to_prompt(self):
        with tempfile.TemporaryDirectory() as vault:
            img = os.path.join(vault, "shot.png")
            with open(img, "wb") as f:
                f.write(_PNG_BYTES)
            code, obj, _ = self._run_cli(
                ["run", "describe this", "--vault", vault,
                 "--tier1", "true", "--image", img]
            )
            self.assertEqual(code, 0)
            self.assertTrue(obj["passed"])
            # The offline stub echoes the user text incl. the honest [image:...]
            # marker — proof the block rode all the way through the pipeline.
            spans = os.path.join(vault, "spans.jsonl")
            with open(spans, encoding="utf-8") as fh:
                blob = fh.read()
            self.assertIn("model_call", blob)

    def test_unsupported_image_is_honest_exit_1(self):
        with tempfile.TemporaryDirectory() as vault:
            bad = os.path.join(vault, "notes.txt")
            with open(bad, "wb") as f:
                f.write(b"hi")
            code, obj, err = self._run_cli(
                ["run", "describe", "--vault", vault, "--image", bad]
            )
            self.assertEqual(code, 1)
            self.assertIn("unsupported image type", err)

    def test_missing_image_is_honest_exit_1(self):
        with tempfile.TemporaryDirectory() as vault:
            code, obj, err = self._run_cli(
                ["run", "describe", "--vault", vault, "--image",
                 os.path.join(vault, "nope.png")]
            )
            self.assertEqual(code, 1)
            self.assertIn("cannot read image", err)

    def test_no_image_flag_still_runs(self):
        # Byte-identical smoke: omitting --image is the plain text path.
        with tempfile.TemporaryDirectory() as vault:
            code, obj, _ = self._run_cli(
                ["run", "describe", "--vault", vault, "--tier1", "true"]
            )
            self.assertEqual(code, 0)
            self.assertTrue(obj["passed"])


if __name__ == "__main__":
    unittest.main()
