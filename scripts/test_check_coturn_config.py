from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from scripts import check_coturn_config


ROOT = Path(__file__).resolve().parents[1]
TURN_CONFIG = ROOT / "deploy" / "coturn" / "turnserver.conf.example"
VERIFY_WORKFLOW = ROOT / ".github" / "workflows" / "verify.yml"
PRODUCTION_WORKFLOW = ROOT / ".github" / "workflows" / "production.yml"


def valid_compose_model() -> dict[str, object]:
    def volume(source: str, target: str) -> dict[str, object]:
        return {
            "type": "bind",
            "source": f"/workspace/deploy/coturn/{source}",
            "target": target,
            "read_only": True,
            "bind": {"create_host_path": False},
        }

    return {
        "services": {
            "coturn": {
                "image": "coturn/coturn:4.14.0-r0",
                "network_mode": "host",
                "restart": "unless-stopped",
                "command": ["-c", "/etc/coturn/turnserver.conf"],
                "volumes": [
                    volume(".local/turnserver.conf", "/etc/coturn/turnserver.conf"),
                    volume(
                        ".local/tls/fullchain.pem",
                        "/run/coturn/tls/fullchain.pem",
                    ),
                    volume(
                        ".local/tls/privkey.pem",
                        "/run/coturn/tls/privkey.pem",
                    ),
                ],
            }
        }
    }


class ComposePolicyTests(unittest.TestCase):
    def test_loader_requests_non_normalized_compose_output(self) -> None:
        compose_file = ROOT / "deploy" / "coturn" / "compose.yml"
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(valid_compose_model()),
            stderr="",
        )

        with patch.object(
            check_coturn_config.subprocess,
            "run",
            return_value=completed,
        ) as run:
            model = check_coturn_config.load_compose_model(compose_file)

        self.assertEqual(model, valid_compose_model())
        self.assertEqual(
            run.call_args.args[0],
            [
                "docker",
                "compose",
                "-f",
                str(compose_file),
                "config",
                "--no-normalize",
                "--format",
                "json",
            ],
        )

    def test_expected_compose_model_passes(self) -> None:
        self.assertEqual(
            check_coturn_config.validate_compose_model(valid_compose_model()),
            [],
        )

    def test_mutable_image_and_writable_secret_mount_fail(self) -> None:
        model = deepcopy(valid_compose_model())
        service = model["services"]["coturn"]  # type: ignore[index]
        service["image"] = "coturn/coturn:latest"  # type: ignore[index]
        service["volumes"][0]["read_only"] = False  # type: ignore[index]

        errors = check_coturn_config.validate_compose_model(model)

        self.assertTrue(any("explicit versioned" in error for error in errors))
        self.assertTrue(any("read-only" in error for error in errors))

    def test_bind_mount_must_not_create_missing_secret_paths(self) -> None:
        valid_model = valid_compose_model()
        service = valid_model["services"]["coturn"]  # type: ignore[index]

        for index, volume in enumerate(service["volumes"]):  # type: ignore[index]
            with self.subTest(target=volume["target"]):
                model = deepcopy(valid_model)
                coturn = model["services"]["coturn"]  # type: ignore[index]
                coturn["volumes"][index]["bind"]["create_host_path"] = True  # type: ignore[index]

                errors = check_coturn_config.validate_compose_model(model)

                self.assertTrue(
                    any(
                        volume["target"] in error
                        and "automatic host-path" in error
                        for error in errors
                    )
                )


class TurnPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = TURN_CONFIG.read_text(encoding="utf-8")

    def test_checked_in_policy_passes(self) -> None:
        self.assertEqual(check_coturn_config.validate_turn_config(self.policy), [])

    def test_shared_secret_authentication_is_required(self) -> None:
        policy = self.policy.replace("use-auth-secret\n", "", 1)

        errors = check_coturn_config.validate_turn_config(policy)

        self.assertTrue(any("use-auth-secret" in error for error in errors))

    def test_checked_in_policy_must_not_contain_a_real_secret(self) -> None:
        policy = self.policy.replace(
            "# static-auth-secret=<same value as P2P_TURN_SECRET>",
            "static-auth-secret=not-a-real-secret",
            1,
        )

        errors = check_coturn_config.validate_turn_config(policy)

        self.assertTrue(any("active TURN shared secret" in error for error in errors))
        self.assertTrue(any("placeholder" in error for error in errors))

    def test_private_and_loopback_peer_denials_are_required(self) -> None:
        policy = self.policy.replace(
            "denied-peer-ip=10.0.0.0-10.255.255.255\n",
            "",
            1,
        )

        errors = check_coturn_config.validate_turn_config(policy)

        self.assertTrue(any("10.0.0.0-10.255.255.255" in error for error in errors))

    def test_example_endpoints_must_remain_non_production_placeholders(self) -> None:
        policy = self.policy.replace("turn.example.com", "turn.real.example", 1)

        errors = check_coturn_config.validate_turn_config(policy)

        self.assertTrue(any("realm" in error for error in errors))


class WorkflowRoutingTests(unittest.TestCase):
    def test_pull_requests_and_main_releases_do_not_duplicate_expensive_jobs(self) -> None:
        verify = VERIFY_WORKFLOW.read_text(encoding="utf-8")
        production = PRODUCTION_WORKFLOW.read_text(encoding="utf-8")
        production_triggers = production.split("permissions:", 1)[0]

        self.assertIn("pull_request:", verify)
        self.assertEqual(verify.count("if: github.event_name == 'pull_request'"), 2)
        self.assertNotIn("pull_request:", production_triggers)
        self.assertIn("needs: [coturn, native, wasm, e2e, container]", production)

    def test_turn_gate_has_lightweight_main_paths_and_release_dependencies(self) -> None:
        verify = VERIFY_WORKFLOW.read_text(encoding="utf-8")
        production = PRODUCTION_WORKFLOW.read_text(encoding="utf-8")

        for path in (
            '"deploy/coturn/**"',
            '"scripts/check_coturn_config.py"',
            '"scripts/test_check_coturn_config.py"',
        ):
            self.assertIn(path, verify)
        for command in (
            "python -X utf8 -m unittest scripts/test_check_coturn_config.py",
            "python -X utf8 scripts/check_coturn_config.py",
        ):
            self.assertIn(command, verify)
            self.assertIn(command, production)
        self.assertIn('"!scripts/check_coturn_config.py"', production)
        self.assertIn('"!scripts/test_check_coturn_config.py"', production)
        self.assertIn("needs: [coturn, native, wasm]", production)


if __name__ == "__main__":
    unittest.main()
