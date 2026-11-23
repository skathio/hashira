# npm flow

Copy this into `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
jobs:
  ci:
    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3
    permissions:
```

More prose.
