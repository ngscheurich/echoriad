# Consider gating host input inspection

Status: needs-triage

Echoriad initially reads and hashes every declared local build input before requesting build approval. A project-controlled build config can therefore cause expensive or unwanted host filesystem traversal before the user sees a prompt. For example, `postBuild.copy.src` can name a home directory, filesystem root, or network mount.

This is a theoretical denial-of-service and host-I/O concern. Fingerprinting must not expose file contents or hashes to the guest, and it must reject special filesystem nodes.

If this becomes a practical problem, add a preflight step that resolves and displays declared paths before reading them. The user can then authorize input inspection separately from the subsequent fingerprint-specific build approval. Avoid adding this second permission step without evidence that it is needed.

## Comments
