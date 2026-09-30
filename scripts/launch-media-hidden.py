"""Windowless scheduled-task entry point; run with pythonw.exe on Windows."""
import argparse
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-home', required=True)
    parser.add_argument('--workspace')
    args = parser.parse_args()
    root = Path(args.runtime_home).resolve()
    script = Path(args.workspace).resolve()/'scripts/start-media.ps1' if args.workspace else root/'start-media.ps1'
    command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
               '-ExecutionPolicy', 'Bypass', '-File', str(script), '-RuntimeHome', str(root)]
    if args.workspace:
        command += ['-Workspace', str(Path(args.workspace).resolve())]
    (root/'logs').mkdir(parents=True, exist_ok=True)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    with (root/'logs/hidden-launcher.log').open('ab', buffering=0) as log:
        return subprocess.call(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                               creationflags=subprocess.CREATE_NO_WINDOW, startupinfo=startup,
                               cwd=root)


if __name__ == '__main__':
    if os.name != 'nt':
        raise SystemExit('This launcher requires Windows')
    raise SystemExit(main())
