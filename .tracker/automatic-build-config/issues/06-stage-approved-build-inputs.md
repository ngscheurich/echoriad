# Stage approved build inputs

Status: needs-triage

Echoriad initially fingerprints local build inputs and invokes Gondolin against their original paths. Another process can change those inputs after approval but before Gondolin reads them.

Stage the approved build config and every referenced local input in a temporary directory. Rewrite local paths in the staged config, and invoke Gondolin only against that snapshot. Preserve Gondolin's path and file semantics. Reject the build if staging cannot reproduce an input safely.

This work is deferred from the first automatic build-config release. The initial documentation must disclose the concurrent-modification limitation.

## Comments
