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

    def _ready_env(self):
        data = os.path.join(self._tmp.name, "ext")
        env = {"SCPRISM_LIGHTRAG": "1", "SCPRISM_EXT_DATA": data}
        lightrag_backend.mark_index_ready(lightrag_backend.default_working_dir(env), docs=1)
        return env

    # 2026-11-11: building the graph reads EVERY note through the local model —
    # minutes of work. Done inside a run it would hold a chat turn (or a
    # heartbeat wake) for all of it. A run therefore only USES a graph that has
    # already been built; building is its own explicit step.
    def test_a_run_never_builds_the_graph_it_only_uses_one_that_is_ready(self):
        env = {"SCPRISM_LIGHTRAG": "1", "SCPRISM_EXT_DATA": os.path.join(self._tmp.name, "ext")}
        with mock.patch.object(lightrag_backend, "lightrag_available", return_value=True):
            self.assertIsNone(_build_retriever(self.vault, gateway=_SpyGateway(), env=env))
        self.assertFalse(lightrag_backend.index_ready(lightrag_backend.default_working_dir(env)))

    def test_on_and_runnable_builds_a_lightrag_retriever_over_the_users_notes_only(self):
        with mock.patch.object(lightrag_backend, "lightrag_available", return_value=True):
            r = _build_retriever(self.vault, gateway=_SpyGateway(), env=self._ready_env())
        self.assertTrue(r.attach_only, "a run attaches to the built graph, it never inserts")
        self.assertIsNotNone(r)
        self.assertEqual(r.backend, "lightrag")
        ids = sorted(r.index.docs.keys())
        self.assertEqual(ids, ["notes/pricing.md"], "machine-written files are not indexed")

    def test_on_but_not_installed_builds_nothing(self):
        with mock.patch.object(lightrag_backend, "lightrag_available", return_value=False):
            self.assertIsNone(
                _build_retriever(self.vault, gateway=_SpyGateway(), env=self._ready_env())
            )

    def test_on_with_no_local_model_builds_nothing(self):
        with mock.patch.object(lightrag_backend, "lightrag_available", return_value=True):
            self.assertIsNone(
                _build_retriever(
                    self.vault, gateway=_SpyGateway(has_local=False), env=self._ready_env()
                )
            )


if __name__ == "__main__":
    unittest.main()


class TestAChatTurnKeepsTheConversationJudge(unittest.TestCase):
    """2026-11-11, found by running the installed app's own engine with the
    DeepEval switch on: a one-sentence answer to a chat question was graded on
    TASK metrics (trajectory, tool use, acceptance, completion), cost seven
    judge calls, and FAILED at 0.61 — "a trivial factual-definition request
    with no file state to inspect". DeepEval's metrics are for tasks. A converse
    turn keeps the built-in judge, which grades a reply as a reply."""

    def _evaluate(self, mode):
        from scprism_engine import evals
        from scprism_engine.contract import parse
        from scprism_engine.dispatcher import ModelResult

        gateway = mock.Mock()
        gateway.route.return_value = mock.Mock(is_local=True, provider="local", model="m", reason="r")
        gateway.model_call.return_value = mock.Mock(
            text="not json", tokens_in=1, tokens_out=1, is_real=False, cache="miss", truncated=False
        )
        contract = parse("In one sentence, what is a markdown note?", mode=mode)
        trace = mock.Mock()
        trace.results = [ModelResult(text="A plain-text file.", tokens=3, route="local")]
        trace.steps = []
        with mock.patch.object(deepeval_backend, "deepeval_available", return_value=True), \
             mock.patch.object(deepeval_backend, "run_deepeval") as run_de:
            run_de.return_value = mock.Mock()
            try:
                evals.evaluate(contract, trace, gateway=gateway, backend="deepeval")
            except Exception:
                pass  # the stdlib judge may reject the bare mocks; only the choice is under test
            return run_de.called

    def test_a_converse_turn_is_not_handed_to_deepeval(self):
        self.assertFalse(self._evaluate("converse"))

    def test_a_task_still_is(self):
        self.assertTrue(self._evaluate("read"))


class TestBuildingTheGraphIsItsOwnStep(unittest.TestCase):
    """`graph-index` — the explicit build a run never does (2026-11-11)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = os.path.join(self._tmp.name, "vault")
        os.makedirs(os.path.join(self.vault, "notes"))
        for name in ("a", "b"):
            with open(os.path.join(self.vault, "notes", f"{name}.md"), "w", encoding="utf-8") as fh:
                fh.write(f"---\ntype: note\n---\n\nNote {name}.\n")
        self.env = {"SCPRISM_EXT_DATA": os.path.join(self._tmp.name, "ext")}
        self.workdir = lightrag_backend.default_working_dir(self.env)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, argv, *, available=True, saw_real=True, has_local=True):
        import io
        import json
        from contextlib import redirect_stderr, redirect_stdout
        from scprism_engine.__main__ import main

        indexed = {}

        class _FakeBackend:
            def __init__(self, gateway, **kw):
                lightrag_backend.require_local(gateway)
                self.llm = mock.Mock(calls=4, saw_real=saw_real)

            def index_docs(self, docs):
                indexed["ids"] = sorted(d.doc_id for d in docs)
                return self

        out = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=False), \
             mock.patch.object(lightrag_backend, "lightrag_available", return_value=available), \
             mock.patch.object(lightrag_backend, "LightRAGBackend", _FakeBackend), \
             mock.patch("scprism_engine.bifrost_client.make_gateway", return_value=_SpyGateway(has_local=has_local)), \
             redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = main(argv)
        return code, json.loads(out.getvalue()), indexed

    def test_it_indexes_the_users_notes_and_marks_the_graph_ready(self):
        code, obj, indexed = self._run(["graph-index", "--vault", self.vault])
        self.assertEqual(code, 0)
        self.assertTrue(obj["ok"])
        self.assertEqual(obj["docs"], 2)
        self.assertEqual(indexed["ids"], ["notes/a.md", "notes/b.md"])
        self.assertTrue(lightrag_backend.index_ready(self.workdir))

    def test_a_local_model_that_never_answered_builds_nothing(self):
        code, obj, _ = self._run(["graph-index", "--vault", self.vault], saw_real=False)
        self.assertEqual(code, 1)
        self.assertFalse(obj["ok"])
        self.assertIn("did not answer", obj["reason"])
        self.assertFalse(lightrag_backend.index_ready(self.workdir))

    def test_no_local_model_is_refused_in_plain_words(self):
        code, obj, _ = self._run(["graph-index", "--vault", self.vault], has_local=False)
        self.assertEqual(code, 1)
        self.assertIn("no local model", obj["reason"])
        self.assertFalse(lightrag_backend.index_ready(self.workdir))

    def test_without_the_library_it_says_so(self):
        code, obj, _ = self._run(["graph-index", "--vault", self.vault], available=False)
        self.assertEqual(code, 1)
        self.assertIn("LightRAG", obj["reason"])

    def test_status_reports_whether_the_graph_is_built(self):
        code, obj, _ = self._run(["graph-index", "--vault", self.vault, "--status"])
        self.assertEqual(code, 0)
        self.assertEqual(obj["ready"], False)
        self.assertEqual(obj["notes"], 2)
        self._run(["graph-index", "--vault", self.vault])
        code, obj, _ = self._run(["graph-index", "--vault", self.vault, "--status"])
        self.assertEqual(obj["ready"], True)
        self.assertEqual(obj["docs"], 2)
