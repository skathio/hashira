#!/usr/bin/env python3
"""scan-suite's OSV scan treats a repo with no lockfiles as nothing to scan.

hashira's own checkout under `.hashira` is excluded from the OSV scan. A
consumer whose only manifest has no lockfile (a NuGet project without
packages.lock.json) then gives osv-scanner no package sources, and it exits
128. With fail_on_findings that exit fails scan-suite and `ci / passed` on
every run, with nothing for the consumer to fix. `--allow-no-lockfiles` makes
osv-scanner exit 0 for that case and still fail on real findings.

Run: python3 tests/scan-suite/test_osv_no_lockfiles.py
"""

import os
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OSV_ACTION = os.path.join(ROOT, ".github", "actions", "scan-suite", "scans", "osv", "action.yml")


def osv_scan_args():
    with open(OSV_ACTION, encoding="utf-8") as fh:
        steps = yaml.safe_load(fh)["runs"]["steps"]
    step = next(s for s in steps if s.get("id") == "osv")
    return step["with"]["scan-args"].split("\n")


class OsvNoLockfiles(unittest.TestCase):
    def test_no_package_sources_is_not_a_failure(self):
        self.assertIn("--allow-no-lockfiles", [a.strip() for a in osv_scan_args()])

    def test_hashira_checkout_stays_excluded(self):
        self.assertIn("--experimental-exclude=.hashira", [a.strip() for a in osv_scan_args()])

    def test_consumer_paths_stay_the_last_argument(self):
        self.assertEqual(osv_scan_args()[-1].strip(), "${{ inputs.paths }}")


if __name__ == "__main__":
    unittest.main()
