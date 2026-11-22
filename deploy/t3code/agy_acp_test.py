"""Unit tests for deploy/t3code/agy-acp mode translation."""
import importlib.machinery
import importlib.util
import pathlib
import unittest


def _load_agy_acp():
    script_path = pathlib.Path(__file__).resolve().with_name("agy-acp")
    loader = importlib.machinery.SourceFileLoader("agy_acp", str(script_path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


agy_acp = _load_agy_acp()


class ModeBridgeTests(unittest.TestCase):
    def test_preserves_yolo_across_set_mode_and_updates(self):
        bridge = agy_acp.ModeBridge()

        outbound = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/set_mode",
            "params": {"sessionId": "s1", "modeId": "yolo"},
        })
        self.assertEqual(outbound["params"]["modeId"], "accept-edits")

        update = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "current_mode_update",
                    "currentModeId": "accept-edits",
                },
            },
        })
        self.assertEqual(update["params"]["update"]["currentModeId"], "yolo")

        resp = bridge.to_client({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "modes": {
                    "availableModes": [{"id": "default", "name": "Default"}],
                    "currentModeId": "accept-edits",
                },
            },
        })
        self.assertEqual(resp["result"]["modes"]["currentModeId"], "yolo")

    def test_preserves_yolo_for_set_config_option_without_session_id_in_result(self):
        bridge = agy_acp.ModeBridge()

        outbound = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": "req-42",
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "mode", "value": "yolo"},
        })
        self.assertEqual(outbound["params"]["value"], "accept-edits")

        resp = bridge.to_client({
            "jsonrpc": "2.0",
            "id": "req-42",
            "result": {
                "configOptions": [
                    {"id": "mode", "category": "mode", "currentValue": "accept-edits", "options": []},
                ],
            },
        })
        self.assertEqual(resp["result"]["configOptions"][0]["currentValue"], "yolo")

        cfg_update = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [
                        {"id": "mode", "category": "mode", "currentValue": "accept-edits", "options": []},
                    ],
                },
            },
        })
        self.assertEqual(cfg_update["params"]["update"]["configOptions"][0]["currentValue"], "yolo")

    def test_auto_edit_and_default_sessions_stay_isolated_from_yolo(self):
        bridge = agy_acp.ModeBridge()

        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/set_mode",
            "params": {"sessionId": "s-yolo", "modeId": "yolo"},
        })
        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/set_mode",
            "params": {"sessionId": "s-auto", "modeId": "auto_edit"},
        })

        u_yolo = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s-yolo", "update": {"currentModeId": "accept-edits"}},
        })
        u_auto = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s-auto", "update": {"currentModeId": "accept-edits"}},
        })
        u_fresh = bridge.to_client({
            "jsonrpc": "2.0",
            "id": 99,
            "result": {
                "sessionId": "s-fresh",
                "modes": {"currentModeId": "accept-edits", "availableModes": []},
            },
        })

        self.assertEqual(u_yolo["params"]["update"]["currentModeId"], "yolo")
        self.assertEqual(u_auto["params"]["update"]["currentModeId"], "auto_edit")
        self.assertEqual(u_fresh["result"]["modes"]["currentModeId"], "auto_edit")

    def test_switching_from_yolo_to_auto_edit_or_default_clears_yolo(self):
        bridge = agy_acp.ModeBridge()

        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/set_mode",
            "params": {"sessionId": "s1", "modeId": "yolo"},
        })
        bridge.to_client({"jsonrpc": "2.0", "id": 1, "result": {}})

        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/set_mode",
            "params": {"sessionId": "s1", "modeId": "auto_edit"},
        })
        u_auto = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s1", "update": {"currentModeId": "accept-edits"}},
        })
        self.assertEqual(u_auto["params"]["update"]["currentModeId"], "auto_edit")

        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/set_mode",
            "params": {"sessionId": "s1", "modeId": "default"},
        })
        u_default = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s1", "update": {"currentModeId": "default"}},
        })
        self.assertEqual(u_default["params"]["update"]["currentModeId"], "default")

    def test_error_response_reverts_remembered_mode(self):
        bridge = agy_acp.ModeBridge()

        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/set_mode",
            "params": {"sessionId": "s1", "modeId": "auto_edit"},
        })
        bridge.to_client({"jsonrpc": "2.0", "id": 1, "result": {}})

        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/set_mode",
            "params": {"sessionId": "s1", "modeId": "yolo"},
        })
        bridge.to_client({
            "jsonrpc": "2.0",
            "id": 2,
            "error": {"code": -32602, "message": "mode rejected"},
        })

        u_after_err = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s1", "update": {"currentModeId": "accept-edits"}},
        })
        self.assertEqual(u_after_err["params"]["update"]["currentModeId"], "auto_edit")

    def test_inflight_default_update_does_not_clobber_pending_yolo(self):
        bridge = agy_acp.ModeBridge()

        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/set_mode",
            "params": {"sessionId": "s1", "modeId": "yolo"},
        })
        # Stale update from before set_mode took effect arrives while id=1 is still pending.
        stale = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s1", "update": {"currentModeId": "default"}},
        })
        self.assertEqual(stale["params"]["update"]["currentModeId"], "default")

        # Subsequent accept-edits update must still map back to yolo.
        applied = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s1", "update": {"currentModeId": "accept-edits"}},
        })
        self.assertEqual(applied["params"]["update"]["currentModeId"], "yolo")

    def test_agent_initiated_default_clears_yolo_when_idle(self):
        bridge = agy_acp.ModeBridge()

        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/set_mode",
            "params": {"sessionId": "s1", "modeId": "yolo"},
        })
        bridge.to_client({"jsonrpc": "2.0", "id": 1, "result": {}})

        bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s1", "update": {"currentModeId": "default"}},
        })
        later = bridge.to_client({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s1", "update": {"currentModeId": "accept-edits"}},
        })
        self.assertEqual(later["params"]["update"]["currentModeId"], "auto_edit")

    def test_clamps_out_of_range_thought_level_for_active_model(self):
        bridge = agy_acp.ModeBridge()

        bridge.to_client({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "sessionId": "s1",
                "configOptions": [
                    {"id": "model", "category": "model", "currentValue": "claude-opus-5.5", "options": []},
                    {
                        "id": "thought_level",
                        "category": "thought_level",
                        "currentValue": "high",
                        "options": [
                            {"value": "low", "name": "Low"},
                            {"value": "medium", "name": "Medium"},
                            {"value": "high", "name": "High"},
                        ],
                    },
                ],
            },
        })

        clamped_xhigh = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "thought_level", "value": "xhigh"},
        })
        self.assertEqual(clamped_xhigh["params"]["value"], "high")

        clamped_max = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "thought_level", "value": "max"},
        })
        self.assertEqual(clamped_max["params"]["value"], "high")

        supported = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "thought_level", "value": "low"},
        })
        self.assertEqual(supported["params"]["value"], "low")

    def test_thought_level_tracks_model_switch_and_pipelined_switch(self):
        bridge = agy_acp.ModeBridge()

        bridge.to_client({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "sessionId": "s1",
                "configOptions": [
                    {"id": "model", "category": "model", "currentValue": "claude-opus-4.6", "options": []},
                    {
                        "id": "thought_level",
                        "category": "thought_level",
                        "currentValue": "high",
                        "options": [
                            {"value": "low", "name": "Low"},
                            {"value": "medium", "name": "Medium"},
                            {"value": "high", "name": "High"},
                            {"value": "xhigh", "name": "XHigh"},
                            {"value": "max", "name": "Max"},
                        ],
                    },
                ],
            },
        })

        # Switch to claude-opus-5.5 whose response has no sessionId (correlates via msg_id).
        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "model", "value": "claude-opus-5.5"},
        })
        bridge.to_client({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "configOptions": [
                    {"id": "model", "category": "model", "currentValue": "claude-opus-5.5", "options": []},
                    {
                        "id": "thought_level",
                        "category": "thought_level",
                        "currentValue": "high",
                        "options": [
                            {"value": "low", "name": "Low"},
                            {"value": "medium", "name": "Medium"},
                            {"value": "high", "name": "High"},
                        ],
                    },
                ],
            },
        })

        # Switch back to claude-opus-4.6 and pipeline thought_level=max before response arrives.
        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "model", "value": "claude-opus-4.6"},
        })
        pipelined_max = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "thought_level", "value": "max"},
        })
        self.assertEqual(pipelined_max["params"]["value"], "max")

        # Pipeline switch back to cached claude-opus-5.5 and thought_level=xhigh.
        bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "model", "value": "claude-opus-5.5"},
        })
        pipelined_clamped = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "thought_level", "value": "xhigh"},
        })
        self.assertEqual(pipelined_clamped["params"]["value"], "high")

    def test_thought_level_passthrough_when_unknown_or_empty(self):
        bridge = agy_acp.ModeBridge()

        before_init = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "thought_level", "value": "xhigh"},
        })
        self.assertEqual(before_init["params"]["value"], "xhigh")

        # Model without thought_level configOption leaves request unchanged.
        bridge.to_client({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "sessionId": "s1",
                "configOptions": [
                    {"id": "model", "category": "model", "currentValue": "gpt-oss-120b", "options": []},
                ],
            },
        })
        after_flat = bridge.to_agent({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/set_config_option",
            "params": {"sessionId": "s1", "configId": "thought_level", "value": "high"},
        })
        self.assertEqual(after_flat["params"]["value"], "high")


if __name__ == "__main__":
    unittest.main()
