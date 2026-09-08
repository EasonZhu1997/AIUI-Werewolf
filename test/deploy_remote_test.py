"""Installer tests use only temporary files and fake system commands. No SSH/API."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deploy_remote", PROJECT / "tools/deploy-remote.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
VHOST = b'''# old application configuration\nserver { listen 80; server_name example.test; return 308 https://$host$request_uri; }\nserver {\n listen 443 ssl;\n server_name example.test;\n add_header X-Literal "{ }";\n location /aitalk/ { proxy_pass http://127.0.0.1:8787; }\n location / { proxy_set_header Connection ""; proxy_pass http://127.0.0.1:8000; }\n}\n'''


class FakeRunner:
    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail

    def run(self, args, cwd=None):
        self.calls.append((args, cwd))
        if self.fail and self.fail(args, self.calls):
            raise deploy.DeployError("Injected command failure")
        if args == ["/usr/bin/node", "--version"]:
            return "v22.19.0"
        if args == ["/usr/bin/npm", "--version"]:
            return "10.9.3"
        if args[:2] == ["systemctl", "show"]:
            return "not-found"
        return ""


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="werewolf-installer-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = {name: (PROJECT / name).read_bytes() for name in deploy.RUNTIME_FILES}
        self.archive = self.root / "source.tar.gz"
        self.make_archive()
        self.plan_data = {
            **deploy.FIXED_TARGETS,
            "nginxVhost": "/etc/nginx/sites-available/test.conf",
            "providerSource": "/home/ubuntu/provider.env",
            "webUrl": "https://example.test/werewolf/",
            "socketUrl": "wss://example.test/werewolf/ws",
            "existingEndpointsToVerify": ["https://example.test/aitalk/health"],
            "archiveSha256": deploy.digest(self.archive.read_bytes()),
            "expectedVhostSha256": deploy.digest(VHOST),
        }
        self.plan_file = self.root / "plan.json"
        self.plan_file.write_text(json.dumps(self.plan_data))
        self.plan = deploy.read_plan(self.plan_file)
        self.fs = self.root / "target"
        for parent in ["opt", "etc/nginx/sites-available", "etc/nginx/snippets", "etc/systemd/system/multi-user.target.wants", "home/ubuntu"]:
            (self.fs / parent).mkdir(parents=True, exist_ok=True)
        self.vhost = self.fs / self.plan["nginxVhost"].lstrip("/")
        self.vhost.write_bytes(VHOST)
        self.provider = self.fs / self.plan["providerSource"].lstrip("/")
        self.provider.write_text("DEEPSEEK_API_KEY=PRIVATE_SENTINEL_NEVER_READ\n")
        self.health_calls = []

    def make_archive(self, extra=None):
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in self.files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            if extra:
                info, data = extra
                archive.addfile(info, io.BytesIO(data))

    def health(self, url, version=None):
        self.health_calls.append((url, version))
        return True

    def installer(self, runner=None, health=None):
        return deploy.Installer(self.plan, self.files, "0.1.3", runner=runner or FakeRunner(), health=health or self.health,
                                filesystem_root=self.fs, account=(os.getuid(), os.getgid()), sleep=lambda _: None, port_check=lambda: None)

    def snapshot(self):
        return {str(p.relative_to(self.fs)): p.read_bytes() for p in self.fs.rglob("*") if p.is_file()}

    def test_reviewed_archive_and_plan_are_required(self):
        files, version = deploy.load_archive(self.archive, self.plan["archiveSha256"])
        self.assertEqual(set(files), deploy.RUNTIME_FILES)
        self.assertEqual(version, "0.1.3")
        with self.assertRaisesRegex(deploy.DeployError, "SHA-256"):
            deploy.load_archive(self.archive, "0" * 64)
        for key, value in [("service", "coach.service"), ("codeDirectory", "/opt/intercom"), ("expectedVhostSha256", "")]:
            with self.subTest(key=key):
                self.plan_file.write_text(json.dumps({**self.plan_data, key: value}))
                with self.assertRaises(deploy.DeployError):
                    deploy.read_plan(self.plan_file)

    def test_archive_rejects_secrets_traversal_links_duplicates_and_missing_files(self):
        for name, kind in [("private-config.json", tarfile.REGTYPE), ("../escape", tarfile.REGTYPE), ("server/link.mjs", tarfile.SYMTYPE), ("server/game.mjs", tarfile.REGTYPE)]:
            with self.subTest(name=name):
                info = tarfile.TarInfo(name)
                info.type = kind
                info.linkname = "/etc/passwd"
                self.make_archive((info, b""))
                with self.assertRaises(deploy.DeployError):
                    deploy.load_archive(self.archive, deploy.digest(self.archive.read_bytes()))
        del self.files["server/game.mjs"]
        self.make_archive()
        with self.assertRaisesRegex(deploy.DeployError, "missing"):
            deploy.load_archive(self.archive, deploy.digest(self.archive.read_bytes()))

    def test_nginx_include_targets_only_the_exact_https_server(self):
        result = deploy.insert_nginx_include(VHOST, "example.test", self.plan["nginxSnippet"])
        self.assertEqual(result.count(b"include /etc/nginx/snippets/werewolf-location.conf;"), 1)
        self.assertTrue(result.startswith(VHOST[:VHOST.index(b"server {\n")]))
        self.assertIn(b'add_header X-Literal "{ }";', result)
        self.assertIn(b'proxy_set_header Connection "";', result)
        self.assertIn(b"location /aitalk/ { proxy_pass http://127.0.0.1:8787; }", result)
        for source in [VHOST + VHOST, result, VHOST.replace(b"example.test", b"other.test")]:
            with self.assertRaises(deploy.DeployError):
                deploy.insert_nginx_include(source, "example.test", self.plan["nginxSnippet"])

    def test_preflight_is_read_only_and_never_opens_provider_source(self):
        before = self.snapshot()
        instance = self.installer()
        original = Path.open
        def guarded(path, *args, **kwargs):
            if path == self.provider:
                raise AssertionError("Installer opened provider env")
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", guarded):
            instance.preflight()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(instance.runner.calls), 4)
        self.assertFalse(any("start" in call or "reload" in call for call, _ in instance.runner.calls))

    def test_first_install_refuses_all_existing_targets_before_mutation(self):
        for target in ["/opt/aiui-werewolf", "/etc/aiui-werewolf", "/etc/nginx/snippets/werewolf-location.conf", "/etc/systemd/system/werewolf.service", "/etc/systemd/system/multi-user.target.wants/werewolf.service"]:
            with self.subTest(target=target):
                path = self.fs / target.lstrip("/")
                path.write_text("PREVIOUS_OPERATOR_DATA")
                before = self.snapshot()
                with self.assertRaisesRegex(deploy.DeployError, "already exists"):
                    self.installer().execute()
                self.assertEqual(self.snapshot(), before)
                path.unlink()
        self.vhost.write_bytes(VHOST + b"# concurrent edit\n")
        before = self.snapshot()
        with self.assertRaisesRegex(deploy.DeployError, "SHA-256"):
            self.installer().execute()
        self.assertEqual(self.snapshot(), before)

    def test_success_starts_only_new_service_and_keeps_original_backup(self):
        runner = FakeRunner()
        result = self.installer(runner).execute()
        self.assertEqual(result["status"], "DEPLOYED")
        self.assertEqual(Path(result["backup"]).read_bytes(), VHOST)
        self.assertNotEqual(self.vhost.read_bytes(), VHOST)
        self.assertEqual((self.fs / "opt/aiui-werewolf/server/game.mjs").read_bytes(), self.files["server/game.mjs"])
        config = json.loads((self.fs / "etc/aiui-werewolf/config.json").read_text())
        self.assertEqual(config["deepseekEnvFile"], self.plan["providerSource"])
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(result) + json.dumps(config))
        calls = [args for args, _ in runner.calls]
        self.assertIn(["systemctl", "start", "werewolf.service"], calls)
        self.assertIn(["systemctl", "enable", "werewolf.service"], calls)
        self.assertFalse(any("coach.service" in args or "intercom.service" in args for args in calls))
        npm = next(args for args in calls if "ci" in args)
        self.assertIn("--ignore-scripts", npm)
        self.assertIn("--omit=dev", npm)
        self.assertLess(calls.index(["systemctl", "start", "werewolf.service"]), calls.index(["systemctl", "reload", "nginx"]))
        self.assertEqual(self.health_calls.count((self.plan["existingEndpointsToVerify"][0], None)), 2)
        self.assertEqual(calls.count(["systemctl", "is-active", "--quiet", "werewolf.service"]), 2)

    def test_occupied_port_refuses_install_without_creating_files(self):
        instance = self.installer()
        instance.port_check = lambda: (_ for _ in ()).throw(deploy.DeployError("port occupied"))
        before = self.snapshot()
        with self.assertRaisesRegex(deploy.DeployError, "port occupied"):
            instance.execute()
        self.assertEqual(self.snapshot(), before)

    def test_inactive_new_unit_rolls_back_before_accepting_any_health_response(self):
        runner = FakeRunner(lambda args, _: args == ["systemctl", "is-active", "--quiet", "werewolf.service"])
        self.assert_clean_rollback(runner)
        self.assertFalse(any(version is not None for _, version in self.health_calls))

    def assert_clean_rollback(self, runner=None, health=None):
        with self.assertRaisesRegex(deploy.DeployError, "rollback completed"):
            self.installer(runner, health).execute()
        self.assertEqual(self.vhost.read_bytes(), VHOST)
        for name in ["opt/aiui-werewolf", "etc/aiui-werewolf", "etc/nginx/snippets/werewolf-location.conf", "etc/systemd/system/werewolf.service"]:
            self.assertFalse((self.fs / name).exists(), name)
        self.assertEqual(len(list(self.vhost.parent.glob("*.werewolf-backup-*"))), 1)
        self.assertFalse(list((self.fs / "opt").glob(".aiui-werewolf-stage-*")))

    def test_npm_failure_removes_only_new_stage_and_preserves_vhost(self):
        self.assert_clean_rollback(FakeRunner(lambda args, _: "ci" in args))

    def test_failed_new_service_health_never_modifies_nginx(self):
        runner = FakeRunner()
        def health(url, version=None):
            if version:
                raise deploy.DeployError("health failed")
        self.assert_clean_rollback(runner, health)
        self.assertNotIn(["systemctl", "reload", "nginx"], [args for args, _ in runner.calls])
        self.assertIn(["systemctl", "stop", "werewolf.service"], [args for args, _ in runner.calls])

    def test_nginx_syntax_failure_restores_vhost_before_reload(self):
        runner = FakeRunner(lambda args, calls: args == ["nginx", "-t"] and sum(a == ["nginx", "-t"] for a, _ in calls) == 2)
        self.assert_clean_rollback(runner)
        calls = [args for args, _ in runner.calls]
        self.assertEqual(calls.count(["systemctl", "reload", "nginx"]), 1, "only rollback reload occurs")

    def test_failure_after_public_cutover_restores_exact_previous_configuration(self):
        runner = FakeRunner()
        def health(url, version=None):
            if url == self.plan["webUrl"] + "health":
                raise deploy.DeployError("public health failed")
        self.assert_clean_rollback(runner, health)
        self.assertEqual([args for args, _ in runner.calls].count(["systemctl", "reload", "nginx"]), 2)

    def test_rollback_preserves_paths_if_new_service_cannot_stop(self):
        runner = FakeRunner(lambda args, _: args == ["systemctl", "stop", "werewolf.service"])
        def health(url, version=None):
            if version:
                raise deploy.DeployError("health failed")
        with self.assertRaisesRegex(deploy.DeployError, "rollback incomplete"):
            self.installer(runner, health).execute()
        self.assertTrue((self.fs / "opt/aiui-werewolf").exists())
        self.assertTrue((self.fs / "etc/systemd/system/werewolf.service").exists())
        self.assertEqual(self.vhost.read_bytes(), VHOST)

    def test_cli_requires_explicit_execute_for_mutations(self):
        class DryInstaller:
            executed = False
            patched = b"reviewed patch"
            def __init__(self, *args):
                pass
            def preflight(self):
                pass
            def execute(self):
                DryInstaller.executed = True
                raise AssertionError("Default CLI executed mutations")
        output = io.StringIO()
        with patch.object(deploy, "Installer", DryInstaller), contextlib.redirect_stdout(output):
            result = deploy.main(["--archive", str(self.archive), "--plan", str(self.plan_file)])
        self.assertEqual(result, 0)
        self.assertFalse(DryInstaller.executed)
        self.assertFalse(json.loads(output.getvalue())["mutated"])


if __name__ == "__main__":
    unittest.main()
