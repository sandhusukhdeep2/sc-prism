"""The optional libraries inside a PACKAGED app (2026-11-11).

LightRAG, DeepEval and the gateway daemon showed "not installed here" in the
installed app: the libraries were never packaged, and even packaged they could
not have worked —

  * both libraries kept their index / cache under ``engine/``, which in an
    installed app is inside the signed, read-only bundle;
  * LightRAG's entity extraction sent each note's text wherever the gateway's
    normal routing pointed, i.e. to the CLOUD primary on most installs — the
    one thing the vault's egress floor exists to prevent;
  * no real run ever built a retriever, so the LightRAG switch changed nothing.
"""

import asyncio
import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import deepeval_backend, extdata, lightrag_backend
from scprism_engine.__main__ import _build_retriever


class TestExtensionDataLivesOutsideTheBundle(unittest.TestCase):
    def test_the_data_folder_is_the_one_the_app_names(self):
        self.assertEqual(extdata.ext_data_dir({"SCPRISM_EXT_DATA": "/data/ext"}), "/data/ext")

    def test_without_one_it_is_the_engine_folder_as_before(self):
        self.assertEqual(extdata.ext_data_dir({}), extdata.ENGINE_DIR)
        self.assertEqual(extdata.ext_data_dir({"SCPRISM_EXT_DATA": "  "}), extdata.ENGINE_DIR)

    def test_lightrag_keeps_its_index_there(self):
        self.assertEqual(
            lightrag_backend.default_working_dir({"SCPRISM_EXT_DATA": "/data/ext"}),
            os.path.join("/data/ext", "lightrag"),
        )
        self.assertEqual(
            lightrag_backend.default_working_dir({}),
            os.path.join(extdata.ENGINE_DIR, ".lightrag"),
        )

    def test_deepeval_keeps_its_cache_there(self):
        self.assertEqual(
            deepeval_backend.deepeval_cache_dir({"SCPRISM_EXT_DATA": "/data/ext"}),
            os.path.join("/data/ext", "deepeval"),
        )
        self.assertEqual(
            deepeval_backend.deepeval_cache_dir({}),
            os.path.join(extdata.ENGINE_DIR, ".deepeval"),
        )


class _Decision:
    def __init__(self, local):
        self.is_local = local
        self.provider = "local" if local else "openai"


class _Result:
    text = "ok"
    tokens_in = 1
    tokens_out = 1
    is_real = True


class _SpyGateway:
    """Records which route each model call used."""

    def __init__(self, has_local=True):
        self._has_local = has_local
        self.used = []
        self.route_asked = 0

    def route(self, prompt):
        self.route_asked += 1
        return _Decision(local=False)  # the gateway's NORMAL pick is cloud

    def local_route_for(self, reason, matched=""):
        return _Decision(local=True) if self._has_local else None

    def model_call(self, messages, decision):
        self.used.append(decision)
        return _Result()


class TestTheGraphIndexNeverLeavesThisMac(unittest.TestCase):
    """LightRAG reads every note to extract entities. That text is vault
    content: it goes to the LOCAL model or it goes nowhere."""

    def test_every_model_call_uses_the_local_route_whatever_the_gateway_would_pick(self):
        gw = _SpyGateway()
        llm = lightrag_backend.GatewayLLM(gw)
        asyncio.run(llm("extract entities from: my salary is 90k"))
        self.assertEqual(len(gw.used), 1)
        self.assertTrue(gw.used[0].is_local)
        self.assertEqual(gw.route_asked, 0, "the gateway's own (cloud) pick was consulted")

    def test_with_no_local_model_nothing_is_sent_anywhere(self):
        gw = _SpyGateway(has_local=False)
        llm = lightrag_backend.GatewayLLM(gw)
        with self.assertRaises(lightrag_backend.LightRAGLocalOnly):
            asyncio.run(llm("extract entities from: my salary is 90k"))
        self.assertEqual(gw.used, [])

    def test_a_backend_cannot_even_be_built_without_a_local_model(self):
        with self.assertRaises(lightrag_backend.LightRAGLocalOnly):
            lightrag_backend.require_local(_SpyGateway(has_local=False))
        lightrag_backend.require_local(_SpyGateway())  # no error


class TestARealRunGetsARetrieverWhenTheSwitchIsOn(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        os.makedirs(os.path.join(self.vault, "notes"))
        with open(os.path.join(self.vault, "notes", "pricing.md"), "w", encoding="utf-8") as fh:
            fh.write("---\ntype: note\n---\n\nPricing has three tiers.\n")
        os.makedirs(os.path.join(self.vault, "verdicts"))
        with open(os.path.join(self.vault, "verdicts", "v1.md"), "w", encoding="utf-8") as fh:
            fh.write("a machine-written verdict\n")

    def tearDown(self):
        self._tmp.cleanup()

    def test_off_by_default_no_retriever_is_built(self):
        self.assertIsNone(_build_retriever(self.vault, gateway=_SpyGateway(), env={}))

    def test_on_and_runnable_builds_a_lightrag_retriever_over_the_users_notes_only(self):
        with mock.patch.object(lightrag_backend, "lightrag_available", return_value=True):
            r = _build_retriever(self.vault, gateway=_SpyGateway(), env={"SCPRISM_LIGHTRAG": "1"})
        self.assertIsNotNone(r)
        self.assertEqual(r.backend, "lightrag")
        ids = sorted(r.index.docs.keys())
        self.assertEqual(ids, ["notes/pricing.md"], "machine-written files are not indexed")

    def test_on_but_not_installed_builds_nothing(self):
        with mock.patch.object(lightrag_backend, "lightrag_available", return_value=False):
            self.assertIsNone(
                _build_retriever(self.vault, gateway=_SpyGateway(), env={"SCPRISM_LIGHTRAG": "1"})
            )

    def test_on_with_no_local_model_builds_nothing(self):
        with mock.patch.object(lightrag_backend, "lightrag_available", return_value=True):
            self.assertIsNone(
                _build_retriever(
                    self.vault, gateway=_SpyGateway(has_local=False), env={"SCPRISM_LIGHTRAG": "1"}
                )
            )


if __name__ == "__main__":
    unittest.main()
