# Report automatic builds

Status: ready-for-agent

Blocked by: 01, 02

Extend `/echoriad` reporting for automatically built guest images.

Report the build-config path, abbreviated fingerprint, Gondolin build ID, and whether the current startup built or reused the image. Preserve the existing output for direct image selectors. Keep local input paths, authorization details, and build logs out of the command output and system prompt.

Add focused automated coverage for direct images, newly built images, reused images, unavailable VMs, and the absence of sensitive build details.

## Comments
