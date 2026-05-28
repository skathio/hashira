// Shim for the `dotnet-pack-version` composite action.
//
// Two responsibilities, both pure functions (no env access) so they can be
// unit-tested in isolation:
//   1. `detectMinVerReference(projectText)` — given the raw text of a
//      .csproj/.sln/Directory.Packages.props/etc., return true iff a
//      `<PackageReference Include="MinVer" ...>` element is present.
//      Uses a permissive regex (whitespace-tolerant, attribute-order-
//      tolerant) — we don't pull in a real XML parser for the same
//      portability reason `parse-coverage.js` doesn't.
//   2. `parseNupkgVersion(filename)` — given a `.nupkg` filename (e.g.
//      `MyLib.1.2.3.nupkg` or `My.Pkg.1.2.3-alpha.4.5.nupkg`), return
//      `{ packageId, version }`. Throws on malformed input.
//
// Plus a tiny helper:
//   `pickFirstNupkg(filenames)` — given a list of basenames, return the
//   first that parses; throws if none do.
//
// XML parsing of MinVer-ref is deliberately permissive: a real consumer
// project may carry MinVer as a Directory.Build.props/.targets PackageReference,
// or inline in the .csproj. We only check the file the consumer points us
// at; if missing we WARN (not fail) since the consumer may use another
// versioning scheme.

'use strict';

// Match `<PackageReference ... Include="MinVer" ...>` (or single quotes)
// across one or many lines. Whitespace and other attributes are allowed
// around `Include="MinVer"`. Case-sensitive: "MinVer" is the canonical id.
const MINVER_REF_RE =
  /<PackageReference\b[^>]*\bInclude\s*=\s*["']MinVer["'][^>]*\/?>/;

function detectMinVerReference(projectText) {
  if (typeof projectText !== 'string' || projectText.length === 0) {
    return false;
  }
  return MINVER_REF_RE.test(projectText);
}

// `<PackageId>.<Version>.nupkg` where Version follows SemVer 2.0
// (digits.digits.digits[-prerelease][+build]). PackageId may contain dots.
// We anchor on the .nupkg suffix and walk backward: the version is the
// longest suffix that starts with a digit and matches the SemVer-ish shape.
//
// Examples we must handle:
//   MyLib.1.2.3.nupkg                 -> id=MyLib              version=1.2.3
//   My.Pkg.Id.1.2.3.nupkg             -> id=My.Pkg.Id          version=1.2.3
//   My.Pkg.1.2.3-alpha.4.5.nupkg      -> id=My.Pkg             version=1.2.3-alpha.4.5
//   My.Pkg.1.2.3-rc.1+build.7.nupkg   -> id=My.Pkg             version=1.2.3-rc.1+build.7
//
// We do NOT accept .snupkg here — that's a symbol package; callers select
// the .nupkg explicitly. We also reject filenames without `.nupkg` suffix.
//
// Version regex: major.minor.patch with optional pre-release and build
// metadata per SemVer 2.0.
const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseNupkgVersion(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('parseNupkgVersion: filename must be a non-empty string');
  }
  if (!filename.endsWith('.nupkg')) {
    throw new Error(
      `parseNupkgVersion: '${filename}' does not have .nupkg suffix`
    );
  }
  const stem = filename.slice(0, -'.nupkg'.length);
  // Walk from the leftmost digit-run candidate forward; the first split
  // where the right-hand side is a valid SemVer wins. Walking left-to-right
  // (rather than right-to-left) handles package-ids whose final segment
  // happens to be all digits (rare but legal).
  const parts = stem.split('.');
  for (let i = 1; i < parts.length; i++) {
    // Version candidate is parts[i..]; it must start with a digit.
    if (!/^\d/.test(parts[i])) {
      continue;
    }
    const version = parts.slice(i).join('.');
    if (SEMVER_RE.test(version)) {
      const packageId = parts.slice(0, i).join('.');
      if (packageId.length === 0) {
        // E.g. "1.2.3.nupkg" — version with no id. Reject.
        continue;
      }
      return { packageId, version };
    }
  }
  throw new Error(
    `parseNupkgVersion: '${filename}' does not match <id>.<semver>.nupkg shape`
  );
}

function pickFirstNupkg(filenames) {
  if (!Array.isArray(filenames) || filenames.length === 0) {
    throw new Error('pickFirstNupkg: no .nupkg files found');
  }
  const errors = [];
  for (const f of filenames) {
    try {
      const parsed = parseNupkgVersion(f);
      return { filename: f, ...parsed };
    } catch (e) {
      errors.push(`${f}: ${e.message}`);
    }
  }
  throw new Error(
    `pickFirstNupkg: no candidate parsed cleanly: ${errors.join('; ')}`
  );
}

module.exports = {
  detectMinVerReference,
  parseNupkgVersion,
  pickFirstNupkg,
  MINVER_REF_RE,
  SEMVER_RE,
};
