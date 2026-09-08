---
"@veyraoss/runtime": patch
---

Retry final macOS process-group escalation up to five times when `EPERM` races child reaping. Cleanup still requires successful signaling or an absent group and reports persistent permission errors instead of treating them as success.
