# npm flow

Copy this into `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
jobs:
  ci:
    uses: skathio/hashira/.github/workflows/npm-package-cx.yml@v3
    permissions:
      contents: read # check out the repository
```

More prose.
