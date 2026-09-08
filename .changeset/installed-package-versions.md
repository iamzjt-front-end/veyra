---
"@veyraoss/cli": patch
"@veyraoss/openai": patch
"@veyraoss/codex": patch
"@veyraoss/claude": patch
"@veyraoss/claude-code": patch
"@veyraoss/gemini": patch
"@veyraoss/opencode": patch
---

Read the CLI version, built-in plugin versions and adapter descriptor versions from their installed package manifests. Versioned packages now report their actual release version, including prerelease suffixes, instead of a hardcoded development value. Update any explicit built-in plugin version pins when upgrading the official package set.
