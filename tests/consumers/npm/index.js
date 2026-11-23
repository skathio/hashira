'use strict';

// The published surface the fixture's publish job checks after installing
// this package from the throwaway registry.
function greet(name) {
  return `hello, ${name}`;
}

module.exports = { greet };
