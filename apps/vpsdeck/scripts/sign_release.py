#!/usr/bin/env python3
"""Sign a release APK locally; private material never enters project or delivery.
Requires JDK17 and Android build-tools 34.0.0. Does not upload anything.
"""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile


def run(*args):
    subprocess.run([str(x) for x in args], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--key-dir", type=Path, default=Path.home() / ".vpsdeck-signing")
    parser.add_argument("--create-key", action="store_true", help="Explicitly permit creating a new long-term signing identity")
    args = parser.parse_args()
    if not args.apk.is_file() or args.output.exists():
        parser.error("Input must exist and output must not exist")
    key_dir = args.key_dir.expanduser().resolve()
    project = Path(__file__).resolve().parents[1]
    delivery = args.output.resolve().parent
    if key_dir == project or project in key_dir.parents or key_dir == delivery or delivery in key_dir.parents:
        parser.error("Signing keys must be outside source and delivery directories")
    tools = args.sdk.expanduser() / "build-tools" / "34.0.0"
    for tool in ("zipalign", "apksigner"):
        if not (tools / tool).is_file():
            parser.error(f"Missing {tools / tool}")
    java_home = os.environ.get("JAVA_HOME")
    keytool = Path(java_home) / "bin/keytool" if java_home else shutil.which("keytool")
    if not keytool:
        parser.error("Set JAVA_HOME to JDK17")
    os.umask(0o077)
    key_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    key_dir.chmod(0o700)
    keystore = key_dir / "release.p12"
    password = key_dir / "store-password"
    if not keystore.exists():
        if not args.create_key:
            parser.error("No signing key; use --create-key once to create your local signing identity")
        if password.exists():
            parser.error("Partial key setup exists; inspect it rather than overwriting private material")
        with password.open("x") as f:
            f.write(secrets.token_urlsafe(48) + "\n")
        run(keytool, "-genkeypair", "-keystore", keystore, "-storetype", "PKCS12",
            "-storepass:file", password, "-alias", "vpsdeck", "-keyalg", "RSA",
            "-keysize", "3072", "-validity", "10000", "-dname", "CN=VPS Deck Local Release", "-noprompt")
    if not password.is_file():
        parser.error("Missing signing password file")
    keystore.chmod(0o600)
    password.chmod(0o600)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="vpsdeck-sign-") as tmp:
        aligned = Path(tmp) / "aligned.apk"
        signed = Path(tmp) / "signed.apk"
        run(tools / "zipalign", "-p", "4", args.apk, aligned)
        run(tools / "apksigner", "sign", "--ks", keystore, "--ks-key-alias", "vpsdeck",
            "--ks-pass", f"file:{password}", "--out", signed, aligned)
        run(tools / "apksigner", "verify", "--verbose", "--print-certs", signed)
        # Exclusive destination creation also protects against accidental replacement.
        with args.output.open("xb") as dest, signed.open("rb") as source:
            shutil.copyfileobj(source, dest)
    print(f"Verified signed APK: {args.output}")
    print(f"Keep a private backup of {key_dir}; never put it in Git or Android Download.")


if __name__ == "__main__":
    main()
