from __future__ import annotations

import re
import unittest

from deploy_test_support import (
    PRODUCTION_COMPOSE,
    PRODUCTION_HEALTH_WORKFLOW,
    PRODUCTION_WORKFLOW,
    REPOSITORY_ROOT,
)


class ControlPlaneWorkflowContractTests(unittest.TestCase):
    def test_compose_build_release_matches_the_image_tag(self) -> None:
        compose = PRODUCTION_COMPOSE.read_text(encoding='utf-8')
        self.assertIn(
            'P2P_RELEASE_VERSION: ${P2P_IMAGE_TAG:?set the exact release image tag}',
            compose,
        )
        self.assertIn(
            'image: p2p-transmission:${P2P_IMAGE_TAG:?set the exact release image tag}',
            compose,
        )
        self.assertNotIn('P2P_IMAGE_TAG:-', compose)
        self.assertIn('user: "10001:10001"', compose)

    def test_production_workflow_uses_the_v3_digest_bound_supervisor(self) -> None:
        workflow = PRODUCTION_WORKFLOW.read_text(encoding='utf-8')
        self.assertIn('workflow_dispatch:', workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        turn_preflight = workflow.index('id: turn_preflight')
        stage = workflow.index('id: stage')
        control_plane = workflow.index('Verify the fixed host deployment control plane')
        verification = workflow.index('id: public_verify')
        browser_verification = workflow.index('id: public_browser_verify')
        relay_verification = workflow.index('id: public_relay_verify')
        finalize_preflight = workflow.index('id: finalize_preflight')
        finalization = workflow.index('Finalize the publicly verified release')
        rollback = workflow.index('Roll back any staged release that was not finalized')
        cleanup = workflow.index('Remove temporary remote release artifacts')
        ssh_cleanup = workflow.index('Remove temporary SSH material')

        self.assertLess(turn_preflight, stage)
        self.assertLess(control_plane, stage)
        self.assertLess(stage, verification)
        self.assertLess(verification, finalization)
        self.assertLess(verification, browser_verification)
        self.assertLess(browser_verification, relay_verification)
        self.assertLess(relay_verification, finalize_preflight)
        self.assertLess(finalize_preflight, finalization)
        self.assertLess(finalization, rollback)
        self.assertIn("steps.finalize.outcome != 'success'", workflow)
        self.assertIn("steps.stage.outcome != 'skipped'", workflow)
        self.assertNotIn("steps.stage.outcome == 'success'", workflow)
        self.assertIn('p2p-transmission-deploy finalize --version', workflow)
        self.assertIn('p2p-transmission-deploy rollback --version', workflow)
        self.assertIn('deploy/scripts/build_deployment_supervisor.py', workflow)
        self.assertIn('SUPERVISOR_BUNDLE="$RUNNER_TEMP/$SUPERVISOR"', workflow)
        self.assertIn('--output "$SUPERVISOR_BUNDLE"', workflow)
        local_private_modes = workflow.index(
            'chmod 600 "$SUPERVISOR_BUNDLE" "$SOURCE_ARCHIVE" '
            '"$IMAGE_ARCHIVE"'
        )
        first_supervisor_upload = workflow.index(
            '"$SUPERVISOR_BUNDLE" "$DEPLOY_USER@$DEPLOY_HOST:/tmp/$SUPERVISOR"'
        )
        self.assertLess(local_private_modes, first_supervisor_upload)
        self.assertIn(
            '"chmod 600 /tmp/$SUPERVISOR /tmp/$SOURCE_ARCHIVE '
            '/tmp/$IMAGE_ARCHIVE"',
            workflow,
        )
        self.assertNotIn('retired-files', workflow.lower())
        self.assertGreaterEqual(
            workflow.count('/usr/bin/python3 -I -B -X utf8 /tmp/$SUPERVISOR'),
            4,
        )
        self.assertNotIn('python3 /tmp/$SUPERVISOR', workflow)
        self.assertIn('start --operation-id', workflow)
        self.assertIn('wait --operation-id', workflow)
        self.assertNotIn('Prepare the disconnect-safe deployment supervisor', workflow)
        self.assertIn('/usr/bin/sudo -n /usr/local/sbin/p2p-transmission-deploy', workflow)
        self.assertNotIn('"sudo -n /usr/local/sbin/p2p-transmission-deploy', workflow)
        self.assertNotIn('p2p-transmission-deploy stage --archive', workflow)
        self.assertNotIn('legacy', workflow.lower())
        self.assertNotIn('protocol-version', workflow)
        self.assertNotIn('adopt-legacy', workflow)
        self.assertNotIn('--bootstrap-', workflow)
        self.assertNotIn('--mode', workflow)
        self.assertNotIn('sudo /usr/bin/python3 /tmp/', workflow)
        self.assertIn('deploy/scripts/verify-public-release.py', workflow)
        self.assertIn('control-plane-status --expected-sha256', workflow)
        self.assertIn('id: control_plane', workflow)
        self.assertIn('echo "sha256=$HELPER_SHA256" >> "$GITHUB_OUTPUT"', workflow)
        self.assertGreaterEqual(
            workflow.count('--expected-control-plane-sha256 $EXPECTED_CONTROL_PLANE_SHA256'),
            4,
        )
        self.assertGreaterEqual(
            workflow.count('${{ steps.control_plane.outputs.sha256 }}'),
            4,
        )
        finalize_preflight_block = workflow[finalize_preflight:finalization]
        self.assertIn("'git', 'ls-remote'", finalize_preflight_block)
        self.assertIn(
            'control-plane-status --expected-sha256 $EXPECTED_CONTROL_PLANE_SHA256',
            finalize_preflight_block,
        )
        self.assertIn('e2e/playwright.public.config.ts', workflow)
        self.assertIn("--grep 'relay ICE candidate$'", workflow)
        self.assertIn("--grep 'over WSS$'", workflow)
        self.assertIn("--grep 'through TURN relay$'", workflow)
        self.assertIn("steps.public_relay_verify.outcome == 'failure'", workflow)
        self.assertNotIn('/app?intent=create', workflow)

        cleanup_block = workflow[cleanup:ssh_cleanup]
        self.assertIn("steps.finalize.outcome == 'success'", cleanup_block)
        self.assertIn("steps.rollback.outcome == 'success'", cleanup_block)
        self.assertIn('cleanup --operation-id', cleanup_block)
        self.assertIn('--version $RELEASE_VERSION', cleanup_block)
        self.assertIn('--expected-control-plane-sha256', cleanup_block)
        self.assertNotIn('continue-on-error', cleanup_block)
        self.assertIn('Report preserved recovery artifacts', cleanup_block)
        self.assertIn("steps.cleanup.outcome != 'success'", cleanup_block)
        self.assertIn('p2p-transmission-deploy-$GITHUB_SHA-operation.json', cleanup_block)

        rollback_block = workflow[rollback:cleanup]
        diagnostic_start = rollback_block.index(
            'if [[ "$SUPERVISOR_STATUS" == "23" ]]'
        )
        diagnostic_end = rollback_block.index(
            '# The supervisor has proved the stage worker ended'
        )
        diagnostic_block = rollback_block[diagnostic_start:diagnostic_end]
        self.assertIn('--expected-control-plane-sha256', rollback_block)
        self.assertIn('[[ "$SUPERVISOR_STATUS" == "25" ]]', rollback_block)
        self.assertIn(
            '[[ "$SUPERVISOR_STATUS" != "0" && "$SUPERVISOR_STATUS" != "23" ]]',
            rollback_block,
        )
        self.assertLess(
            rollback_block.index('wait --operation-id'),
            rollback_block.index('failure-log --operation-id'),
        )
        self.assertLess(
            rollback_block.index('failure-log --operation-id'),
            rollback_block.index('p2p-transmission-deploy rollback --version'),
        )
        self.assertIn('[[ "$SUPERVISOR_STATUS" == "23" ]]', rollback_block)
        self.assertIn('set +e', diagnostic_block)
        self.assertIn('DIAGNOSTIC_STATUS=$?', diagnostic_block)
        self.assertIn('set -e', diagnostic_block)
        self.assertIn('Stage diagnostics unavailable', diagnostic_block)
        self.assertIn('rollback will continue', diagnostic_block)
        self.assertNotIn('exit ', diagnostic_block)
        self.assertEqual(workflow.count('failure-log --operation-id'), 1)
        self.assertNotIn('id: stage_diagnostics', workflow)
        for marker in (
            '"/usr/bin/python3 -I -B -X utf8 /tmp/$SUPERVISOR start --operation-id',
            '"/usr/bin/sudo -n /usr/local/sbin/p2p-transmission-deploy finalize',
            '"/usr/bin/sudo -n /usr/local/sbin/p2p-transmission-deploy rollback',
        ):
            command = workflow.index(marker)
            self.assertIn('ServerAliveCountMax=2', workflow[max(0, command - 300):command])

    def test_scheduled_health_checks_public_relay_and_database_restore(self) -> None:
        workflow = PRODUCTION_HEALTH_WORKFLOW.read_text(encoding='utf-8')
        self.assertIn('cron: "17 */6 * * *"', workflow)
        self.assertIn('bun run e2e:public', workflow)
        self.assertIn('p2p-transmission-deploy maintenance', workflow)
        self.assertIn('group: production', workflow)
        self.assertIn('environment:', workflow)
        self.assertIn('name: production', workflow)
        self.assertNotIn('continue-on-error', workflow)
        self.assertNotIn('cancel-in-progress: true', workflow)

    def test_every_workflow_action_is_pinned_to_an_immutable_commit(self) -> None:
        for path in (REPOSITORY_ROOT / '.github/workflows').glob('*.yml'):
            with self.subTest(path=path.name):
                workflow = path.read_text(encoding='utf-8')
                revisions = re.findall(r'\buses:\s+[^\s@]+@([^\s#]+)', workflow)
                self.assertTrue(revisions)
                self.assertTrue(all(re.fullmatch(r'[0-9a-f]{40}', value) for value in revisions))


if __name__ == '__main__':
    unittest.main()
