# Echoriad

Echoriad runs coding-agent tools inside an isolated Gondolin guest while exposing selected host files and services under explicit policy.

## Language

**Guest image**:
The bootable operating-system environment from which a guest starts.
_Avoid_: Rootfs, VM image

**Build config**:
A Gondolin-owned declaration used to produce a guest image.
_Avoid_: Package config, Echoriad build config

**Image selector**:
A reference to an existing guest image.
_Avoid_: Build config

**Build approval**:
A user's authorization for Echoriad to build one identified version of a build config and its local inputs.
_Avoid_: Project trust, image approval

**Echoriad-built image**:
A guest image Echoriad produced from a build config, identified by a fingerprint-derived image reference. The only images Echoriad lists or removes; guest images the user created outside Echoriad are never touched.
_Avoid_: Cached image, owned image
