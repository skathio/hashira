'use strict';

// The caller pins hashira as skathio/hashira/.github/workflows/static-webapp-ci.yml@<ref>.
// hashira's integration job rewrites <ref> to the commit under test, so the
// marker built from it names that commit, and the deploy job checks that the
// live site serves it.
const CALLER_REF = /skathio\/hashira\/\.github\/workflows\/static-webapp-ci\.yml@([^\s'"#]+)/;

function hashiraRef(callerText) {
  const match = CALLER_REF.exec(callerText);
  if (!match) {
    throw new Error('the caller does not call skathio/hashira/.github/workflows/static-webapp-ci.yml@<ref>');
  }
  return match[1];
}

module.exports = { hashiraRef };
