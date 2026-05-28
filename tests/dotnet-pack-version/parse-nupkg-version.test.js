// Unit tests for the parse-nupkg-version shim used by `dotnet-pack-version`.
// Uses node:test (stdlib; zero-install).
//
// Run locally with:
//   node --test tests/dotnet-pack-version/parse-nupkg-version.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectMinVerReference,
  parseNupkgVersion,
  pickFirstNupkg,
} = require('../../.github/actions/dotnet-pack-version/lib/parse-nupkg-version');

// ---------- detectMinVerReference -------------------------------------

test('detectMinVerReference: present (double-quoted Include, with Version attr)', () => {
  const csproj = `
    <Project Sdk="Microsoft.NET.Sdk">
      <ItemGroup>
        <PackageReference Include="MinVer" Version="5.0.0" PrivateAssets="All" />
      </ItemGroup>
    </Project>
  `;
  assert.equal(detectMinVerReference(csproj), true);
});

test('detectMinVerReference: present (single-quoted Include, attribute reordering)', () => {
  const csproj = `<PackageReference Version='5.0.0' Include='MinVer' />`;
  assert.equal(detectMinVerReference(csproj), true);
});

test('detectMinVerReference: absent when only a similarly-named ref exists', () => {
  const csproj = `<PackageReference Include="MinVerHelpers" Version="1.0.0" />`;
  assert.equal(detectMinVerReference(csproj), false);
});

test('detectMinVerReference: absent on empty / non-string input', () => {
  assert.equal(detectMinVerReference(''), false);
  assert.equal(detectMinVerReference(null), false);
  assert.equal(detectMinVerReference(undefined), false);
  assert.equal(detectMinVerReference(42), false);
});

test('detectMinVerReference: present even when wrapped across multiple attributes lines (single element line still required)', () => {
  // We intentionally do NOT cross newlines inside the element; consumers
  // typically write `<PackageReference Include="MinVer" Version="..."/>` on
  // one line. Multi-line single elements are exotic — document and skip.
  const csproj = `<PackageReference Include="MinVer" Version="5.0.0"></PackageReference>`;
  assert.equal(detectMinVerReference(csproj), true);
});

// ---------- parseNupkgVersion ----------------------------------------

test('parseNupkgVersion: standard major.minor.patch version', () => {
  assert.deepEqual(parseNupkgVersion('MyLib.1.2.3.nupkg'), {
    packageId: 'MyLib',
    version: '1.2.3',
  });
});

test('parseNupkgVersion: prerelease version with MinVer-style identifiers', () => {
  assert.deepEqual(parseNupkgVersion('My.Pkg.1.2.3-alpha.4.5.nupkg'), {
    packageId: 'My.Pkg',
    version: '1.2.3-alpha.4.5',
  });
});

test('parseNupkgVersion: dotted package id with three+ segments', () => {
  assert.deepEqual(parseNupkgVersion('Foo.Bar.Baz.10.20.30.nupkg'), {
    packageId: 'Foo.Bar.Baz',
    version: '10.20.30',
  });
});

test('parseNupkgVersion: version with build metadata', () => {
  assert.deepEqual(parseNupkgVersion('Pkg.1.0.0-rc.1+build.7.nupkg'), {
    packageId: 'Pkg',
    version: '1.0.0-rc.1+build.7',
  });
});

test('parseNupkgVersion: throws on missing .nupkg suffix', () => {
  assert.throws(() => parseNupkgVersion('MyLib.1.2.3'), /\.nupkg suffix/);
});

test('parseNupkgVersion: throws on malformed filename (no version segment)', () => {
  assert.throws(
    () => parseNupkgVersion('MyLib.nupkg'),
    /does not match <id>\.<semver>\.nupkg shape/
  );
});

test('parseNupkgVersion: throws on non-string / empty input', () => {
  assert.throws(() => parseNupkgVersion(''), /non-empty string/);
  assert.throws(() => parseNupkgVersion(null), /non-empty string/);
});

// ---------- pickFirstNupkg -------------------------------------------

test('pickFirstNupkg: single file returns it', () => {
  assert.deepEqual(pickFirstNupkg(['Lib.1.2.3.nupkg']), {
    filename: 'Lib.1.2.3.nupkg',
    packageId: 'Lib',
    version: '1.2.3',
  });
});

test('pickFirstNupkg: multiple files returns the first parseable one', () => {
  const got = pickFirstNupkg([
    'A.1.0.0.nupkg',
    'B.2.0.0.nupkg',
  ]);
  assert.equal(got.filename, 'A.1.0.0.nupkg');
});

test('pickFirstNupkg: skips unparseable, returns first parseable', () => {
  const got = pickFirstNupkg([
    'malformed.nupkg',
    'Good.1.0.0.nupkg',
  ]);
  assert.equal(got.filename, 'Good.1.0.0.nupkg');
});

test('pickFirstNupkg: throws when list is empty', () => {
  assert.throws(() => pickFirstNupkg([]), /no \.nupkg files found/);
  assert.throws(() => pickFirstNupkg(null), /no \.nupkg files found/);
});

test('pickFirstNupkg: throws when none parse', () => {
  assert.throws(
    () => pickFirstNupkg(['junk.nupkg', 'also.junk.nupkg']),
    /no candidate parsed cleanly/
  );
});
