# hashira

Intro.

## npm

The caller:

```yaml
name: ci
on:
  pull_request:
jobs:
  ci:
    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3
    permissions:
      contents: read # check out the repository
```
