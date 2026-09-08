#!/usr/bin/env python3
"""First-install transaction, run on the target host. Dry-run unless --execute.

The reviewed plan is prepared from deploy/plan.example.json and must contain
archiveSha256 and expectedVhostSha256. This program never opens the provider env
file, connects over SSH, installs an AIX, or controls unrelated application services.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid


RUNTIME_FILES = frozenset({
    "server/index.mjs", "server/game.mjs", "server/provider.mjs", "server/service.mjs",
    "server/admin.mjs", "server/monitor.mjs",
    "admin/index.html", "admin/main.js", "admin/view.js", "admin/style.css",
    "web/index.html", "web/main.js", "web/speech.js", "web/style.css", "web/phase-ui.js", "web/lobby.js",
    "lib/client.js", "package.json", "package-lock.json",
})
MAX_ARCHIVE = 20 * 1024 * 1024
MAX_EXPANDED = 10 * 1024 * 1024
FIXED_TARGETS = {
    "codeDirectory": "/opt/aiui-werewolf", "service": "werewolf.service", "port": 8790,
    "config": "/etc/aiui-werewolf/config.json",
    "nginxSnippet": "/etc/nginx/snippets/werewolf-location.conf",
}


class DeployError(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_plan(filename):
    try:
        plan = json.loads(Path(filename).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise DeployError("Cannot read deployment plan JSON") from None
    if not isinstance(plan, dict):
        raise DeployError("Deployment plan must be a JSON object")
    for key, value in FIXED_TARGETS.items():
        if plan.get(key) != value:
            raise DeployError("Plan changes a protected first-install target: " + key)
    for key in ("archiveSha256", "expectedVhostSha256"):
        if not isinstance(plan.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", plan[key]):
            raise DeployError("Plan needs a reviewed lowercase SHA-256: " + key)
    for key in ("nginxVhost", "providerSource"):
        value = plan.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", value) or ".." in Path(value).parts:
            raise DeployError("Plan needs a safe absolute path: " + key)
    if not plan["nginxVhost"].startswith("/etc/nginx/"):
        raise DeployError("The reviewed vhost must be inside /etc/nginx")
    from urllib.parse import urlsplit
    web = urlsplit(str(plan.get("webUrl", "")))
    socket = urlsplit(str(plan.get("socketUrl", "")))
    if web.scheme != "https" or not web.hostname or web.path != "/werewolf/" or web.query or web.fragment or web.username or web.password:
        raise DeployError("webUrl must be the reviewed HTTPS /werewolf/ URL")
    if socket.scheme != "wss" or socket.netloc != web.netloc or socket.path != "/werewolf/ws" or socket.query or socket.fragment or socket.username or socket.password:
        raise DeployError("socketUrl must match the reviewed WSS endpoint")
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", web.hostname):
        raise DeployError("Invalid public host name")
    existing = plan.get("existingEndpointsToVerify", [])
    if not isinstance(existing, list) or not existing:
        raise DeployError("At least one existing application health endpoint must be checked")
    for value in existing:
        parsed = urlsplit(value) if isinstance(value, str) else None
        if not parsed or parsed.scheme != "https" or parsed.netloc != web.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise DeployError("Existing health endpoint must be on the reviewed HTTPS host")
    plan = dict(plan)
    plan["hostname"] = web.hostname
    return plan


def load_archive(filename, expected_hash):
    archive = Path(filename)
    if not archive.is_file() or archive.is_symlink() or archive.stat().st_size > MAX_ARCHIVE:
        raise DeployError("Source archive must be a regular file below 20 MiB")
    archive_data = archive.read_bytes()
    if digest(archive_data) != expected_hash:
        raise DeployError("Source archive SHA-256 does not match the reviewed plan")
    result = {}
    total = 0
    parents = {str(Path(name).parent) for name in RUNTIME_FILES}
    try:
        with tarfile.open(fileobj=io.BytesIO(archive_data), mode="r:*") as bundle:
            for number, member in enumerate(bundle):
                if number >= 80:
                    raise DeployError("Too many archive entries")
                name = member.name
                while name.startswith("./"):
                    name = name[2:]
                if name in ("", ".") and member.isdir():
                    continue
                if name.startswith("/") or ".." in PurePosixPath(name).parts or "\\" in name:
                    raise DeployError("Archive contains an unsafe path")
                name = str(PurePosixPath(name))
                if member.isdir() and name in parents:
                    continue
                if name not in RUNTIME_FILES or name in result or not member.isfile() or member.issparse():
                    raise DeployError("Archive contains an unexpected, duplicate or non-regular entry")
                if member.size > 2 * 1024 * 1024 or member.size < 0:
                    raise DeployError("Archive member is too large")
                total += member.size
                if total > MAX_EXPANDED:
                    raise DeployError("Expanded source archive is too large")
                handle = bundle.extractfile(member)
                value = handle.read(member.size + 1)
                if len(value) != member.size:
                    raise DeployError("Archive member size mismatch")
                result[name] = value
    except (tarfile.TarError, OSError):
        raise DeployError("Source archive cannot be read") from None
    if set(result) != RUNTIME_FILES:
        raise DeployError("Source archive is missing required runtime files")
    try:
        package = json.loads(result["package.json"])
        lock = json.loads(result["package-lock.json"])
        if package.get("name") != "aiui-werewolf" or not re.fullmatch(r"\d+\.\d+\.\d+", package.get("version", "")):
            raise ValueError()
        if package.get("dependencies") != {"ws": "8.21.3"}:
            raise ValueError()
        if lock.get("lockfileVersion") != 3 or lock.get("version") != package["version"]:
            raise ValueError()
        if lock.get("packages", {}).get("", {}).get("dependencies") != package["dependencies"]:
            raise ValueError()
        for name, dependency in lock["packages"].items():
            if name and not dependency.get("dev"):
                if name != "node_modules/ws" or dependency.get("version") != "8.21.3" or not str(dependency.get("resolved", "")).startswith("https://registry.npmjs.org/") or not str(dependency.get("integrity", "")).startswith("sha512-"):
                    raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise DeployError("Package and lock file do not match the reviewed runtime dependency contract") from None
    return result, package["version"]


def nginx_tokens(source):
    """Tokenize braces while ignoring comments and quoted contents; never regex-rewrite blocks."""
    tokens = []
    pos = 0
    while pos < len(source):
        char = source[pos]
        if char.isspace():
            pos += 1
            continue
        if char == "#":
            end = source.find("\n", pos)
            pos = len(source) if end == -1 else end + 1
            continue
        start = pos
        if char in "{};":
            tokens.append((char, start, start + 1, True))
            pos += 1
            continue
        if char in "\"'":
            quote = char
            pos += 1
            value = ""
            while pos < len(source) and source[pos] != quote:
                if source[pos] == "\\":
                    pos += 1
                    if pos == len(source):
                        raise DeployError("Unterminated nginx quote")
                value += source[pos]
                pos += 1
            if pos == len(source):
                raise DeployError("Unterminated nginx quote")
            pos += 1
        else:
            while pos < len(source) and not source[pos].isspace() and source[pos] not in "{};#":
                if source[pos] in "\"'\\":
                    raise DeployError("Unsupported nginx token; review the vhost manually")
                pos += 1
            value = source[start:pos]
        tokens.append((value, start, pos, False))
    return tokens


def insert_nginx_include(original, hostname, snippet):
    try:
        source = original.decode("utf-8")
    except UnicodeDecodeError:
        raise DeployError("Vhost is not UTF-8") from None
    if snippet in source or re.search(r"\blocation\b[^;{}]*/werewolf", source):
        raise DeployError("Vhost already contains a werewolf route or include")
    tokens = nginx_tokens(source)

    def scope(index, nested=False):
        nodes = []
        while index < len(tokens):
            if tokens[index][3] and tokens[index][0] == "}":
                if not nested:
                    raise DeployError("Unexpected nginx closing brace")
                return nodes, index + 1, tokens[index][1]
            words = []
            while index < len(tokens) and not tokens[index][3]:
                words.append(tokens[index][0])
                index += 1
            if not words or index == len(tokens):
                raise DeployError("Unsupported nginx directive structure")
            if tokens[index][0] == ";":
                nodes.append({"words": words, "children": None})
                index += 1
            elif tokens[index][0] == "{":
                children, index, closing = scope(index + 1, True)
                nodes.append({"words": words, "children": children, "closing": closing})
            else:
                raise DeployError("Unterminated nginx directive")
        if nested:
            raise DeployError("Unterminated nginx block")
        return nodes, index, None

    tree, _, _ = scope(0)
    matches = []

    def visit(nodes):
        for node in nodes:
            children = node["children"]
            if node["words"] == ["server"] and children is not None:
                names = [child["words"][1:] for child in children if child["words"][0] == "server_name" and child["children"] is None]
                listeners = [child["words"][1:] for child in children if child["words"][0] == "listen" and child["children"] is None]
                if any(hostname in values for values in names) and any(values and re.search(r"(?:^|:)443$", values[0]) for values in listeners):
                    matches.append(node)
            if children:
                visit(children)
    visit(tree)
    if len(matches) != 1:
        raise DeployError("Expected exactly one explicit HTTPS server block for the reviewed host")
    offset = matches[0]["closing"]
    return (source[:offset] + "\n    include " + snippet + ";\n" + source[offset:]).encode("utf-8")


class Runner:
    def run(self, argv, cwd=None):
        try:
            result = subprocess.run(argv, cwd=cwd, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        except (OSError, subprocess.TimeoutExpired):
            raise DeployError("Command unavailable or timed out: " + Path(argv[0]).name) from None
        if result.returncode:
            # Do not echo startup output, nginx text or secret-bearing environment.
            raise DeployError("Command failed: " + Path(argv[0]).name + " (exit " + str(result.returncode) + ")")
        return result.stdout.strip()


def probe_health(url, expected_version=None):
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            if response.status != 200:
                raise ValueError()
            body = response.read(65537)
            if len(body) > 65536:
                raise ValueError()
            data = json.loads(body)
            if not isinstance(data, dict) or data.get("ok") is not True:
                raise ValueError()
            if expected_version is not None and (data.get("app") != "aiui-werewolf" or data.get("version") != expected_version or data.get("aiConfigured") is not True or data.get("maxPlayers") != 6):
                raise ValueError()
            return True
    except (OSError, ValueError):
        raise DeployError("Health check failed for a reviewed endpoint") from None


def require_free_port():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 8790))
    except OSError:
        raise DeployError("Loopback port 8790 is already in use or unavailable") from None


class Installer:
    def __init__(self, plan, files, version, runner=None, health=None, filesystem_root=None, account=None, sleep=time.sleep, port_check=None):
        self.plan, self.files, self.version = plan, files, version
        self.runner = runner or Runner()
        self.health = health or probe_health
        self.filesystem_root = Path(filesystem_root) if filesystem_root else None
        self.account = account
        self.sleep = sleep
        self.port_check = port_check or require_free_port
        self.created = []
        self.started = self.enabled = self.unit_written = self.vhost_attempted = False
        self.backup = None
        self.rollback_errors = []

    def path(self, absolute):
        return self.filesystem_root / absolute.lstrip("/") if self.filesystem_root else Path(absolute)

    def command(self, *args, cwd=None):
        return self.runner.run(list(args), cwd=cwd)

    def preflight(self):
        p = self.plan
        self.code = self.path(p["codeDirectory"])
        self.config_dir = self.path(p["config"]).parent
        self.unit = self.path("/etc/systemd/system/" + p["service"])
        self.wants = self.path("/etc/systemd/system/multi-user.target.wants/" + p["service"])
        self.snippet = self.path(p["nginxSnippet"])
        self.vhost = self.path(p["nginxVhost"])
        for item in (self.code, self.config_dir, self.unit, self.wants, self.snippet):
            if os.path.lexists(item):
                raise DeployError("First install refused: a new application target already exists")
        for parent in (self.code.parent, self.config_dir.parent, self.unit.parent, self.snippet.parent, self.vhost.parent):
            if not parent.is_dir() or parent.is_symlink():
                raise DeployError("Expected existing real parent directory is missing")
        if not self.vhost.is_file() or self.vhost.is_symlink():
            raise DeployError("Reviewed vhost must be a regular file")
        self.original = self.vhost.read_bytes()
        self.original_stat = self.vhost.stat()
        if digest(self.original) != p["expectedVhostSha256"]:
            raise DeployError("Vhost SHA-256 changed since the reviewed preflight")
        self.patched = insert_nginx_include(self.original, p["hostname"], p["nginxSnippet"])
        # Only a metadata check. The existing environment file is not opened here.
        provider = self.path(p["providerSource"])
        if not provider.is_file():
            raise DeployError("Existing provider environment source is unavailable")
        if self.account is None:
            try:
                entry = pwd.getpwnam("ubuntu")
                self.account = (entry.pw_uid, entry.pw_gid)
            except KeyError:
                raise DeployError("Expected service account ubuntu is unavailable") from None
        node = self.command("/usr/bin/node", "--version")
        if not re.fullmatch(r"v\d+\.\d+\.\d+", node) or int(node[1:].split(".")[0]) < 20:
            raise DeployError("Node.js 20 or newer is required at /usr/bin/node")
        self.command("/usr/bin/npm", "--version")
        if self.command("systemctl", "show", p["service"], "--property=LoadState", "--value") != "not-found":
            raise DeployError("The new service is already known to systemd")
        self.port_check()
        self.command("nginx", "-t")
        for endpoint in p["existingEndpointsToVerify"]:
            self.health(endpoint)

    def record(self, path):
        meta = path.lstat()
        self.created.append((path, meta.st_dev, meta.st_ino))

    def mkdir(self, path, mode=0o750):
        path.mkdir(mode=mode)
        self.record(path)

    def new_file(self, path, data, mode=0o644):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            self.record(path)

    def atomic_vhost(self, data):
        temporary = self.vhost.with_name("." + self.vhost.name + ".werewolf-write-" + uuid.uuid4().hex)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IMODE(self.original_stat.st_mode))
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
                os.fchmod(handle.fileno(), stat.S_IMODE(self.original_stat.st_mode))
                os.fchown(handle.fileno(), self.original_stat.st_uid, self.original_stat.st_gid)
            os.replace(temporary, self.vhost)
        finally:
            if temporary.exists():
                temporary.unlink()

    def wait_health(self, url):
        for attempt in range(40):
            try:
                self.health(url, self.version)
                return
            except DeployError:
                if attempt == 39:
                    raise
                self.sleep(0.5)

    def service_text(self):
        return ("[Unit]\nDescription=MoonTable AIUI Werewolf game\nWants=network-online.target\nAfter=network-online.target\n\n"
                "[Service]\nType=simple\nUser=ubuntu\nGroup=ubuntu\nWorkingDirectory=/opt/aiui-werewolf\n"
                "Environment=NODE_ENV=production\nEnvironment=WEREWOLF_CONFIG=/etc/aiui-werewolf/config.json\n"
                "ExecStart=/usr/bin/node /opt/aiui-werewolf/server/index.mjs\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=15\n"
                "UMask=0077\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=read-only\nPrivateTmp=true\nPrivateDevices=true\n"
                "ProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\n"
                "RestrictRealtime=true\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nAmbientCapabilities=\n\n"
                "[Install]\nWantedBy=multi-user.target\n").encode()

    def snippet_text(self):
        return ("location = /werewolf {\n    return 308 /werewolf/;\n}\n\nlocation /werewolf/ {\n"
                "    proxy_pass http://127.0.0.1:8790;\n    proxy_http_version 1.1;\n"
                "    proxy_set_header Host $host;\n    proxy_set_header Upgrade $http_upgrade;\n"
                "    proxy_set_header Connection \"upgrade\";\n    proxy_read_timeout 90s;\n"
                "    proxy_send_timeout 90s;\n    proxy_buffering off;\n}\n").encode()

    def execute(self):
        self.preflight()
        if self.filesystem_root is None and os.geteuid() != 0:
            raise DeployError("Execution on the target requires root privileges")
        try:
            self.backup = self.vhost.with_name("." + self.vhost.name + ".werewolf-backup-" + uuid.uuid4().hex)
            self.new_file(self.backup, self.original, 0o600)
            # Preserve this exact original even when rollback is needed.
            self.created.pop()
            stage = self.code.parent / (".aiui-werewolf-stage-" + uuid.uuid4().hex)
            self.mkdir(stage)
            uid, gid = self.account
            os.chown(stage, uid, gid)
            for name, data in self.files.items():
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
                os.chown(target.parent, uid, gid)
                target.write_bytes(data)
                target.chmod(0o640)
                os.chown(target, uid, gid)
            self.command("runuser", "-u", "ubuntu", "--", "/usr/bin/npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", str(stage / ".npm-cache"), cwd=str(stage))
            for name, data in self.files.items():
                if digest((stage / name).read_bytes()) != digest(data):
                    raise DeployError("A reviewed source file changed during dependency installation")
            for name in sorted(self.files):
                if name.endswith((".mjs", ".js")):
                    self.command("runuser", "-u", "ubuntu", "--", "/usr/bin/node", "--check", str(stage / name))
            cache = stage / ".npm-cache"
            if cache.exists():
                shutil.rmtree(cache)
            # An exclusive empty placeholder prevents replacing an existing install.
            self.mkdir(self.code)
            if self.code.stat().st_ino != self.created[-1][2]:
                raise DeployError("New code destination changed concurrently")
            os.replace(stage, self.code)
            self.created.pop()
            self.record(self.code)
            self.mkdir(self.config_dir)
            os.chown(self.config_dir, 0 if self.filesystem_root is None else os.getuid(), gid)
            config = {"host": "127.0.0.1", "port": 8790, "deepseekEnvFile": self.plan["providerSource"], "model": "deepseek-v4-flash"}
            self.new_file(self.path(self.plan["config"]), (json.dumps(config, indent=2) + "\n").encode(), 0o640)
            os.chown(self.path(self.plan["config"]), 0 if self.filesystem_root is None else os.getuid(), gid)
            self.new_file(self.snippet, self.snippet_text())
            self.new_file(self.unit, self.service_text())
            self.unit_written = True
            self.command("systemctl", "daemon-reload")
            self.started = True
            self.command("systemctl", "start", "werewolf.service")
            self.command("systemctl", "is-active", "--quiet", "werewolf.service")
            self.wait_health("http://127.0.0.1:8790/werewolf/health")
            self.command("systemctl", "is-active", "--quiet", "werewolf.service")
            if digest(self.vhost.read_bytes()) != self.plan["expectedVhostSha256"]:
                raise DeployError("Vhost changed concurrently before cutover")
            self.vhost_attempted = True
            self.atomic_vhost(self.patched)
            self.command("nginx", "-t")
            self.command("systemctl", "reload", "nginx")
            self.wait_health(self.plan["webUrl"] + "health")
            for endpoint in self.plan["existingEndpointsToVerify"]:
                self.health(endpoint)
            self.enabled = True
            self.command("systemctl", "enable", "werewolf.service")
            return {"status": "DEPLOYED", "version": self.version, "archiveSha256": self.plan["archiveSha256"], "webUrl": self.plan["webUrl"], "backup": str(self.backup)}
        except Exception as error:
            self.rollback()
            message = str(error) if isinstance(error, DeployError) else "Deployment operation failed"
            raise DeployError(message + "; " + ("rollback incomplete; preserve files and inspect backup" if self.rollback_errors else "rollback completed; original vhost backup preserved") + (" at " + str(self.backup) if self.backup else "")) from None

    def rollback(self):
        def attempt(label, callback):
            try:
                callback()
            except Exception:
                self.rollback_errors.append(label)
        if self.started:
            attempt("stop-new-service", lambda: self.command("systemctl", "stop", "werewolf.service"))
        if self.enabled:
            attempt("disable-new-service", lambda: self.command("systemctl", "disable", "werewolf.service"))
        if self.vhost_attempted:
            def restore():
                current = digest(self.vhost.read_bytes())
                if current not in (digest(self.original), digest(self.patched)):
                    raise DeployError("Vhost was changed by another operator")
                if current == digest(self.patched):
                    self.atomic_vhost(self.original)
                self.command("nginx", "-t")
                self.command("systemctl", "reload", "nginx")
            attempt("restore-vhost", restore)
        # If stopping/restoring failed, retain the concrete files for manual recovery.
        if not self.rollback_errors:
            for item, device, inode in reversed(self.created):
                if not os.path.lexists(item):
                    continue
                def remove(item=item, device=device, inode=inode):
                    meta = item.lstat()
                    if (meta.st_dev, meta.st_ino) != (device, inode):
                        raise DeployError("Created path was replaced by another operator")
                    if stat.S_ISDIR(meta.st_mode):
                        shutil.rmtree(item)
                    else:
                        item.unlink()
                attempt("remove-created-path", remove)
            if self.unit_written:
                attempt("reload-unit-index", lambda: self.command("systemctl", "daemon-reload"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, help="Reviewed runtime .tar.gz, without credentials or node_modules")
    parser.add_argument("--plan", required=True, help="Reviewed plan JSON containing archiveSha256 and expectedVhostSha256")
    parser.add_argument("--execute", action="store_true", help="Perform the already-authorized first installation on this host")
    args = parser.parse_args(argv)
    try:
        plan = read_plan(args.plan)
        files, version = load_archive(args.archive, plan["archiveSha256"])
        installer = Installer(plan, files, version)
        if args.execute:
            result = installer.execute()
        else:
            installer.preflight()
            result = {"status": "DRY_RUN_OK", "version": version, "files": sorted(files), "service": plan["service"], "codeDirectory": plan["codeDirectory"], "webUrl": plan["webUrl"], "vhostOriginalSha256": plan["expectedVhostSha256"], "vhostPatchedSha256": digest(installer.patched), "mutated": False}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except DeployError as error:
        print(json.dumps({"status": "FAILED", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
